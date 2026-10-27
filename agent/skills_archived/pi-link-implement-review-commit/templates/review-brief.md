# Review brief — example

Reviewer must differ from implementer. Review actual changes, not the summary.

```text
REVIEW <task-id>
GO CONFIRMED — user approved with "<quote>".
Repo: <absolute root>; branch/HEAD: <expected>.
Plan: <absolute path>, task <id>; read its standing constraints.
Diff: git -C <root> diff -- <in-scope paths>
New/untracked in-scope files, read directly: <absolute paths or none>.
Expected dirt/stage and ownership: <including protected ledger path if present>.

Scope/outcome: <task only, including authorized amendments>.
Highest-risk checks:
- <few properties to scrutinize, including sensitive invariants>
Material declarations from implementer (verbatim): <declarations or none>.
Evidence: <implementer gate results, required checks, optional evidence/gaps>.
Verify the evidence; run the review checks required by the plan. Never silently
waive a required check or call source reasoning a runtime pass.

Read-only: no edits, staging, commits, version or lockfile changes.
<Any critical task-specific permission/safety restriction.>

Callback via link_send to <orchestrator>: <task-id> APPROVE,
CHANGES-NEEDED or BLOCKED.
Findings first: must-fix blocks, should-fix routes, nit is record-only.
Give location, reason and actionable correction for findings. For routed items,
include proposed change and affected behavior. Confirm named highest-risk checks;
"no findings" suffices for the rest. State gates and uncovered surfaces.
```
