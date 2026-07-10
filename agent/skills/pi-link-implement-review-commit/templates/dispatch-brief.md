# Dispatch brief — worked example (implementer)

Send via `link_send(to: <implementer>, triggerTurn: true)`. This is an example
from good runs, not a form — write the brief YOUR task needs. What is
non-negotiable is §3.2: self-contained (the worker shares none of your
context), go-signal, gate, callback contract.

```
GO — <prior task> committed (<hash>). Proceed with <this task>.
GO — first task of the run.                               # task 1 variant: no prior commit to cite
GO CONFIRMED — user approved with "<exact user quote>".   # include when first releasing held work

TASK — <task id / pass name>: <finding ids and one-line intent> on <file>.
Plan (authoritative spec — locations, before/after, risk, verify):
  <absolute plan path>

Do exactly (per the plan):
  - <finding>: <precise change, with before/after if the plan gives it>
  - <finding>: <...>

CRITICAL — behavior must be <identical | as-specified>:
  - <invariant 1 the change must preserve, e.g. precedence flag>env>saved>session>random>
  - <invariant 2>

GATE (both must pass):
  1. <build/bundle command>
  2. <test command>   (must stay <N/N>)

Constraints: do NOT commit, do NOT bump versions / touch lockfiles.

Also reason through (confirm in your report, no need to run live):
  - <correctness property to trace>

Report DONE/BLOCKED to <orchestrator> via link_send(triggerTurn:true) with:
  - diff summary (functions/sites touched)
  - gate results (build ok? test count?)
  - the requested reasoning
  - material judgment calls beyond this brief's letter (contract, data shape,
    error semantics, scope, test strategy), each with its rationale
  - if BLOCKED: what failed
```

## Why each part

- **Go-signal**: prevents the silent "waiting for approval" stall.
- **Plan path, not pasted context**: cheap, authoritative, survives your compaction.
- **CRITICAL invariants**: the only place a "behavior-identical" refactor can go wrong.
- **Worker self-runs the gate**: you never trust "looks done."
- **"Confirm in your report"**: surfaces reasoning instead of a bare "done."
- **Declared judgment calls**: review can only target what the plan pinned or
  the implementer declared — undeclared deviations are invisible to it.
  "Material" keeps this from becoming a design diary: declare what a reviewer
  would evaluate differently if told, not every local choice.
- **Callback contract**: triggerTurn:true returns nothing automatically — you must ask.
