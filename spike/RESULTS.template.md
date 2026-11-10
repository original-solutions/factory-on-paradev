# P0 results

CLI version: {{version}} (schema) | App version: | Skill SHA: | Dates: {{date}}

Spike repo: {{repo}}

## Steps

| Step | Local | Host | Cloud |
|---|---|---|---|
| 1 Create + agent | {{step1}} | | |
| 2 Wait settled | {{step2}} | | |
| 3 Result line | {{step3}} | | |
| 4 Gate failure sent back | {{step4}} | | |
| 5 Interrupt | | | |

## Probes

| Probe | Result | Fixtures |
|---|---|---|
| X1 Terminal id after create | | |
| X2 Clean stop against an API error | | |
| X3 Gate exit-code sentinel | | |
| X4 Belt payload in page storage | | |
| X5 Schema and version | {{x5}} | {{x5-fixtures}} |
| X6 Default target with no flag | {{x6}} | {{x6-fixtures}} |
| X7 Second create on the same branch | {{x7}} | {{x7-fixtures}} |
| X8 Base from origin | | |
| X9 GitHub identity of a local and a host agent | | |
| X10 Archive | | |
| X11 Usage limit | | |

## Observed values

- lastEventType values seen: {{lastEventTypes}}
- explain states seen: {{states}}
- cloud workspace status values seen:
- Run time per location, create to first result line: {{runTime}}
- Worktree folder pattern (local, host): {{worktree}}
- Branch Paradev gave the cloud workspace:
- User: chunks per /factory prompt: {{userChunks}}
- Text after the last Assistant: chunk: {{afterAssistant}}
- Agent session id: where found, and whether --resume-session worked:
- GitHub login of the agent (local, host, cloud):

## Errors, verbatim

| Command | Situation | stderr |
|---|---|---|
{{errors}}
