# P0 results

CLI version: 2.0.8 (schema) | App version: 2.0.8 | Skill SHA: rawphp/factory@7be6029 | Dates: 2026-11-10, 2026-11-11 (UTC)

Spike repo: original-solutions/factory-paradev-spike

Fixtures: `spike/fixtures/2.0.8/`. The installed CLI was 2.0.8, so they are recorded under that version, not 2.0.7.

Redacted before commit, because this repo is public (shape, keys, row counts and chunk counts are unchanged):
- `agents-read-local.json`, `agents-read-local-after-gate.json`: the body of the User chunk where Claude Code expanded the private `/factory` SKILL.md is a one-line placeholder giving its length.
- `agents-read-local-killed.json`, `agents-read-local-resume.json` (2026-11-11): the same User chunk, redacted the same way.
- `projects-list-local.json`: projects other than the spike's have placeholder `name`, `repo`, `path` and `id`.
- `ws-list-noflag.json`, `ws-list-local.json`: workspaces other than the spike's have placeholder `id`, `name`, `branch`, `worktreePath`, `projectId`, `projectName`, `url` and `webUrl`.

## Steps

| Step | Local | Host | Cloud |
|---|---|---|---|
| 1 Create + agent | pass, ws-create-local, branch fac/1-1 | | |
| 2 Wait settled | pass, agents-wait-local, idle after 273s | | |
| 3 Result line | pass, agents-read-local, FACTORY-DONE: https://github.com/original-solutions/factory-paradev-spike/pull/7 | | |
| 4 Gate failure sent back | pass (read by hand), agents-read-local-after-gate, FACTORY-DONE: https://github.com/original-solutions/factory-paradev-spike/pull/7. The driver wrote fail: the gate text arrived as one User chunk, wrapped in `<pasted_content id="…">`, but the reply was two Assistant chunks, and the driver only checks the chunk just before the last one. The agent could not reproduce the fake failure, committed nothing and said so. | | |
| 5 Interrupt | L5b (2026-11-11), a dead agent instead of "Quit Paradev Completely", which would also have killed the Paradev terminal recording it: on `fac #2 subtract` (issue 2, branch fac/2-1), working, `kill -9` of the `claude` process only. At most 39 s later (the snapshot just before the kill, snapshot-local-before-kill, was 38.5 s before the explain; the last hook was 41 s old) `agents explain` still said `working`, `lastEventType: Start`, and kept saying it after the resume finished. The terminal stayed live (`exited: false`) at a shell prompt after `killed 'claude'`. The session id is the newest `~/.claude/projects/<worktree path with / and . as ->/*.jsonl`, its file name equal to the `sessionId` inside it. `agents create --resume-session <id> --prompt …` opened a new terminal (58426e6d…), restored the conversation (a `Assistant: No response requested.` chunk marks the restore), delivered the prompt, and the agent finished: FACTORY-DONE: https://github.com/original-solutions/factory-paradev-spike/pull/10 (closed after). `terminals close` on the dead terminal set `status: disposed` and cleared its agent from `snapshot`. Fixtures: ws-create-local-2, agents-wait-local-2-working, snapshot-local-before-kill, agents-explain-local-killed, snapshot-local-killed, terminals-list-local-killed, terminals-read-local-killed, agents-read-local-killed, agents-create-local-resume, agents-wait-local-resume-working, agents-wait-local-resume, agents-read-local-resume, agents-explain-local-killed-after-resume, snapshot-local-after-resume, terminals-close-local-killed, snapshot-local-after-close. L5a: Cmd+Q does not stop the agent. On `fac #4 stats retry` (issue 4, branch fac/4-2), working: Cmd+Q quit with no dialog. The app and its host-service exited, but terminals live in a separate `pty-daemon` process that stayed up, so the agent kept working. While the app was closed, explain and snapshot exited 1 with `Error: Host service for this machine isn't running` (Hint: `superset start`). After reopening: same terminal id, `state: working`, no restart ("the session started 2 minutes ago"); snapshot shows the workspace with its agent `working`. Done twice: the first quit's closed-app answers were lost (that script run did not survive), the second recorded them. The first L5a attempt (fac/4-1, ws-create-local-4) was stopped before the quit; that agent finished and opened PR #8. | | |

## Probes

