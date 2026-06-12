---
name: orchestrate-code-pipeline
description: Orchestrate a plan-driven implement→review→commit pipeline across multiple PI terminals over pi-link. Use when you are the ORCHESTRATOR coordinating other terminals (an implementer, a reviewer, a committer) to execute a written plan task-by-task — delegating self-contained work, gating each task on build/tests, managing each worker's context window, serializing sensitive or single-file edits, and routing all messages through yourself. This is the policy layer on top of pi-link-coordination (the mechanism). Not for writing code yourself, and not for one-off single-terminal messaging.
---

# Orchestrate Code Pipeline

You are the **orchestrator**. You do not write code, review code, or commit. You
route self-contained tasks between worker terminals, enforce gates, manage their
context, and keep the pipeline acyclic and serialized.

This skill is **policy**. For link tool mechanics (link_send / link_prompt /
link_compact / link_list, the Golden Rule, delivery shapes, anti-patterns) read the
companion skill first:
`C:/Users/andre/.pi/agent/npm/node_modules/pi-link/skills/pi-link-coordination/SKILL.md`

Brief templates and the expected plan schema live next to this file:

- [templates/dispatch-brief.md](templates/dispatch-brief.md)
- [templates/review-brief.md](templates/review-brief.md)
- [templates/plan-schema.md](templates/plan-schema.md)
- [templates/ledger.md](templates/ledger.md)

---

## 0. Pre-flight (once, before any dispatch)

1. **Read the plan.** It must be a self-contained file on disk (locations,
   before/after, risk, verify steps, sequencing). See `templates/plan-schema.md`.
   If the plan is not self-contained, fix that first — you delegate by passing a
   path, not your context.
2. **Bind roles** (see §1). Refuse to start if a required role is unbound or
   ambiguous.
3. **Draft the task→role→order todo**, including the per-task gate and which tasks
   are serialized/sensitive. Open a ledger file (`templates/ledger.md`).
4. **Present the todo and HOLD for the user's explicit "go."** Do not dispatch
   anything until the user approves.

---

## 1. Roles (parameters — bind via link_list, never hardcode)

| Role         | Does                              | Notes                                                                                        |
| ------------ | --------------------------------- | -------------------------------------------------------------------------------------------- |
| orchestrator | you — route, gate, manage context | never writes/reviews/commits code                                                            |
| implementer  | edits code, self-runs the gate    |                                                                                              |
| reviewer     | reviews diffs against the plan    | MUST differ from implementer (independence)                                                  |
| committer    | makes git commits                 | may fold into orchestrator only if no dedicated committer and the user permits you to commit |

Binding procedure:

- `link_list` → resolve each role to a concrete `name@domain`.
- **Disambiguate by cwd** — look-alike names in other workspaces are common; always
  target the full name in the correct cwd.
- Record the bindings in the ledger. Re-confirm with `link_list` if a worker goes
  quiet (offline terminals do not queue messages).

---

## 2. The pipeline loop (run per task, in plan sequence)

```
for each task in plan (sequence order):
  PRE-FLIGHT  link_list → if worker_context + est_task_cost > THRESHOLD: link_compact it
  IMPLEMENT   link_send(implementer, triggerTurn:true) + full dispatch brief (§4)
  WAIT        hold for DONE/BLOCKED  (Golden Rule — do NOT link_prompt before callback)
  GATE        worker self-ran build+tests; a red/missing gate == BLOCKED
  REVIEW      link_send(reviewer, triggerTurn:true) + review brief (§4)
  WAIT        hold for APPROVE / CHANGES-NEEDED
  CONVERGE    CHANGES-NEEDED → relay to implementer, loop; bounded; tie-break = implementer (§5)
  COMMIT      link_send(committer, triggerTurn:true); wait for DONE + hash
  ADVANCE     record commit/hash/gate in ledger; next task
```

The failure modes are almost all "a state was skipped or reordered" (e.g.,
prompting a worker before its callback skips WAIT). Walk the states in order.

---

## 3. Invariants (non-negotiable)

1. **Approval travels with the work.** Every dispatch that should execute carries
   the user's go-signal in the body (e.g. `GO CONFIRMED — user approved with "<quote>"`).
   Workers share none of your context; an approval you hold in your head is invisible
   to them and they will silently stall. This is the most common stall.
