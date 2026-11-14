import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { HostConfig, MachineConfig } from "../config.ts";
import {
  checkHost,
  firstFailure,
  formatHostCheck,
  HOST_NOT_READY_PREFIX,
  hostCheckIoFromCommands,
  hostNotReadyItem,
  type CheckLine,
  type HostCheckIo,
} from "./hostsCheck.ts";
import {
  CLAUDE_VERSION,
  GH_AUTH_STATUS,
  GIT_EMAIL,
  isAllowed,
  PROXY_ENV_READ,
  remoteUrl,
  shellQuote,
  trustRead,
  TRUE_COMMAND,
  type SshAnswer,
} from "./ssh.ts";

const HOST: HostConfig = { id: "h1", name: "mini", ssh: "me@mini", maxRuns: 2, maxLoadPerCore: 1 };
const PATH = "/Users/me/app";
const SECRET = "sk-secret-value";

const machineOf = (hosts: ReadonlyArray<HostConfig>, repoHosts = [{ id: "h1", path: PATH }]): MachineConfig => ({
  ghConfigDir: "/gh",
  pollSeconds: 60,
  maxConcurrentRuns: 2,
  maxConcurrentGates: 2,
  feedbackSeconds: 600,
  notify: true,
  minFreeGib: 10,
  maxLoadPerCore: 1,
  modelFallbacks: {},
  repos: [
    { repo: "acme/app", path: "/Users/tom/app", hosts: repoHosts },
    { repo: "acme/other", path: "/Users/tom/other" },
  ],
  hosts,
  local: { maxRuns: 2 },
  paradev: { cli: "/opt/superset", agent: "claude", belt: { enabled: false, visibility: "just_me" } },
});

const ok = (stdout = ""): SshAnswer => ({ exitCode: 0, timedOut: false, stdout, stderr: "" });
const failed = (stderr = "boom"): SshAnswer => ({ exitCode: 1, timedOut: false, stdout: "", stderr });

/** A world where every check passes; a test replaces the answer of the one it breaks. */
const world = () => {
  const ssh = new Map<string, SshAnswer>([
    [TRUE_COMMAND, ok()],
    [remoteUrl(PATH), ok("https://github.com/acme/app.git\n")],
    [trustRead(PATH), ok("yes\n")],
    [PROXY_ENV_READ, ok("")],
    [GIT_EMAIL, ok("me@example.com\n")],
    [GH_AUTH_STATUS, ok("Logged in\n")],
    [CLAUDE_VERSION, ok("2.1.0\n")],
  ]);
  const superset = new Map<string, unknown | Error>([
    ["hosts list", [{ id: "h1", name: "mini", online: "yes" }]],
    ["projects list --host h1", [{ id: "p1", name: "app", path: PATH, repo: "acme/app" }]],
  ]);
  const commands: Array<string> = [];
  const supersetCalls: Array<string> = [];
  const io: HostCheckIo = {
    ssh: (args) =>
      Effect.sync(() => {
        const command = args[args.length - 1] ?? "";
        commands.push(command);
        return ssh.get(command) ?? failed(`no answer for ${command}`);
      }),
    superset: (argv) =>
      Effect.suspend(() => {
        const key = argv.join(" ");
        supersetCalls.push(key);
        const answer = superset.get(key);
        return answer instanceof Error ? Effect.fail(answer.message) : Effect.succeed(answer);
      }),
  };
  return { io, ssh, superset, commands, supersetCalls };
};

const run = (w: ReturnType<typeof world>, machine = machineOf([HOST])) =>
  Effect.runPromise(checkHost(w.io, machine, HOST));

const byCheck = (lines: ReadonlyArray<CheckLine>, check: string): CheckLine => {
  const line = lines.find((l) => l.check === check);
  assert.isDefined(line, `no line ${check} in ${JSON.stringify(lines)}`);
  return line!;
};

