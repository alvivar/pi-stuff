# PLAN — Five-minute compaction limits

> Status: Implemented.
> Repository: C:/Users/andre/.pi
> Product: C:/Users/andre/.pi/agent/workshop/pi-link
> Branch / starting HEAD: master / 1836dcd4df538d3144c5dd9a584670acbdf55eae

## Outcome and authority

Owner requested a five-minute limit and asked why it should not apply to both
uses of COMPACT_TIMEOUT_MS. Proposed outcome: raise the existing shared value
from 180_000 to 300_000 ms for BOTH the remote-request wait and the local manual
compaction gate's fallback deadline. No new configuration or split constants.

The owner supplied the implement-review-commit skill and explicitly authorized
this plan with "Go, run through!". Mode: run-through through the single commit,
with mandatory baseline/self-gate and independent review. All three roles independently
confirmed identity/repo and availability. No deployment authority is included.

The owner separately instructed committer to commit this plan, producing plan-only
1836dcd4df538d3144c5dd9a584670acbdf55eae (parent da6a7be). After the metadata mismatch
paused this run, owner explicitly ratified that new baseline with
"Confirmo, go run though!". Preserve that commit; implementation remains one task.

Pre-plan inspection found a clean worktree/index and master synchronized with
origin/master. The committed plan's authorization/baseline updates are orchestrator-owned expected
dirt; temporary LEDGER-compact-five-minutes.md is opened for this run and never staged.

## Roles and context

Verified roles, each independently confirmed identity, cwd/git root C:/Users/andre/.pi,
master at the new baseline, empty staged state and availability:
- Implementer: implementer@pi-link (~106K/1M).
- Independent reviewer: reviewer@pi-link (~150K/272K).
- Committer: committer@pi-link (~23K/272K).
- Orchestrator: archon@pi-link (~75K/272K).

Role binding is complete. Recheck branch/HEAD and expected dirt before each stage.
Cwd from link_list alone is not repository proof. Designer is excluded. No work is
delegated to test terminals or oreja terminals.

Use the owner's 200K healthy-context reference and preserve repair/handoff reserve.
Reassess before each stage. This is one narrow task, not a new broad source review.
If reviewer headroom is doubtful, compact while idle BEFORE its review stage;
never compact an engaged worker before this task's commit. Timeout does not abort
compaction. No polling or blind retry; WAIT means end the turn.

## Task T1 — Raise both budgets and align current documentation

One implementation, one independent review, one commit. Do not fragment comments,
docs and verification into separate tasks.

### Allowed paths (relative to product)

- index.ts
- README.md
- skills/pi-link-coordination/SKILL.md
- test/lifecycle-compact-test.mjs
- test/inbox-fixed-window-test.mjs
- CHANGELOG.md
- PLAN-compact-five-minutes.md (orchestrator-owned plan, retained and committed)

Temporary ledger: C:/Users/andre/.pi/agent/workshop/pi-link/LEDGER-compact-five-minutes.md
(orchestrator-owned, not a product artifact, never stage).

### Changes

1. index.ts: COMPACT_TIMEOUT_MS becomes 300_000. Keep the two existing consumers:
   setCompacting()'s local deadline and link_compact's pending-request timeout.
   The timeout result derives its seconds from the constant; do not hardcode 300
   there. Update the two comments mentioning 180s (flushInbox and teardown).
   The shared numeric budget still governs two semantically distinct timers;
   do not add a new linkage between their lifecycle/ownership.
2. README.md: update the link_compact introduction, timeout bullet, cancelled
   compaction backstop bullet, and constants table. Remove the unsupported
   'compaction typically takes 5–60s' estimate rather than inventing another one.
3. skills/pi-link-coordination/SKILL.md: change both three-minute descriptions to
   five-minute (delivery gate fallback and caller wait). Preserve timeout caveats.
4. test/lifecycle-compact-test.mjs: align the two deadline comments; retain its
   existing busy/settled/teardown tests without unrelated changes.
5. test/inbox-fixed-window-test.mjs: reuse its controlled clock to exercise both
   new deadlines, with only the minimal harness adaptation needed to invoke the
   registered link_compact tool. No duplicate general harness, new production
   seams, dependencies or real five-minute waits. If current source contradicts
   this placement, report BLOCKED with a minimal alternative before editing it.
6. CHANGELOG.md: add an Unreleased / Changed entry describing BOTH increases and
   the non-cancellation behavior. Do not rewrite published historical entries.

### Invariants and scope exclusions

- Only the two time budgets change. Busy/idle authorization, self/unknown target
  rejection, group filtering, ownership/cleanup and lifecycle remain unchanged.
- Caller timeout or abort after dispatch ends the wait, not the target's work.
- Local gate may still release earlier on successful manual compaction or the
  next agent_start. The independent compactRunning hold remains authoritative:
  the local deadline does not force release while the other gate remains raised.
