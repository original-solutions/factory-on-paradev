# CLI 2.0.11 fixtures

Paradev CLI 2.0.11 renamed two cloud workspace statuses. A booted workspace reads `awake` (2.0.8: `ready`), a slept one `asleep`, and an archived one `archived` (2.0.8: `deleted`).

- `ws-get-cloud-archived` was recorded on 2026-11-22 from people-hub #901's cloud workspace, after the runner archived it.
- `ws-get-cloud-awake` is that same record with `status` set to `awake` and `archivedAt` set to `null`. Each workspace that day went `provisioning` → `awake` in about 16 s, but its `awake` answer was not recorded before it was archived. Its meta has no `startedAt` or `durationMs` for that reason.
- `ws-get-cloud-gone` was recorded on 2026-11-24 for an id the active organization has no workspace for (all zeros): exit 1, `Error: No cloud workspace <id> in this organization`. The answer is scoped to the CLI's active organization, so a CLI switched to another one gives it for a live workspace too: the runner reads it as a failed read, which marks no record archived (#113). What 2.0.11 answers for a once-real workspace after it is deleted is not recorded, so no failed `get` counts a cloud workspace as gone: only a status of `archived` or `deleted` does. It has no stdout file, as a failed call has none.

The tests reach these through `readFixture("../2.0.11/<name>")`, since `FIXTURES_DIR` is the 2.0.8 directory.