describe("checkHost", () => {
  it("passes every check in the spec's order when the host is ready", async () => {
    const lines = await run(world());
    assert.deepStrictEqual(
      lines.map((l) => l.check),
      [
        "online",
        "ssh",
        "cli",
        "clone acme/app",
        "project acme/app",
        "trusted acme/app",
        "proxy env",
        "git identity",
        "gh",
        "claude",
      ],
    );
    assert.isTrue(lines.every((l) => l.ok && l.text === "ok"), JSON.stringify(lines));
    assert.isNull(firstFailure(lines));
  });

  it("reads hosts list and projects list once, and sends only allowed commands", async () => {
    const w = world();
    await run(w);
    assert.deepStrictEqual(w.supersetCalls, ["hosts list", "projects list --host h1"]);
    assert.strictEqual(new Set(w.commands).size, w.commands.length);
    assert.isTrue(w.commands.every(isAllowed), JSON.stringify(w.commands));
  });

  it("online: a host that is absent or offline gets the hosts add fix", async () => {
    const fix =
      "add it with superset hosts add me@mini --name mini, or start its host service (sh.superset.host)";
    for (const rows of [[], [{ id: "h1", name: "mini", online: "no" }]]) {
      const w = world();
      w.superset.set("hosts list", rows);
      const line = byCheck(await run(w), "online");
      assert.deepStrictEqual([line.ok, line.text], [false, fix]);
    }
  });

  it("online: a hosts list that fails keeps the add-it fix as the text and puts the cause in the detail", async () => {
    const w = world();
    w.superset.set("hosts list", new Error("PARADEV_OFFLINE: not running"));
    const line = byCheck(await run(w), "online");
    assert.deepStrictEqual(
      [line.ok, line.text, line.detail],
      [
        false,
        "add it with superset hosts add me@mini --name mini, or start its host service (sh.superset.host)",
        "superset hosts list failed: PARADEV_OFFLINE: not running",
      ],
    );
  });

  it("ssh: names the key to install and says why it failed; later ssh lines are not checked", async () => {
    const w = world();
    w.ssh.set(TRUE_COMMAND, failed("Permission denied (publickey).\n"));
    const lines = await run(w);
    assert.strictEqual(byCheck(lines, "ssh").text, "install this Mac's ssh key on the host: ssh-copy-id me@mini");
    assert.strictEqual(
      byCheck(lines, "ssh").detail,
      "ssh -o BatchMode=yes me@mini true failed: exit 1: Permission denied (publickey).",
    );
    for (const check of ["clone acme/app", "trusted acme/app", "proxy env", "git identity", "gh", "claude"]) {
      const line = byCheck(lines, check);
      assert.deepStrictEqual([line.ok, line.text], [false, "not checked: ssh failed"], check);
    }
    assert.strictEqual(byCheck(lines, "online").text, "ok");
    assert.strictEqual(byCheck(lines, "project acme/app").text, "ok");
    assert.deepStrictEqual(w.commands, [TRUE_COMMAND]);
  });

  it("cli: a projects list that fails prints the add-it fix with the cause as detail, and project lines are not checked", async () => {
    const w = world();
    w.superset.set("projects list --host h1", new Error("PARADEV_OFFLINE"));
    const lines = await run(w);
    assert.strictEqual(
      byCheck(lines, "cli").text,
      "add it with superset hosts add me@mini --name mini, or start its host service (sh.superset.host)",
    );
    assert.strictEqual(byCheck(lines, "cli").detail, "superset projects list --host h1 failed: PARADEV_OFFLINE");
    assert.deepStrictEqual(
      [byCheck(lines, "project acme/app").ok, byCheck(lines, "project acme/app").text],
      [false, "not checked: superset projects list --host failed"],
    );
  });

  it("clone: a missing clone or another origin gets the git clone fix; both URL forms of the repo pass", async () => {
    const fix = `clone it on the host: git clone https://github.com/acme/app ${PATH}`;
    for (const answer of [failed("fatal: not a git repository"), ok("https://github.com/acme/other.git\n"), ok("\n")]) {
      const w = world();
      w.ssh.set(remoteUrl(PATH), answer);
      assert.strictEqual(byCheck(await run(w), "clone acme/app").text, fix);
    }
    for (const url of [
      "https://github.com/acme/app",
      "https://github.com/acme/app.git",
      "git@github.com:acme/app.git",
      "git@github.com:acme/app",
      "https://github.com/ACME/App.git",
    ]) {
      const w = world();
      w.ssh.set(remoteUrl(PATH), ok(`${url}\n`));
      assert.strictEqual(byCheck(await run(w), "clone acme/app").text, "ok", url);
    }
  });

  it("project: no project at the path gets the projects create fix", async () => {
    const w = world();
    w.superset.set("projects list --host h1", [{ id: "p1", name: "x", path: "/elsewhere" }]);
    assert.strictEqual(
      byCheck(await run(w), "project acme/app").text,
      `superset projects create --host h1 --name app --import ${PATH}`,
    );
  });

  it("trusted: a no answer from the python3 read of ~/.claude.json gets the trust fix", async () => {
    const w = world();
    w.ssh.set(trustRead(PATH), ok("no\n"));
    const lines = await run(w);
    const oneLiner =
      "python3 -c 'import json,os,sys;f=os.path.expanduser(\"~/.claude.json\");d=json.load(open(f));" +
      'd.setdefault(\"projects\",{}).setdefault(sys.argv[1],{})[\"hasTrustDialogAccepted\"]=True;' +
      `json.dump(d,open(f,\"w\"),indent=2)' ${shellQuote(PATH)}`;
    assert.strictEqual(
      byCheck(lines, "trusted acme/app").text,
      `open Claude Code once in ${PATH} on the host and accept the trust dialog, or run this on the host: ${oneLiner}`,
    );
    assert.include(w.commands, trustRead(PATH));
    assert.isFalse(w.commands.includes(oneLiner), "the fix is printed, never sent");
  });

  it("trusted: a trust read that fails over ssh gets the same fix", async () => {
    const w = world();
    w.ssh.set(trustRead(PATH), failed("python3: command not found"));
    const line = byCheck(await run(w), "trusted acme/app");
    assert.isFalse(line.ok);
    assert.include(line.text, "accept the trust dialog");
  });

  it("proxy env: names the missing keys, and never prints what the host answered", async () => {
    const both = "add ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN to env in ~/.claude/settings.json on the host";
    const w = world();
    w.ssh.set(PROXY_ENV_READ, ok("ANTHROPIC_AUTH_TOKEN\n"));
    assert.strictEqual(
      byCheck(await run(w), "proxy env").text,
      "add ANTHROPIC_AUTH_TOKEN to env in ~/.claude/settings.json on the host",
    );
    w.ssh.set(PROXY_ENV_READ, ok("ANTHROPIC_BASE_URL\nANTHROPIC_AUTH_TOKEN\n"));
    assert.strictEqual(byCheck(await run(w), "proxy env").text, both);
    for (const answer of [ok(SECRET), ok(`ANTHROPIC_AUTH_TOKEN\n${SECRET}\n`), failed(`bad: ${SECRET}`)]) {
      w.ssh.set(PROXY_ENV_READ, answer);
      const lines = await run(w);
      assert.strictEqual(byCheck(lines, "proxy env").text, both);
      assert.notInclude(JSON.stringify(lines), SECRET);
    }
  });

  it("git identity, gh and claude each print their fix", async () => {
    const w = world();
    w.ssh.set(GIT_EMAIL, ok("  \n"));
    w.ssh.set(GH_AUTH_STATUS, failed("You are not logged in"));
    w.ssh.set(CLAUDE_VERSION, failed("claude: command not found"));
    const lines = await run(w);
    assert.strictEqual(
      byCheck(lines, "git identity").text,
      "git config --global user.email <your GitHub email> on the host",
    );
    assert.strictEqual(byCheck(lines, "gh").text, "gh auth login on the host");
    assert.strictEqual(byCheck(lines, "claude").text, "install Claude Code on the host");
    assert.strictEqual(
      firstFailure(lines),
      "git identity: git config --global user.email <your GitHub email> on the host",
    );
  });

  it("gh and claude missing from a non-interactive ssh PATH (exit 127) say how to put them there", async () => {
    const w = world();
    w.ssh.set(GH_AUTH_STATUS, { exitCode: 127, timedOut: false, stdout: "", stderr: "zsh:1: command not found: gh\n" });
    w.ssh.set(CLAUDE_VERSION, { exitCode: 127, timedOut: false, stdout: "", stderr: "zsh:1: command not found: claude\n" });
    const lines = await run(w);
    assert.strictEqual(byCheck(lines, "gh").text, "gh auth login on the host");
    assert.strictEqual(
      byCheck(lines, "gh").detail,
      "gh is not on the PATH of a non-interactive ssh shell; add its folder (e.g. /opt/homebrew/bin or ~/.local/bin) to PATH in ~/.zshenv on the host",
    );
    assert.strictEqual(byCheck(lines, "claude").text, "install Claude Code on the host");
    assert.strictEqual(
      byCheck(lines, "claude").detail,
      "claude is not on the PATH of a non-interactive ssh shell; add its folder (e.g. /opt/homebrew/bin or ~/.local/bin) to PATH in ~/.zshenv on the host",
    );
  });

  it("checks a repo only when it lists the host", async () => {
    const lines = await run(world(), machineOf([HOST], []));
    assert.deepStrictEqual(
      lines.map((l) => l.check),
      ["online", "ssh", "cli", "proxy env", "git identity", "gh", "claude"],
    );
  });
});

