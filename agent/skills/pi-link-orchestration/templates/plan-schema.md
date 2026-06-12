# Expected plan schema

The plan is the contract you delegate against. It must be **self-contained** so a
worker can execute a task from the path alone. A good plan has:

## Header

- What it is, what file(s), test baseline (e.g. "tests green: <cmd> → N/N").
- Nature/risk overview (which items are defects vs. refactors).
- Note that line numbers are approximate; re-locate by anchors.

## One section per finding/task

Each with:

- **Where** — function/anchor + approximate line.
- **Problem** — why it needs changing.
- **Fix** — the precise change, ideally with before/after code.
- **Risk** — none / low / medium / high (drives sequencing + compaction).
- **Verify** — how to confirm (tests + any manual/reasoned check).

## Sequencing section

- Grouped passes, ordered low-risk → sensitive.
- Sensitive / single-file-conflicting items called out to **serialize**, usually LAST.
- The **gate commands** (build + test) stated once, applied after every pass.

## Out-of-scope section (optional but valuable)

- Things deliberately NOT done and why (e.g. "don't over-genericize X").
- Info-only items (e.g. version drift) flagged for the maintainer, not executed.

## Why this shape

- You delegate by **passing the path**, not your context.
- Anchors + before/after let an implementer in a fresh/compacted window act precisely.
- Risk + sequencing drive the orchestration order and predictive compaction.
