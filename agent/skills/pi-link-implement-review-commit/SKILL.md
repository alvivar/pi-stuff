---
name: pi-link-implement-review-commit
description: Orchestrate a plan-driven implement→review→commit pipeline across multiple PI terminals over pi-link. Use when you are the ORCHESTRATOR coordinating other terminals (an implementer, a reviewer, a committer) to execute a written plan task-by-task — delegating self-contained work, gating each task on build/tests, managing each worker's context window, serializing sensitive or single-file edits, and routing all messages through yourself. This is the policy layer on top of pi-link-coordination (the mechanism). Not for writing code yourself, and not for one-off single-terminal messaging.
---

# Implement → Review → Commit

You are the **orchestrator**. You do not write or review code — ever — and you do
not commit, except the §1 committer fold-in with explicit user permission. You
route self-contained tasks between worker terminals, enforce gates, manage their
context, and keep the pipeline acyclic and serialized.

This skill is **policy**. For link tool mechanics (link_send / link_compact /
link_list, delivery, batching, callbacks) load the `pi-link-coordination` skill
(listed in your available skills) and read it first.

Worked examples (briefs from runs that went well) and the expected plan schema
live next to this file — examples, not forms (§4):

- [templates/dispatch-brief.md](templates/dispatch-brief.md)
- [templates/review-brief.md](templates/review-brief.md)
- [templates/commit-brief.md](templates/commit-brief.md)
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
   are serialized/sensitive. Open a ledger next to the plan (`LEDGER-<plan>.md`,
   copied from `templates/ledger.md`).
4. **Verify the baseline.** Dispatch the implementer to run the gate once
   (build + tests) and read the worktree state (`git status --short --branch`)
   before task 1. A red baseline makes every later gate lie about whose defect
   it is, and pre-staged junk blocks the committer at the worst moment — both
   are the user's to fix, before the run starts.
5. **Agree the autonomy level, then HOLD for the user's explicit "go."** Present
   the todo and ask: run-through (one global go for the whole plan) or
   gate-per-task (the user approves each task at its HOLD, right before COMMIT)?
   Record the answer in the ledger's `Autonomy:` field. Do not dispatch anything
   until the user approves.

---

## 1. Roles (parameters — bind via link_list, never hardcode)

| Role         | Does                              | Notes                                                                                                                    |
| ------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| orchestrator | you — route, gate, manage context | never writes/reviews code; commits only under the §1 committer fold-in exception                                         |
| implementer  | edits code, self-runs the gate    |                                                                                                                          |
| reviewer     | reviews diffs against the plan    | MUST differ from implementer (independence)                                                                              |
| committer    | makes git commits                 | may fold into orchestrator only if no dedicated committer and the user permits you to commit (the single §3.8 exception) |

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
  PRE-FLIGHT  task-boundary dispatches only (new IMPLEMENT, REVIEW, COMMIT):
              link_list → if the worker's window may not fit the coming task,
              link_compact it (idle only; "?" = just compacted = fresh window).
              Never mid-task — §3.4.
  IMPLEMENT   link_send(implementer) + full dispatch brief (§4)
  WAIT        hold for DONE/BLOCKED
  GATE        worker self-ran build+tests; a red/missing gate == BLOCKED → relay
              failure details, re-IMPLEMENT (bounded: same cap as CONVERGE, then
              escalate to the user)
  REVIEW      link_send(reviewer) + review brief (§4)
  WAIT        hold for APPROVE / CHANGES-NEEDED
  CONVERGE    CHANGES-NEEDED → relay to implementer, loop; cap 2 iterations;
              tie-break = implementer, except sensitive tasks → user (§3.7)
  HOLD        gate-per-task autonomy only: present diff summary + review verdict
              to the user; wait for their go before committing
  COMMIT      link_send(committer) + commit brief
              (templates/commit-brief.md); wait for DONE + hash
  ADVANCE     record commit/hash/gate in ledger; next task
