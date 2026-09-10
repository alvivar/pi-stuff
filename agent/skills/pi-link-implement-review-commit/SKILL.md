---
name: pi-link-implement-review-commit
description: Orchestrate a plan-driven implement→review→commit pipeline across PI terminals over pi-link. For the ORCHESTRATOR: delegate self-contained tasks, gate each on relevant evidence and independent review, serialize commits, and compact workers predictively at safe boundaries. Not for writing code yourself or one-off messaging. Requires pi-link-coordination for transport mechanics.
---

# Implement → Review → Commit

You are the **orchestrator**. Route work, enforce gates, manage context, and keep
run state. Do not edit product code or perform its correctness review. You may
read source to understand and plan; the independent reviewer owns the verdict.
Plans and ledgers are yours to write. Commit only under the role exception below.

Load and read **pi-link-coordination first** for tool delivery, callbacks and
remote compaction. These rules govern the workflow, not the transport.

References (examples, not mandatory forms):
[plan](templates/plan-schema.md) · [dispatch](templates/dispatch-brief.md) ·
[review](templates/review-brief.md) · [commit](templates/commit-brief.md) ·
[ledger](templates/ledger.md).

## 1. Prepare and authorize the run

1. Read a self-contained plan on disk: approved outcome, tasks in order, paths,
   invariants, risks, verification and standing constraints. Repair an incomplete
   plan before delegating; group coherent changes rather than making every
   observation a task.
2. Bind roles with `link_list`, using full terminal names and verifying cwd/repo.
   Record bindings; do not start with an absent or ambiguous required role.

   | Role | Responsibility |
   | --- | --- |
   | Implementer | Edits the task, self-runs its gate |
   | Reviewer | Independently reviews the actual diff; must differ from implementer |
   | Committer | Checks scope/staging hygiene and commits; does not re-review |

   Use a separate committer by default. Only if none is available and the user
   explicitly permits it may the orchestrator perform that role.
3. Present task order and gates. Agree **run-through** (one go for the plan) or
   **gate-per-task** (also require user approval immediately before each commit).
   Record the explicit go before any execution dispatch, including baseline work.
4. Open a ledger next to the plan (`LEDGER-<plan>.md`) or at another agreed absolute
   path. It is temporary run state, never a product file and **never staged**.
5. Dispatch the implementer to verify branch/HEAD, worktree and staged state, and
   run the applicable baseline gate before edits. Unexpected staged changes or a
   red baseline block implementation: report the facts; do not clean others' work
   or silently repair the baseline.

## 2. Run one task at a time

The pipeline is **serial-only**. All worker communication routes through you;
workers do not delegate to each other.

```
PREPARE    check worker availability/context (§6); send self-contained brief
IMPLEMENT  implementer reads plan against current source before editing;
           contradictions → BLOCKED with proposed correction and affected behavior
WAIT       end your turn; resume on the named DONE/BLOCKED callback
GATE       required evidence passed? otherwise bounded repair or escalate (§5)
REVIEW     send actual diff/new-file paths and material declarations to reviewer
WAIT       end your turn; resume on APPROVE / CHANGES-NEEDED / BLOCKED
CONVERGE   relay findings, repair and re-review within §5's cap
HOLD       gate-per-task only: explain outcome/verdict and await user's commit go
COMMIT     dispatch committer; wait for hash and final worktree status
ADVANCE    record completion; assess context for next task
```

**WAIT means end your turn**, not sleep or poll. A callback may request a specific
unblock action; send an explicit continuation after resolving it. Do not send a
second work brief while waiting for the first result.

**Commit before the next IMPLEMENT.** Each review covers that task's uncommitted
changes, not a batch of tasks. Keep shared-file edits sequential; file collision
is a serialization constraint, not automatically a sensitive correctness risk.

## 3. Authority and changes during a run

Every execution dispatch carries the user's go-signal in its body. Under
run-through, the orchestrator may incorporate small, directly necessary
corrections to achieve the approved outcome, including related documentation.
They must not expand the approved external behavior or add dependencies, cost,
destructive data operations, security changes or material risk. This is not
permission for unrelated cleanup or new features in an already-approved file.

Record these amendments in the plan/ledger, update the plan's task path list
before edits and the committer's path list before dispatch, and have the reviewer
evaluate them. Commit plan amendments with their
implementation. **Changed outcomes or material risk require user ratification**;
a worker declaration alone never authorizes expansion. Outside run-through,
request approval for scope amendments before executing them.

An escalation to the user is self-contained: what was found, why a decision or
permission is needed, the proposed action and recommendation, and what is paused
or can continue. Do not make the user reconstruct worker messages.

## 4. Briefs and evidence

A dispatch names the task, absolute plan/repo paths, expected branch/HEAD, allowed
files, expected dirt and ownership (including staged state), go, gate, constraints
and callback recipient and task id. Explicitly prohibit staging/committing outside the
commit task and version/lockfile changes unless authorized.

Workers read the referenced plan and standing constraints. Do not paste the whole
plan into each brief. Highlight only the few highest-risk invariants and any
critical task-specific restrictions; preserve debugging-relevant facts.

