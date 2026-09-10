# Commit brief — example

Scope and hygiene only; correctness belongs to the independent review.

```text
COMMIT <task-id>
GO CONFIRMED — user approved with "<quote>"; <per-task go if required>.
Repo: <absolute root>; expected branch/HEAD: <values>.
Plan: <absolute path>; standing constraints apply.
First inspect: git -C <root> status --short --branch

Commit ONLY these paths: <explicit list relative to root>.
Expected additions/deletions: <list or none>.
Expected other dirt/stage: <paths and owners; protected ledger never staged>.
Review: <reviewer + APPROVE or recorded nonblocking tie-break>.
Gate: <required evidence/results and uncovered surfaces>.
Commit message: <subject/body or precise instruction to compose>.

Before staging:
  git -C <root> diff -- <paths>
  git -C <root> diff --cached -- <paths>
  git -C <root> diff --cached --name-status
Verify HEAD/branch and scope. Read new untracked files directly when checking
scope; they are absent from git diff. Do not re-review correctness.

Rules:
- Explicit pathspecs only; never git add . / -A / commit -a.
- Leave clearly unrelated unstaged changes alone; report leftovers.
- BLOCK on out-of-scope staged changes, unexpected branch/HEAD, detached HEAD,
  merge/rebase, unauthorized partial staging, a listed path missing/renamed,
  broad line-ending churn or hooks mutating files. Do not clean others' work.
- No push/amend, skipped hooks, version/lockfile changes unless authorized.
- Verify staged scope before commit and report post-commit status.

Callback via link_send to <orchestrator>: <task-id> COMMITTED <hash>, with
committed paths, post-commit status and any suspicious state; or <task-id> BLOCKED
with exact reason/error and whether a commit nevertheless landed.
```
