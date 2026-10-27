# Plan contract

The plan is the context carrier for fresh workers. Keep it task-sized and
self-contained; observations do not each need an ID, audit table or deliverable.

## Run header

- Approved outcome and exclusions.
- Absolute repository path, expected branch/HEAD and known baseline state.
- Ordered tasks and allowed paths; standing constraints/permissions declared once.
- Autonomy/go, or pending authorization; baseline verification to perform.

## Each task

- **Where:** paths and stable source anchors; line numbers are hints.
- **Outcome:** what changes and what must remain true. Give before/after where it
  clarifies the contract, not as a substitute for reading current source.
- **Invariants:** for dependency internals, lifecycle and guards, pin behavior and
  verification rather than guessing wiring. Implementer checks plan against
  current source before editing and reports contradictions.
- **Risk/dependencies:** distinguish shared-resource serialization from sensitive
  correctness. Order by dependencies and risk; all implementation is serial.
- **Verification:** required checks/commands with expected results and coverage;
  optional checks and unverified surfaces separately. Use relevant builds/tests,
  identity/link checks, manual evidence or explicitly declared source inspection
  as appropriate. Identify required runtime access before dispatch.

Choose coherent tasks that fit an implement/review/repair cycle, one commit each.
Reference finding IDs only where needed by a task. Do not duplicate source detail
or turn every observed nit into scope.

## Changes during execution

Record permitted run-through corrections and explicit path changes before edits;
retain required user ratification for changed outcomes or material risk under
SKILL.md §3. Review amendments with their implementation. Run-state transitions
belong in the ledger, not repeated throughout this plan.
