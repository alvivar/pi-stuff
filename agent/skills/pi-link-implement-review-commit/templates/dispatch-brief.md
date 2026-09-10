# Implement brief — example

Adapt to the task; use the plan for standing constraints instead of repeating it.

```text
IMPLEMENT <task-id>
GO CONFIRMED — user approved with "<quote>"; autonomy <mode>.
Repo: <absolute root>; branch/HEAD: <expected>.
Plan: <absolute path>, task <id>. Read it and its standing constraints.
Allowed paths: <list>.
Expected dirt/stage: <paths, ownership, staged state>; leave other work alone.

Outcome: <what changes>.
Highest-risk invariants:
- <the few task-specific properties that need special care>

Before editing, compare plan with current source. Contradictions → BLOCKED with
concrete proposed correction and affected behavior; do not silently reinterpret.
Gate: <required commands/checks and expected results>.
Coverage: <what these validate; optional evidence and unverified surfaces>.

No stage/commit/push or version/lockfile changes unless explicitly in scope.
<Any critical task-specific permission/safety restriction.>

Callback via link_send to <orchestrator>: <task-id> DONE or BLOCKED.
Report outcome/changed paths, gate results, remaining limitations and relevant
worktree state. Declare material deviations or unpinned decisions with rationale;
not routine idioms or confirmations of requirements. If blocked, state the exact
failure or permission needed. Stop and wait for an explicit continuation.
```