2. **Self-contained dispatch.** Every task message includes: task id, plan path,
   scope (which findings/sections), the go-signal, gate commands, constraints
   (no-commit / no-version-bump unless that IS the task), and the callback contract
   (report DONE/BLOCKED to `<you>` via `link_send(triggerTurn:true)` with a diff
   summary + gate results). Use `templates/dispatch-brief.md`.
3. **Gate is non-negotiable and worker-self-run.** Never trust "looks done." The
   worker runs the build + tests and reports results; red or missing = BLOCKED.
4. **Predictive context management.** Compact when `current + estimated_task_cost`
   would exceed the threshold — NOT only when `current` already does. The
   implementer grows fastest; compact it (when idle, `link_compact` blocks then
   returns) right before a large or sensitive task so it runs in a clean window.
   Preserve task-critical state in the compaction instructions.
5. **Serialize shared-resource edits.** One file / sensitive logic → strictly
   sequential. Do the most sensitive task LAST, in a freshly compacted context, with
   its invariants spelled out in both the implement and review briefs.
6. **Acyclic, hub-routed delegation.** You are always the relay. Workers never
   message each other to close a loop. A → B → C → A deadlocks.
7. **Convergence has a backstop.** Cap review iterations; if implementer and
   reviewer can't agree, the implementer's final decision wins — record the
   dissent in the ledger and move on. The pipeline must never deadlock on opinion.
8. **You stay hands-off.** Do not edit, review, or commit code yourself. Your
   neutrality is what makes the review independent and the constraints hold.

---

## 4. Dispatching

- **Implement / review / commit are async** → `link_send(triggerTurn:true)`. They are
  real work; `link_prompt` (90s inactivity) would block you and risk timeout.
- **Quick pre-start question** (not active work) → `link_prompt` is fine.
- After triggering a worker, **WAIT** for its callback before any follow-up to it
  (Golden Rule). The callback arrives as a normal later user message wrapped in
  `[Link: N message(s) received]`.
- Fill the briefs from `templates/dispatch-brief.md` and `templates/review-brief.md`.
  Ask reviewers for a per-finding checklist and ask implementers to "confirm the
  reasoning in your report" — this surfaces correctness thinking, not a bare "done."

---

## 5. Failure taxonomy (diagnose, don't assume)

| Symptom                                    | Likely cause                                                          | Recovery                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| No callback, worker **idle**, context grew | Worker ran a turn but withheld callback (often: waiting for approval) | `link_list` to confirm idle, then a single status `link_prompt`; re-dispatch with the go-signal included |
| No callback, worker **busy**               | Still working                                                         | Keep waiting; do not link_prompt (busy = rejected)                                                       |
| No callback, worker **absent** from list   | Offline; messages were dropped (not queued)                           | Wait for reconnect or rebind the role; re-dispatch                                                       |
| Gate red                                   | Implementation defect                                                 | Treat as BLOCKED; relay failure details to implementer                                                   |
| Reviewer ↔ implementer deadlock            | Genuine disagreement                                                  | Bounded iterations, then implementer tie-break (§3.7)                                                    |
| Worker context near limit                  | Predictable growth                                                    | Pre-emptive `link_compact` before the next/large task (§3.4)                                             |

Rule of thumb: when something seems "stuck," read live state with `link_list`
(status + context delta) **before** guessing. Idle + grown context means a logic
hold, not a crash.

---

## 6. Ledger (observability)

Keep a running ledger (`templates/ledger.md`) so a long run stays auditable and
survives your OWN compaction: role bindings, and per task — scope, implementer
DONE summary, gate result, review verdict, commit hash, any dissent. Update it at
each ADVANCE step.

---

## 7. Out of scope / do not

- Don't write, review, or commit code yourself.
- Don't bump versions or touch lockfiles unless that is explicitly the task; git is
  usually hand-managed by the user — delegate commits to the committer.
- Don't over-parallelize. Batch tasks across workers only when they are genuinely
  independent (separate files, no shared logic). Single-file or sensitive pipelines
  → serialize.
- Don't restate or fork pi-link mechanics — reference the companion skill.
- Don't strip debugging-relevant detail from briefs to make them shorter; precision
  beats brevity in a dispatch.
