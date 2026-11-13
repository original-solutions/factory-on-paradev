#!/bin/bash
# One-off record of the host spike (issue 8) on 2026-11-13 UTC: the ids are the Trilogy Mac host and its spike project.
# Kept as the host counterpart of run-local.ts; it is not reusable as is.
# Host spike on issue 5: H1 create, H5 host service stopped while working, resume if needed, H2-H4.
set -u
H=c9c39956e0c1756e30d6bb9f4f907ff1; PID=380b9715-2ff5-4d8b-8e97-616b218ae450
P=/Users/tomkaczocha/factory-runner/original-solutions/factory-paradev-spike
export SUPERSET=/Users/tomkaczocha/.paradev/bin/superset FIX=spike/fixtures/2.0.8
S=$SUPERSET; BOX="ssh -o BatchMode=yes tomk@trilogy-mac"
rec() { node spike/rec.ts "$@"; }
show() { jq -c "$2" "$FIX/$1.json" 2>/dev/null; jq -c '{exit,durationMs,stderr}' "$FIX/$1.meta.json"; }
source spike/ids.env

echo '=== archive issue 11 workspace'; rec ws-archive-host-11 workspaces archive "$WS_P" --host $H; show ws-archive-host-11 .

echo '=== H1 issue 5'; PROMPT="$(cat "$P/prompts/5.txt")"
rec ws-create-host-5 workspaces create --host $H --project $PID --name "fac #5 clamp" --branch fac/5-1 --skip-branch-prefix --base-branch main --tag factory --agent claude --prompt "$PROMPT"
show ws-create-host-5 '{ws:.workspace.id,branch:.workspace.branch,agents,alreadyExists}'
WS=$(jq -r .workspace.id $FIX/ws-create-host-5.json); T=$(jq -r '.agents[0].sessionId' $FIX/ws-create-host-5.json)
printf 'export WS_5=%s\nexport TERM_5=%s\n' "$WS" "$T" >> spike/ids.env
ON=(--host $H --workspace "$WS" --terminal "$T")
rec agents-wait-host-5-working agents wait "${ON[@]}" --until working --timeout 300; show agents-wait-host-5-working .
sleep 20
rec agents-explain-host-5-working agents explain "${ON[@]}"; show agents-explain-host-5-working '{state,lastEventType}'

echo '=== H5: stop the host service while the agent works'
$BOX 'launchctl bootout gui/$(id -u)/sh.superset.host && echo "service stopped"; sleep 3; echo "claude procs: $(pgrep -f "claude --dangerously" | wc -l | tr -d " ")"; pgrep -fl "pty-daemon|superset" | grep -v pgrep | cut -c1-100'
sleep 10
rec hosts-list-host-offline hosts list; show hosts-list-host-offline '[.[]|select(.name=="trilogy-mac")]'
rec agents-explain-host-offline agents explain "${ON[@]}"; show agents-explain-host-offline '{state,lastEventType,headline}'
rec snapshot-host-offline snapshot --host $H --workspace "$WS"; show snapshot-host-offline '.'
rec ws-get-host-offline workspaces get "$WS" --host $H; show ws-get-host-offline '{worktreeExists,branch}'
sleep 20
$BOX 'echo "claude procs while service is down: $(pgrep -f "claude --dangerously" | wc -l | tr -d " ")"'

echo '=== restart the host service'
$BOX 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.superset.host.plist && echo "service started"'
for i in $(seq 1 24); do sleep 5; ONLINE=$($S hosts list --json 2>/dev/null | jq -r '.[]|select(.name=="trilogy-mac")|.online'); [ "$ONLINE" = "yes" ] && { echo "online after $((i*5))s"; break; }; done
rec hosts-list-host-online hosts list; show hosts-list-host-online '[.[]|select(.name=="trilogy-mac")]'
rec agents-explain-host-after-restart agents explain "${ON[@]}"; show agents-explain-host-after-restart '{state,lastEventType,headline,details}'
rec snapshot-host-after-restart snapshot --host $H --workspace "$WS"; show snapshot-host-after-restart '.'
rec terminals-list-host-after-restart terminals list --host $H --workspace "$WS"; show terminals-list-host-after-restart '.'
ALIVE=$($BOX 'pgrep -f "claude --dangerously" | wc -l | tr -d " "'); echo "claude procs after restart: $ALIVE"

if [ "$ALIVE" = "0" ]; then
  echo '=== agent died: resume'
  SID=$($BOX 'ls -t ~/.claude/projects/-Users-tomk--paradev-worktrees-factory-paradev-spike-fac-5-1/*.jsonl | head -1 | xargs basename' | sed 's/\.jsonl//'); echo "SID=$SID"; echo "export SID_5=$SID" >> spike/ids.env
  rec terminals-close-host-5-dead terminals close "${ON[@]}"; show terminals-close-host-5-dead .
  rec agents-create-host-5-resume agents create --host $H --workspace "$WS" --agent claude --resume-session "$SID" --prompt "The session was interrupted. Continue from where you were and end with a result line as before."; show agents-create-host-5-resume .
  T=$(jq -r .sessionId $FIX/agents-create-host-5-resume.json); echo "export TERM_5R=$T" >> spike/ids.env; ON=(--host $H --workspace "$WS" --terminal "$T")
  rec agents-wait-host-5-resume-working agents wait "${ON[@]}" --until working --timeout 300; show agents-wait-host-5-resume-working .
fi

echo '=== H2/H3'
rec agents-wait-host-5 agents wait "${ON[@]}" --until settled --timeout 3600; show agents-wait-host-5 .
rec agents-explain-host-5-idle agents explain "${ON[@]}"; show agents-explain-host-5-idle '{state,lastEventType}'
rec agents-read-host-5 agents read "${ON[@]}"; jq -r '.harness, (.text | split("\n") | map(select(test("^FACTORY-"))) | .[-1])' $FIX/agents-read-host-5.json
echo "create-to-read: $(( ( $(jq .startedAt $FIX/agents-read-host-5.meta.json) + $(jq .durationMs $FIX/agents-read-host-5.meta.json) - $(jq .startedAt $FIX/ws-create-host-5.meta.json) ) / 1000 ))s"
gh pr list -R original-solutions/factory-paradev-spike --head fac/5-1 --json number,author,isDraft -q '.[]|"PR \(.number) by \(.author.login) draft=\(.isDraft)"'

echo '=== H4 gate failure'
GATE="$(cat "$P/prompts/gate-failure.txt")"
rec terminals-send-host-5 terminals send "${ON[@]}" --text "$GATE" --wait --until settled --timeout 3600; show terminals-send-host-5 .
rec agents-explain-host-5-after-gate agents explain "${ON[@]}"; show agents-explain-host-5-after-gate '{state,lastEventType}'
rec agents-read-host-5-after-gate agents read "${ON[@]}"; jq -r '(.text | split("\n") | map(select(test("^FACTORY-"))) | .[-1])' $FIX/agents-read-host-5-after-gate.json
jq -r .text $FIX/agents-read-host-5-after-gate.json | grep -c '<pasted_content'
echo '=== proxy'; $BOX 'grep gin_logger ~/.cli-proxy-api/logs/main.log | grep 100.87.249.45 | tail -2 | cut -c1-110'
echo DONE