Require a concise result: outcome, changed paths, gate results and limitations,
plus **material deviations or unpinned decisions** with rationale. Material means
observable behavior, contract/data/error semantics, scope, risk or verification
strategy that would affect review. Routine idiomatic choices and confirmations of
already-pinned requirements are not a design diary. Operational blockers belong
in the report without being relabelled design decisions.

**Relay material declarations to the reviewer verbatim.** Include the exact diff
command and explicitly name untracked files to read: `git diff` does not show them.
Prior approvals retained through compaction are completion records, not evidence
for the current diff.

The plan specifies **required verification and its coverage** for each task,
separately from optional evidence. Use applicable builds/tests and task-relevant
checks (for example blob identity, link checks or manual UI inspection). A command
that does not exercise the changed surface cannot be its only correctness
evidence. Do not add gates by rote or silently omit existing applicable tests.

The implementer self-runs the gate. Missing or failed **required** evidence blocks
advancement. If a task deliberately relies on source inspection, declare that in
the plan; it is not runtime validation. Manual checks require appropriate access
and authorization. Optional checks that cannot run are reported, not called PASS.
The reviewer verifies the evidence and states which surfaces remain unverified;
neither worker may silently waive a required check.

## 5. Findings and bounded convergence

Reviewer reports findings first, confirms the named highest-risk properties, and
may summarize the rest as "no findings". Use three dispositions, based on effect
rather than whether the file was in the original scope:

- **Must-fix:** blocks this task; verdict CHANGES-NEEDED (or BLOCKED if required
  evidence/authority is missing). Give location, reason and actionable correction.
- **Should-fix:** nonblocking; route to an authorized correction/later task or
  report at run end. Include the proposed change and affected behavior so the
  orchestrator can route it without performing another code review.
- **Nit:** record-only; does not trigger convergence or automatic backlog work.

APPROVE may include nonblocking findings and explicit coverage limitations.
Record each routed finding's disposition so it is not lost between tasks.

After initial implementation, allow at most **two repair rounds per task**,
whether triggered by a failed gate or review findings. This is one shared budget;
passing a gate or moving between stages does not reset it. Re-run required checks
and obtain review of the resulting changes before commit.

For unresolved nonblocking preferences, the implementer's final choice wins;
record the dissent. Never use that tie-break to ship a failed required gate or an
unresolved correctness/security defect. When the cap is reached with a must-fix
or required-evidence failure still open, stop the task and escalate to the user
using §3's format. Escalate factual behavior disputes and sensitive correctness
conflicts regardless of the task's original risk label. Do not let opinion loops
stall the run indefinitely.

## 6. Predictive context management

At ADVANCE and before each new stage dispatch, use `link_list` to assess the
recipient's headroom. Estimate the coming work **including possible repairs and
handoffs**, not just the next prompt. Use model/context information available
from `link_list` or the worker. If the auto-compaction threshold is unknown, keep
a conservative reserve rather than inventing a value; do not impose a universal
percentage. A `?` immediately
after successful compaction is fresh context, not a reason to compact again.

Compact an idle worker before it starts a task if headroom is doubtful, especially
for large or sensitive work. Aim the summary at discoveries **not already in the
plan**, plus standing constraints. Size tasks so a full review/repair cycle fits.

Once a worker has begun its stage of a task, preserve its context through that
task's commit: no compaction while it may need to repair or re-review. A reviewer
or committer not yet engaged on that task may be compacted before its first
stage dispatch. If an engaged worker cannot fit the remaining work, escalate
rather than silently shedding in-flight state.

Compact yourself only at a safe task boundary, after recording the commit and
next state. Keep a brief context decision in the ledger when useful; no separate
context-accounting table is required.

## 7. Commit and run state

Committer checks **scope and hygiene, not correctness**. Its brief must include
explicit paths, expected branch/HEAD and dirt, review/gate outcome, commit message
and these rules:

- Inspect current status and the entire staged path list before staging.
- Use explicit pathspecs; never `git add .`, `git add -A` or `git commit -a`.
- Leave unrelated unstaged work alone. Block on out-of-scope staged changes,
  unexpected branch/HEAD, merge/rebase, unauthorized partial staging, missing
  paths, broad line-ending churn or hook mutation. Report whether a commit landed.
- Do not push, amend, skip hooks, bump versions or touch lockfiles without explicit
  authorization. Return hash, committed paths and post-commit status, or exact
  failure details.

Update the ledger at every transition, not only at completion: roles, task and
stage, dispatch/callback, gate and uncovered surfaces, verdict, amendments,
routed findings, dissent and commit hash. Record expected dirt; never treat the
ledger as a reviewed or committable product artifact.

After the last commit, report tasks/hashes, gate and review results, remaining
limitations and routed/skipped items. Mark the run complete and delete its ledger.
Do not delete other plans or prototypes merely because the run finished.

## 8. Recovery

| Observation | Action |
| --- | --- |
| No callback; worker idle with grown context | Check for an approval/context hold; restate authority and callback if needed |
| Worker busy | Wait; silence is not failure |
| Worker absent | Rebind/reconnect before sending; offline delivery is not queued |
| Unexpected staged work, branch or hook mutation | Report exact status; do not reset or clean someone else's changes |
| Compaction request times out | Timeout did not abort the target; check state before retrying or dispatching |