- Normal batching still governs delivery after a gate releases. Do not confuse
  clearing the gate at 300_000 ms with immediate same-instant inbox delivery.
- Both limits are relative to their own arming event, not a synchronized deadline.
- The tradeoff is explicit: cancelled/failed manual compaction without an ending
  visible to the extension may now hold messages for up to two additional minutes
  unless another existing release event occurs. Five minutes is not a guarantee
  that every large compaction finishes within the caller's wait.
- Keep historical 180s observations in published CHANGELOG entries, old plans,
  reports and live-test artifacts. Their evidence must not be rewritten to 300s.
  Do not touch batching tests' unrelated 180 ms or README's 180K context example.
- No new options, protocol/state machinery, cancellation handling or unrelated
  cleanup. Do not reopen REPORT-session-compact-failed.md's deferred proposal.
- No installed-copy edits, package/lockfile/version changes, install/reload,
  terminal rename/disconnect/launch, push or publication. User owns deployment.
- Preserve existing file line endings (product CRLF, plan LF); verify bytes and
  avoid broad normalization. Use /dev/null, never NUL.
- Product should stay simple, readable and idiomatic: every added line needs a
  concrete purpose; only fundamental tests, not a combinatorial test matrix.

### Required verification

Implementer first verifies git root/branch/HEAD, worktree and full staged list,
then runs the existing gate BEFORE edits. Unexpected staged work or a red baseline
blocks implementation; never reset or silently fix someone else's work.

From C:/Users/andre/.pi/agent/workshop/pi-link, baseline and post-change:

```sh
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs
node test/lifecycle-compact-test.mjs
node test/connection-ownership-test.mjs
node test/inbox-fixed-window-test.mjs
node test/message-renderer-test.mjs
git diff --check
```

All commands must exit zero, with no failed assertions. Previous clean baseline
was 444 checks, but counts are reported evidence, not quotas. Report native pi-tui
renderer block ran/skipped accurately; no hidden waiver of a required surface.

Added deterministic coverage must exercise the extension (not only compare text):
- Local manual gate remains held past the old 180s deadline and just before 300s;
  at 300s its fallback clears, allowing queued messages through normal batching.
- A dispatched remote request remains pending past 180s and just before 300s;
  at 300s the caller resolves with the timeout result reporting 300s and retaining
  the warning that the target may still be compacting.
- Existing teardown checks leave no controlled timers/transports behind. Do not
  change production constants in tests to manufacture shorter waits.

Reviewer independently runs the same applicable post-change gate and assesses
the actual diff/new plan, the two consumer deadlines, preserved non-cancellation,
local release paths, minimal test harness changes and accurate current docs.
Inspect active 180s/three-minute references and distinguish historical/unrelated
matches rather than requiring an indiscriminate zero-match grep. Both workers
report changed paths, results, coverage limitations and material decisions with
rationale. Orchestrator relays material declarations verbatim to reviewer.

Coverage limits: controlled transport/Pi lifecycle fixtures are not live Pi UI
end-to-end proof or actual large-context performance measurements. Installed
runtime remains the old build during this run. No new live five-minute smoke is
required or implicitly authorized; owner plans to assess real use after updating.

Optional additional probes are not required gates and must be reported honestly.
No validation strategy or material behavior changes without plan amendment and,
where scope/risk changes, owner ratification.

## Convergence and commit

At most two shared repair rounds after initial implementation, across gate/review.
Must-fix or required-evidence failure after the cap blocks/escalates. Should-fix
is nonblocking and explicitly routed; nit is record-only. No opinion loop.

Implementation completed without scope amendments or material deviations. Baseline
444/0; initial post-change 453/0. Independent review found that delivery absence
alone did not establish the exact local gate boundary. One test-only repair now
observes the last emitted status: compacting just before the deadline, idle at it,
with delivery still deferred through normal batching. Final post-repair gate454/0
(inbox25→35, all other suite counts unchanged), CLI syntax and diff checks exit0;
installed native renderer block9 ran. The two controlled-clock blocks use minimal
registered-tool harness support and the existing wire-status observable.
Optional isolated-copy probes: old-value reversion failed five checks before the
repair; local fallback minus1ms now fails one check, plus1ms fails two. No shared
source was mutated by probes. Production bytes remain CRLF and this plan LF.
Runtime/UI/performance limitations above remain in force. Independent re-review
must verify the repair and required evidence before commit; review/commit records
belong in the temporary ledger.
Committer checks scope/hygiene, not correctness. Explicit paths only; no git add
./-A, commit -a, amend, skipped hooks, unrelated staged files or hook mutation.
Commit this retained plan with the six product/doc/test files; never the ledger.
Suggested subject: 'fix(pi-link): extend compaction limits to five minutes'.
After commit, report hash/gates/review/limitations, delete only the temporary run
ledger, and leave the plan and all historical evidence intact.
