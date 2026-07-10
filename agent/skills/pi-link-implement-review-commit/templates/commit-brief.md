# Commit brief — worked example (committer)

Send via `link_send(to: <committer>, triggerTurn: true)`. This is the most
dangerous dispatch in the pipeline: the committer commits **another terminal's**
uncommitted work in a worktree that routinely carries unrelated dirty/untracked
files from other agents and the user. The committer checks scope and hygiene,
not correctness — never re-review (SKILL.md §3.9).

```
COMMIT TASK — <task id / pass name>, approved for commit.

Repo: <repo root>   · expected branch: <branch>
First command (always, before anything else):
  git -C <repo root> status --short --branch

Commit ONLY these paths (relative to root):
  - <path 1>
  - <path 2>
Deletions expected: <yes/no> · Untracked files in scope: <none | list them>

Inspect before staging:
  git -C <repo root> diff -- <paths>
  git -C <repo root> diff --cached -- <paths>
  git -C <repo root> diff --cached --name-status   # pre-staged junk detection — must be empty or in-scope

Prior facts:
  - Task/findings: <ids>
  - Review: APPROVE by <reviewer> (<iterations, if any>)
  - Gate: <build result>, <tests N/N>

Commit message:
  <exact subject line>
  <body bullets — or: compose from `<type>(<scope>)` + the prior facts above>

Exclusions: no version bumps, lockfiles, or package manifests unless listed
above; do not stage or commit unrelated dirty/untracked files.

Operating rules:
  - Explicit pathspecs only: git add <path> <path>. Never git add . / -A /
    commit -a — the worktree is shared.
  - Scope and hygiene only: verify the staged diff matches the path list;
    correctness was settled at review — do not re-review.
  - Proceed when out-of-scope changes are clearly unrelated AND unstaged —
    leave them in place, report them as leftovers in your DONE.
  - BLOCK on any of: staged out-of-scope changes · a listed path needing
    partial staging (unless this brief authorizes exact hunks) · wrong
    branch / detached HEAD / merge-rebase in progress · a listed path
    missing or renamed · hooks mutating files (say whether the commit
    landed) · broad line-ending churn beyond the listed paths.

Report DONE to <orchestrator> via link_send(triggerTurn:true) with:
  - commit hash
  - paths actually committed (must equal the list above)
  - post-commit `git status --short` (leftover dirty state)
  - anything suspicious you noticed
Or BLOCKED + the rule that fired; on commit failure include the exact stderr.
```

## Note on the operating rules

The rules live INSIDE the fenced brief, not here: the committer never sees
this file, only the dispatch (SKILL.md §3.2 — self-contained dispatch).
Never send the brief with the rules trimmed out.

## Why each part

- **Status pre-check first**: the committer must see the worktree's real state
  (branch, staged junk, dirt) before touching anything.
- **Explicit path list**: the single guard against sweeping other agents' work
  into someone else's commit.
- **`--cached --name-status`**: catches junk staged _before_ this dispatch —
  the one hazard `git add <paths>` can't protect against.
- **Prior facts**: the message composes from them, and the reported hash feeds
  the ledger and the next dispatch's `GO — <prior task> committed (<hash>)` line.
- **Post-commit status in the report**: leftovers stay visible to the
  orchestrator and user instead of silently accumulating.
- **Scope-not-correctness**: a committer that re-litigates review adds a second,
  unaccountable review loop (§3.9).