describe("firstFailure", () => {
  it("leaves the detail out, so an item does not change with an error's wording", () => {
    assert.strictEqual(
      firstFailure([{ check: "ssh", ok: false, text: "the fix", detail: "exit 255: Connection refused" }]),
      "ssh: the fix",
    );
  });
});

describe("hostNotReadyItem", () => {
  it("names the host and its first failing line", () => {
    assert.deepStrictEqual(hostNotReadyItem(HOST, "gh: gh auth login on the host"), {
      id: `${HOST_NOT_READY_PREFIX}h1`,
      kind: "attention",
      repo: null,
      issue: null,
      run: null,
      message:
        "host mini is not ready: gh: gh auth login on the host; it takes no run until its check passes (checked again every 5 minutes; factory-runner hosts check mini prints every line)",
    });
  });
});

describe("formatHostCheck", () => {
  it("is the host's name and ssh, then one indented line per check", () => {
    assert.deepStrictEqual(
      formatHostCheck(HOST, [
        { check: "ssh", ok: true, text: "ok" },
        { check: "gh", ok: false, text: "gh auth login on the host" },
        { check: "cli", ok: false, text: "the fix", detail: "the cause" },
      ]),
      ["mini (me@mini)", "  ssh: ok", "  gh: gh auth login on the host", "  cli: the fix (the cause)"],
    );
  });
});

