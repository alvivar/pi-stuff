# Review brief template (reviewer)

Send via `link_send(to: <reviewer>, triggerTurn: true)`. The reviewer must differ
from the implementer.

```
REVIEW TASK<( — sensitive, extra scrutiny)> — <implementer> implemented <task id>
on <file>. Please review the uncommitted diff.

Repo: <repo path>   (git root <root>)
Diff:  git -C <git root> diff -- <relative file path>
Plan (spec): <absolute plan path>   (finding(s) <ids>)

Scope = <finding ids> ONLY. Confirm each matches the plan and is
<behavior-identical | as-specified>:
  - <finding>: <what to verify>
  - <finding>: <what to verify>

CRITICAL checks (the real correctness risks):
  1. <invariant — e.g. "latest-matching-wins preserved at all sites, incl. no-match→undefined">
  2. <invariant — e.g. "precedence unchanged; lookup mechanism changed, not branch structure">
  3. <the single highest-risk property — e.g. ctx/object identity, off-by-one, ordering>

Gate green per implementer: <build ok>, <test N/N>.

Report to <orchestrator> via link_send(triggerTurn:true): APPROVE or
CHANGES-NEEDED. If CHANGES-NEEDED, list each concern with file location and the
specific fix so the implementer can act directly.
```

## Notes
- Always give the **exact diff command** — the reviewer reads the real change, not your summary.
- Ask for **per-finding confirmation + a named highest-risk check**; this is what catches the subtle one (object identity, precedence, ordering).
- Require **actionable** CHANGES-NEEDED (location + fix) so you can relay it verbatim.