| Probe | Result | Fixtures |
|---|---|---|
| X1 Terminal id after create | `.agents[0].sessionId` from create is the terminal id: it equals `terminalId` in explain, wait, send and read. `.terminals` is `[]` when only an agent is started. | ws-create-local, agents-wait-local |
| X2 Clean stop against an API error | not run | |
| X3 Gate exit-code sentinel | not run | |
| X4 Belt payload in page storage | Published `--visibility just_me` only with `--workspace` (without one: `Error: Not logged in`, see Errors). The page showed "No belt in shared storage yet", then showed the 40 KiB belt live, "after subscribe", with no reload. The 70 KiB write failed: `Error: A stored value is at most 65536 bytes`. | pages-publish-probe, pages-publish-probe-ws, pages-storage-set-belt, pages-storage-get-belt, pages-storage-set-belt-oversize |
| X5 Schema and version | version 2.0.8 | schema.json |
| X6 Default target with no flag | before C0: no flag exit 0, 7 rows; --local exit 0, 7 rows; the two answers are identical | ws-list-noflag, ws-list-local |
| X7 Second create on the same branch | alreadyExists: true, same workspace id, but a second agent started in a new terminal: 37e8b1b1-6018-4b44-ad46-92594591174b (closed, `status: disposed`). A repeat create is not safe to retry. | ws-create-local-repeat, terminals-close-local-repeat |
| X8 Base from origin | No fetch. `--base-branch x8-origin-only`, a branch whose only commit (d6900db) was on origin and not in the clone, gave exit 0, empty stderr, and a worktree on `main` (7075a29). It falls back to the project default without saying so. | ws-create-local-x8, ws-get-local-x8 |
| X9 GitHub identity of a local and a host agent | Local: the draft PR was opened as `tomkaczocha`, the active `gh` account. Its commits use the worktree's git `user.email`, which GitHub shows as `rawphp`. Host: not run. | |
| X10 Archive | `workspaces archive <4 ids> --local`: exit 0, `{deleted: [all 4], notFound: [], failed: [], warnings: []}`. Archiving the same id again also lists it under `deleted`. After archive, `workspaces get`, `agents explain` and `agents read` exit 1 with `Workspace not found on host <host id>: <workspace id>`. The answer says `deleted`, not archived. The worktree folders are removed, the local branches (fac/1-1, fac/4-1, fac/4-2, fac/x8) are kept, and the workspaces no longer appear in `workspaces list`. | ws-archive-local, ws-archive-local-2, ws-archive-local-again, ws-get-local-archived, agents-explain-local-archived, agents-read-local-archived |
| X11 Usage limit | not run | |

## Observed values

- lastEventType values seen: Start, Stop
- explain states seen: none, idle. Both the "starting" and the "working" explain right after create said `none` ("No agent in this terminal."): the agent had not sent its first hook yet. `agents wait --until working` did see `working`.
- cloud workspace status values seen:
- Run time per location, create to first result line: local: 277s
- Worktree folder pattern (local, host): local: `~/.paradev/worktrees/<project>/<branch>`
- Branch Paradev gave the cloud workspace:
- User: chunks per /factory prompt: 2 (the `/factory` command, then the expanded SKILL.md)
- Text after the last Assistant: chunk: none
- Agent session id: where found, and whether --resume-session worked: not in any answer. `.agents[].sessionId` is the terminal id (X1). On disk it is the newest `~/.claude/projects/<worktree path with / and . as ->/*.jsonl`. `--resume-session` with `--prompt` worked (L5b).
- Agent presets (`agents list --local`, agents-list-local): `claude` runs `claude --dangerously-skip-permissions`, `promptTransport: argv`, `resumeArgs: ["--resume"]`. The list has no model ids; `agents create --model` is "agent-specific; omit to use the agent default".
- A dead agent: `agents explain` keeps the last hook's state, so a killed agent stays `working` (L5b).
- GitHub login of the agent (local, host, cloud): local: PR `tomkaczocha`, commits `rawphp`
- CLI auth outside Paradev: in a Paradev terminal `auth whoami` says `authSource: host`. In Terminal.app every call failed with `Error: Not logged in` until `superset auth login`, after which `authSource: oauth`. A runner started outside the app needs its own login or `SUPERSET_API_KEY`.

## Errors, verbatim

| Command | Situation | stderr |
|---|---|---|
| `superset pages publish spike/belt-probe --title "Factory belt probe" --visibility just_me --no-watch --json` | pages-publish-probe, run with `SUPERSET_WORKSPACE_ID` unset and no `--workspace` | Error: Not logged in<br>Hint: Run: superset auth login (or set SUPERSET_API_KEY) |
| `superset pages storage <page> --key belt --scope shared --set <70 KiB> --json` | pages-storage-set-belt-oversize | Error: A stored value is at most 65536 bytes |
| `superset agents explain --local --workspace <ws> --terminal <term> --json` | agents-explain-local-appquit, Paradev app quit with Cmd+Q | Error: Host service for this machine isn't running<br>Hint: Run: superset start |
| `superset snapshot --workspace <ws> --json` | snapshot-local-appquit, Paradev app quit with Cmd+Q | Error: Host service for this machine isn't running<br>Hint: Run: superset start |
| `superset workspaces create --local --project <id> --name "fac #4 stats" … --json` | ws-create-local-4-nologin, from Terminal.app before `auth login` | Error: Not logged in<br>Hint: Run: superset auth login (or set SUPERSET_API_KEY) |
| `superset workspaces get <ws> --local --json`, and the same from `agents explain` and `agents read` | ws-get-local-archived, agents-explain-local-archived, agents-read-local-archived, after `workspaces archive` | Error: Workspace not found on host <host id>: <ws><br>Hint: Pass --host <id> if it lives on another machine |
