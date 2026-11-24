# CLI 2.0.11 fixtures

Paradev CLI 2.0.11 renamed two cloud workspace statuses. A booted workspace reads `awake` (2.0.8: `ready`), a slept one `asleep`, and an archived one `archived` (2.0.8: `deleted`).

- `ws-get-cloud-archived` was recorded on 2026-11-22 from people-hub #901's cloud workspace, after the runner archived it.
- `ws-get-cloud-awake` is that same record with `status` set to `awake` and `archivedAt` set to `null`. Each workspace that day went `provisioning` → `awake` in about 16 s, but its `awake` answer was not recorded before it was archived. Its meta has no `startedAt` or `durationMs` for that reason.
- `ws-get-cloud-gone` was recorded on 2026-11-24 for a cloud workspace id that does not exist (all zeros): exit 1, `Error: No cloud workspace <id> in this organization`. It is how 2.0.11 says a cloud workspace no longer exists, where a local or host workspace says `Workspace not found on host …` (#113). It has no stdout file, as a failed call has none.

The tests reach these through `readFixture("../2.0.11/<name>")`, since `FIXTURES_DIR` is the 2.0.8 directory.
