---
name: pi-link-review-loop
description: Minimal implement→review→fix→commit loop across PI terminals over pi-link. For the ORCHESTRATOR — hold the goal, hand work to an implementer, get every change reviewed by an independent reviewer, relay findings until approved, then have a committer commit it. Leaves how to build, verify and review to the models. Requires pi-link-tools for transport.
---

# Review loop

Even a capable model cannot see its own blind spots; an independent reviewer
has different ones. This skill is the smallest structure that keeps that loop
working: direction, review, convergence. Everything else is judgment.

Read **pi-link-tools** first for how messages, callbacks and remote compaction
actually behave.

## Roles

Roles limit what each may act on and own, not what it may think about.

- **Orchestrator** (you): understands the goal, keeps it, splits it into tasks if
  needed, shows the user the task split before the first TASK, and decides when
  the goal, not only each task, is done. Does not implement, and does not own
  the verdict on the code; reading it to judge the goal is fine. That is what
  makes the other roles independent, and what keeps your context free for the
  whole goal.
- **Implementer**: does the task with its own judgment and verifies its own work.
  Does not stage or commit.
- **Reviewer**: a different terminal from the implementer. Reads the actual change,
  read-only, and judges it against the goal, the project's principles and
  quality: a change can match the task and still miss the goal.
- **Committer**: commits exactly the approved change, by
  explicit paths, and reports the hash. Blocks rather than cleans if the worktree
  or index is not what it expected. Separate from the reviewer so the commit is
  a check, not a formality.

## The loop

```
TASK      → implementer   goal, why, boundaries, where, what "done" looks like
DONE      ← implementer   what changed, how it was verified, decisions affecting
                          goal, scope or behavior (or BLOCKED: what is missing)
REVIEW    → reviewer      the goal, where to see the change, the DONE report verbatim
APPROVE   ← reviewer      or CHANGES: concrete findings (what, where, why, how to fix)
FIX       → implementer   the findings verbatim, your dissent alongside if any;
                          then REVIEW again
COMMIT    → committer     paths, branch, message; the hash goes to your task list
COMMITTED ← committer     or BLOCKED: what the worktree looked like
```

Each message ends your turn; you resume when the reply arrives. Replies carry the
task id and reach you by `link_send`. Each task is one coherent, reviewable
change. Commit a task before starting the next: this loop does not track which
uncommitted change belongs to which task.

Example TASK:

```
TASK add-retry — repo C:/work/api, branch main
Goal: HTTP client retries idempotent requests on 502/503/504, up to 3 times,
      exponential backoff. Non-idempotent requests must never retry.
Why: flaky upstream during deploys; callers currently fail on the first 503.
Boundaries: src/http/client.ts and its tests only; no new dependencies.
Done when: existing tests pass, new tests cover retry and the no-retry case.
Do not stage or commit.
Send "add-retry DONE" (what changed, how verified, decisions affecting goal,
scope or behavior) or "add-retry BLOCKED" via link_send to designer@pi-link.
```

## What makes it work

- **The reviewer reads the change, not the summary.** Give it the diff command
  and name new files; `git diff` does not show untracked ones.
- **Unverified is not done.** The implementer says how it verified; the reviewer
  checks that the verification actually exercises the change.
- **Bounded convergence.** Two fix rounds usually suffice. A round that brings
  no new information is not converging: then the disagreement belongs to the
  user; bring both positions and your recommendation.
- **Compaction can come at any time,** yours or a worker's. Keep the goal, the
  task list and what is pending in a small file, and do not repeat a step just
  because a summary lost its callback. Check a worker's context (`link_list`)
  before a task and compact it then, not mid-task.

## Outside the loop

- Pushing, amending, version bumps and lockfile changes: only if the user says so.
- Anything beyond the stated goal goes back to the user, not into a task.