```

**WAIT means end your turn.** The callback _is_ your next turn. A message's effect
is decided by the worker's state when the message is delivered, not when you send
it: if the worker is still running then, your message is steered into the run you
are waiting on, alongside the brief that started it.

**Commit before the next IMPLEMENT.** Review reads the _uncommitted_ diff
(`git diff -- <file>`), so committing each task is what keeps the next review
diff single-task. Deferred or batched commits blur every subsequent review.

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
   (report DONE/BLOCKED to `<you>` via `link_send` with a diff
   summary + gate results — **declaring any MATERIAL judgment call beyond the
   brief's letter** (contract, data shape, error semantics, scope, test
   strategy — anything a reviewer would evaluate differently if told), with its
   rationale: an undeclared deviation is the one change review cannot target,
   because nothing pinned it and nobody said it exists. **Declared deviations
   then travel with the work into the review brief, verbatim** — relayed by
   you, or the declaration terminates at the hub and reviewed-hardest never
   happens. In a shared worktree, also state which pre-existing dirt is
   expected and owned (plan, ledger, prior-task leftovers) — a worker cannot
   infer whose the dirt is or whether it may clean it.
3. **Gate is non-negotiable and worker-self-run.** Never trust "looks done." The
   worker runs the build + tests and reports results; red or missing = BLOCKED.
4. **Predictive context management.** Compact any worker whose window may not
   fit the coming task — judge the fit BEFORE dispatching, not once the window
   is already full (the implementer grows fastest). The hazard is Pi's
   auto-compaction firing MID-TASK, which can shed the dispatch brief's details
   at the worst moment; orchestrated compaction while the worker is idle
   (`link_compact` blocks, then returns) exists to pre-empt exactly that.
   Compact right before a large or sensitive task so it runs in a clean window.
   Compaction is a TASK-BOUNDARY operation: never compact a worker between its
   IMPLEMENT and that task's commit — a CONVERGE relay or gate-red retry needs
   the very in-flight state compaction sheds; if the window truly can't fit the
   fix, escalate to the user instead. Because dispatches are self-contained
   (§3.2), the next brief re-supplies everything task-specific; the only
   irrecoverable loss is what the worker learned that is NOT in the plan — aim
   the compaction instructions at exactly that.
5. **Serialize shared-resource edits.** One file / sensitive logic → strictly
   sequential. Enter a sensitive task in a freshly compacted window, with its
   invariants spelled out in both the implement and review briefs; sequence it
   where risk dictates (often last — but the critical path may say otherwise).
6. **Acyclic, hub-routed delegation.** You are always the relay. Workers never
   message each other to close a loop: an accepted send does not wait for a reply,
   so the protocol supplies no exit condition for a cycle.
7. **Convergence has a backstop.** Cap review iterations at 2; if implementer and
   reviewer can't agree, the implementer's final decision wins — record the
   dissent in the ledger and move on. The pipeline must never deadlock on opinion.
   This is a LIVENESS policy, not a correctness claim — the tie-break decides
   who moves, not who is right; the recorded dissent is what preserves the
   question for the user. Exception: on tasks marked sensitive/serialized (§3.5) a deadlock escalates to
   the user instead — the tie-break is a bet, and sensitive code is where you
   don't bet.
8. **You stay hands-off.** Do not edit or review code yourself — ever. Do not
   commit, except the §1 committer fold-in with the user's explicit permission.
   Your neutrality is what makes the review independent and the constraints hold.
   Hands-off applies to the CODE: plans and ledgers are yours to write, and
   mid-run plan amendments are orchestrator work (user-ratified, committed
   alongside the code that implements them).
9. **The committer checks scope and hygiene, not correctness — never re-review.**
   It verifies the staged diff matches the brief's path list and the worktree is
   safe to commit. Correctness was settled at REVIEW; a committer that
   re-litigates it adds a second, unaccountable review loop.

---

## 4. Dispatching

- **Implement / review / commit are dispatched with `link_send`** and answered by a
  callback, which is another `link_send`. Nothing correlates the two but their text,
  so the brief must name you as the recipient and state the DONE/BLOCKED contract.
- **Untracked files are invisible to `git diff`.** A reviewer following the diff
  command silently covers only modified files — route every new in-scope file
  to the reviewer explicitly, by path.
- Write the brief each task actually needs — the non-negotiables are §3.2's
  (self-contained, go-signal, gate, callback contract), not any format. The
  templates are worked examples from good runs: what generalizes is what their
  asks _surface_ (per-finding confirmation, "confirm the reasoning", named
  highest-risk checks), not their shape. Aim your asks at THIS task's real risks.

---

## 5. Failure taxonomy (diagnose, don't assume)

| Symptom                                                        | Likely cause                                                          | Recovery                                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No callback, worker **idle**, context grew                     | Worker ran a turn but withheld callback (often: waiting for approval) | `link_list` shows idle with a grown window — it ran and stopped. An approval you hold is not visible to it (§3.1)                                                                                          |
| No callback, worker **busy**                                   | Still working                                                         | Its queued messages are invisible to you, and silence is indistinguishable from progress                                                                                                                   |
| No callback, worker **absent** from list                       | Offline; messages were dropped (not queued)                           | Nothing is queued for it; a role bound to that name has no delivery until it reconnects                                                                                                                    |
| Committer BLOCKED (staged junk / wrong branch / hook mutation) | Dirty shared worktree                                                 | Relay the exact `git status` to the user — worktree hygiene is the user's to fix, not a worker's                                                                                                           |
| `link_compact` errors at its 3-min ceiling                     | The timeout bounds your wait only; nothing aborted the target          | The target may still be compacting. `link_list` shows a "?" or shrunken context once it finished                                                                                                            |

Idle + grown context is a logic hold, not a crash.

---

## 6. Ledger (observability)

Keep a running ledger (`LEDGER-<plan>.md` next to the plan, copied from
`templates/ledger.md`) so a long run stays auditable and
survives your OWN compaction: role bindings, and per task — scope, implementer
DONE summary, gate result, review verdict, commit hash, any dissent. Write each
state transition when it happens (dispatched → callback → verdict → hash), not
only at ADVANCE: the in-flight row ("task 3 at REVIEW, sent <when>") is exactly
what lets you resume correctly if you compact mid-task. Compact YOURSELF only at
an ADVANCE boundary, right after writing the ledger — the in-flight rows make
mid-task recovery possible, not desirable.

---

## 7. Out of scope / do not

- Don't write or review code yourself; don't commit except under the explicit §1
  committer fold-in.
- Don't bump versions or touch lockfiles unless that is explicitly the task; git is
  usually hand-managed by the user — delegate commits to the committer.
- The pipeline is **serial-only**: one task in flight at a time. (Future work:
  safe parallelism would need genuinely independent files/logic, separate
  workers, commits still serialized, and per-worker callback tracking in the
  ledger — none of which this loop expresses. Don't improvise it.)
- Don't restate or fork pi-link mechanics — reference the companion skill.
- Don't strip debugging-relevant detail from briefs to make them shorter; precision
  beats brevity in a dispatch.

---

## 8. Run end

When the last task's commit is recorded in the ledger:

1. **Final summary to the user** — tasks completed, commit hashes, gate results,
   review verdicts, any dissents or skipped items.
2. **Close the ledger** — mark the run complete, then dispose of it per the
   delete-after-done convention (it was run-state, not documentation).
