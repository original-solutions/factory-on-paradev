import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { AttentionItem } from "../attention.ts";
import type { Attention } from "../attention.ts";
import type { HostConfig, MachineConfig } from "../config.ts";
import {
  checkHost,
  checkHostsAtReload,
  firstFailure,
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
  PROXY_ENV_READ,
  remoteUrl,
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

  it("ssh: names the key to install and says why it failed; later ssh lines are not checked", async () => {
    const w = world();
    w.ssh.set(TRUE_COMMAND, failed("Permission denied (publickey).\n"));
    const lines = await run(w);
    assert.strictEqual(
      byCheck(lines, "ssh").text,
      "install this Mac's ssh key on the host: ssh-copy-id me@mini (ssh -o BatchMode=yes me@mini true failed: exit 1: Permission denied (publickey).)",
    );
    for (const check of ["clone acme/app", "trusted acme/app", "proxy env", "git identity", "gh", "claude"]) {
      const line = byCheck(lines, check);
      assert.deepStrictEqual([line.ok, line.text], [false, "not checked: ssh failed"], check);
    }
    assert.strictEqual(byCheck(lines, "online").text, "ok");
    assert.strictEqual(byCheck(lines, "project acme/app").text, "ok");
    assert.deepStrictEqual(w.commands, [TRUE_COMMAND]);
  });

  it("cli: a projects list that fails gets the online fix, and project lines are not checked", async () => {
    const w = world();
    w.superset.set("projects list --host h1", new Error("PARADEV_OFFLINE"));
    const lines = await run(w);
    assert.strictEqual(
      byCheck(lines, "cli").text,
      "add it with superset hosts add me@mini --name mini, or start its host service (sh.superset.host)",
    );
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
    assert.strictEqual(
      byCheck(lines, "trusted acme/app").text,
      `open Claude Code once in ${PATH} on the host and accept the trust dialog, or set projects["${PATH}"].hasTrustDialogAccepted to true in the host's ~/.claude.json`,
    );
    assert.include(w.commands, trustRead(PATH));
    assert.include(trustRead(PATH), "python3 -c");
    assert.include(trustRead(PATH), ".claude.json");
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

  it("checks a repo only when it lists the host", async () => {
    const lines = await run(world(), machineOf([HOST], []));
    assert.deepStrictEqual(
      lines.map((l) => l.check),
      ["online", "ssh", "cli", "proxy env", "git identity", "gh", "claude"],
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
        "host mini is not ready: gh: gh auth login on the host; it takes no run until a config reload passes factory-runner hosts check mini",
    });
  });
});

/** The attention service as the pass keeps it: one item per id. */
const attentionFake = () => {
  const items: Array<AttentionItem> = [];
  const raised: Array<string> = [];
  const attention: Pick<Attention["Service"], "raise" | "clear"> = {
    raise: (item) =>
      Effect.sync(() => {
        raised.push(item.id);
        if (!items.some((open) => open.id === item.id)) items.push({ ...item, firstSeenMs: 0 });
      }),
    clear: (matches) =>
      Effect.sync(() => {
        for (let i = items.length - 1; i >= 0; i--) if (matches(items[i]!)) items.splice(i, 1);
      }),
  };
  return { items, raised, attention };
};

describe("checkHostsAtReload", () => {
  it("raises one item for a failing host, fills notReady, and clears when the host passes", async () => {
    const w = world();
    w.ssh.set(GH_AUTH_STATUS, failed());
    const fake = attentionFake();
    const notReady = new Map<string, string>();
    await Effect.runPromise(checkHostsAtReload(w.io, machineOf([HOST]), fake.attention, notReady));
    assert.deepStrictEqual([...notReady], [["h1", "gh: gh auth login on the host"]]);
    assert.deepStrictEqual(fake.items.map((i) => i.id), ["host-not-ready:h1"]);
    assert.include(fake.items[0]!.message, "gh: gh auth login on the host");

    w.ssh.set(GH_AUTH_STATUS, ok());
    await Effect.runPromise(checkHostsAtReload(w.io, machineOf([HOST]), fake.attention, notReady));
    assert.strictEqual(notReady.size, 0);
    assert.deepStrictEqual(fake.items, []);
  });

  it("a changed first failing line replaces the open item", async () => {
    const w = world();
    w.ssh.set(GH_AUTH_STATUS, failed());
    const fake = attentionFake();
    const notReady = new Map<string, string>();
    await Effect.runPromise(checkHostsAtReload(w.io, machineOf([HOST]), fake.attention, notReady));
    w.ssh.set(GIT_EMAIL, ok(""));
    await Effect.runPromise(checkHostsAtReload(w.io, machineOf([HOST]), fake.attention, notReady));
    assert.strictEqual(fake.items.length, 1);
    assert.include(fake.items[0]!.message, "git identity:");
    assert.include(notReady.get("h1")!, "git identity:");
  });

  it("clears the item of a host that left the config, and checks no host when there is none", async () => {
    const w = world();
    w.ssh.set(GH_AUTH_STATUS, failed());
    const fake = attentionFake();
    const notReady = new Map<string, string>();
    await Effect.runPromise(checkHostsAtReload(w.io, machineOf([HOST]), fake.attention, notReady));
    w.commands.length = 0;
    await Effect.runPromise(checkHostsAtReload(w.io, machineOf([]), fake.attention, notReady));
    assert.deepStrictEqual(fake.items, []);
    assert.strictEqual(notReady.size, 0);
    assert.deepStrictEqual(w.commands, []);
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
      () => ({ status: 1, stdout: "", stderr: "noise\nError: PARADEV_OFFLINE: not running\n" }),
      "superset",
    );
    assert.strictEqual(
      await Effect.runPromise(Effect.flip(failing.superset(["hosts", "list"]))),
      "PARADEV_OFFLINE: not running",
    );
    const silent = hostCheckIoFromCommands(() => ({ status: 3, stdout: "", stderr: "" }), "superset");
    assert.strictEqual(await Effect.runPromise(Effect.flip(silent.superset(["x"]))), "exit 3");
    const garbage = hostCheckIoFromCommands(() => ({ status: 0, stdout: "not json", stderr: "" }), "superset");
    assert.isString(await Effect.runPromise(Effect.flip(garbage.superset(["x"]))));
  });

  it("reads ssh through the same runner", async () => {
    const io = hostCheckIoFromCommands((command, args) => ({ status: 0, stdout: `${command} ${args.at(-1)}`, stderr: "" }), "superset");
    const done = await Effect.runPromise(io.ssh(["-o", "x", "me@h", "true"], 10_000));
    assert.strictEqual(done.stdout, "ssh true");
  });
});
