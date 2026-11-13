# Contract

Load at step 3.

Copy the issue body. Do not improve it.

## S

One sentence: what changes, which files.

## M and L

Five lines in the session, then implement. Do not write a file.

```text
done: <observable outcome>
out: <what is not in this issue>
risk: <none | auth | data | api | …>
test: <command>
files: <paths>
```

`done:` covers every acceptance criterion on the issue. If the issue has none and the outcome is still unambiguous, derive them and list them here. If it is ambiguous → stop `needs-info`.

Optional `settled:` lines from instructor comments. Later Check/Make must not invert them.

`test:` must be able to fail `done`. For client-rendered UI, point it at a test that mounts or renders the changed UI, not an HTTP shell/component-name assertion that stays green when the copy is gutted.

Contract change mid-run (a forwarded comment or an edited body): never send it into a running worker — mid-turn text arrives beside a tool result and a careful worker rightly refuses it. Write it into the next packet (Check-fix or a `-change` packet), say whose decision it is and that it overrides the earlier line, and send the pointer only when the worker is idle.
