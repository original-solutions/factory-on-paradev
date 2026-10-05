# Commits

Load at Make, after each Check-fix cycle, and at Ship.

The branch is the audit log. Do not wait for Ship to make the first commit. Do not squash Make or Check commits.

## When

| Moment | What to commit | Type |
|---|---|---|
| Make: a slice's tests are written and failing | the test files only | `test:` |
| Make: that slice is green | the product files for that slice | `feat:` |
| Make: the issue is green and the branch has no commit yet | named files for the issue | `feat:` |
| Check or Gate: a finding changes behavior | the failing tests first as `test:`, then the change | `test:` then `fix:` |
| Check: a finding only adds tests for behavior that already works | those tests, one commit | `test:` |
| Ship: leftover named files only (format, lockfile) | those files | `style:` or `chore:` |

**S mechanical:** one commit at Ship is enough.

If Check is clean and Make already committed, Ship does not invent a catch-all commit.

Before Check starts, the branch must have at least one Make commit unless S or the issue changed no files.

After a Check-fix Make, commit **before** the next review wave. Reviewers read the tip that includes the fixes.

A `test:` commit is expected to be red. Say in the commit body what fails. Before Ship, the orchestrator runs the suite at one or more `test:` and following commit pairs and expects red then green. A slice with no red phase (docs, a test that already passes) says so on the receipt.

## How

From the worktree. Named files only. Never `git add -A` or `git add .`. Never co-author trailers. Never amend a commit that was pushed.

```bash
cd <worktree> && git status && git diff && git log -5 --oneline
git add -- <named files from this slice only>
git commit -m "$(cat <<'EOF'
<type>: <short>

Issue: #<n>
EOF
)"
```

Match the repo's existing commit style if it differs. Do not commit `.dw/` artifacts other than the tracked `config.yml`, review packets, or paths outside the contract `files:` (plus tests those files require).

## Do not

- Hold the whole issue uncommitted until Ship
- Squash review-fix commits into the Make commit
- Skip a Check-fix commit because Ship will "cover it"
