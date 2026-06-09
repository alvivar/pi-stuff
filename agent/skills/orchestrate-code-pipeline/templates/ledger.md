# Run ledger (template — copy per run)

Keep this updated at each ADVANCE step. It survives your own compaction and keeps a
long run auditable.

## Plan
- Path: <absolute plan path>
- Gate: build = `<cmd>` ; test = `<cmd>` (baseline N/N)
- User go: "<exact approval quote>" (<when>)

## Role bindings (from link_list)
| Role | Terminal | cwd |
|------|----------|-----|
| implementer | <name@domain> | <cwd> |
| reviewer | <name@domain> | <cwd> |
| committer | <name@domain> | <cwd> |

## Tasks
| # | Task / findings | Implement | Gate | Review | Commit | Notes |
|---|-----------------|-----------|------|--------|--------|-------|
| 1 | <pass / ids> | DONE | build OK, N/N | APPROVE | <hash> | |
| 2 | | | | | | |

## Context snapshots (predictive compaction log)
| When | Worker | Context | Action |
|------|--------|---------|--------|
| before task N | <impl> | <K/limit> | compacted / ok |

## Dissents / deviations
- <task>: <reviewer concern> → <implementer tie-break decision> (§3.7)
- <skipped item>: <reason>
```