describe("hostCheckIoFromCommands", () => {
  it("runs the superset CLI with --json and answers the parsed output", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string>; timeoutMs: number }> = [];
    const io = hostCheckIoFromCommands((command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs });
      return { status: 0, stdout: '[{"id":"h1"}]', stderr: "" };
    }, "/opt/superset");
    assert.deepStrictEqual(await Effect.runPromise(io.superset(["hosts", "list"])), [{ id: "h1" }]);
    assert.deepStrictEqual(calls, [
      { command: "/opt/superset", args: ["hosts", "list", "--json"], timeoutMs: 30_000 },
    ]);
  });

  it("answers the error text of a failed call, or of output that is not JSON", async () => {
    const failing = hostCheckIoFromCommands(
      () => ({ status: 1, stdout: "", stderr: "noise\nError: PARADEV_OFFLINE: not running\nHint: open it\n" }),
      "superset",
    );
    assert.strictEqual(
      await Effect.runPromise(Effect.flip(failing.superset(["hosts", "list"]))),
      "PARADEV_OFFLINE: not running",
    );
    const silent = hostCheckIoFromCommands(() => ({ status: 3, stdout: "", stderr: "" }), "superset");
    assert.strictEqual(await Effect.runPromise(Effect.flip(silent.superset(["x"]))), "exit 3");
    const spawn = hostCheckIoFromCommands(() => ({ status: null, stdout: "", stderr: "spawnSync superset ENOENT\n" }), "superset");
    assert.strictEqual(await Effect.runPromise(Effect.flip(spawn.superset(["x"]))), "spawnSync superset ENOENT");
    const garbage = hostCheckIoFromCommands(() => ({ status: 0, stdout: "not json", stderr: "" }), "superset");
    assert.isString(await Effect.runPromise(Effect.flip(garbage.superset(["x"]))));
  });

  it("reads ssh through the same runner", async () => {
    const io = hostCheckIoFromCommands((command, args) => ({ status: 0, stdout: `${command} ${args.at(-1)}`, stderr: "" }), "superset");
    const done = await Effect.runPromise(io.ssh(["-o", "x", "me@h", "true"], 10_000));
    assert.strictEqual(done.stdout, "ssh true");
  });
});
