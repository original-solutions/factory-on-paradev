# Weight

Load when S/M/L is uncertain. Default **M**.

## S — mechanical

All of these hold:

- 1–2 files, or a generated/lockfile set
- No behavior change (formatter, typo, comment, dep bump, generated artifact)
- You could explain the whole change in one sentence
- Not auth, payments, schema, secrets, or prod

Examples: prettier on one file; `package-lock.json` bump; fix a typo in a comment.

## M — default, dark

Behavior change, one approach, bounded files. Five-line contract, then act. Review↔Make cycle.

Examples: add a validation branch + test; fix a failing spec; wire an existing helper.

## L — risk

Auth, payments, schema/migrations, secrets, prod deploy. Build it, name the `risk:` on the receipt, and let the factory's autonomy rules decide what happens to the PR.

## Not buildable as written → stop `needs-info`

- WHAT or HOW is a real product choice the issue and its instructor comments do not settle
- Two+ independent file sets in one issue: ask for it to be split into issues, and name the split
- "I don't know what to build"

## Borders

| Looks like | Is |
|---|---|
| One-line API change with callers | **M** (behavior) |
| Rename across 20 files, no behavior | **S** if purely mechanical identifiers; **M** if public API |
| "Add settings page" with no design | stop `needs-info` |
| Two packages, overlapping files | **M** serial, not split |
| Two packages, disjoint files | stop `needs-info`, ask for a split |

When in doubt: **M**. S that was M ships bugs.
