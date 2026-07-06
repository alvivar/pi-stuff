# Run ledger (template — copy per run)

Update at each state transition (dispatch sent, callback received, verdict, hash) —
not only at ADVANCE. It survives your own compaction and keeps a long run auditable;
an in-flight row (e.g. Implement = `DISPATCHED <when>`) is what lets you resume
mid-task. Never leave a cell blank once its dispatch has been sent.

## Plan

- Path: <absolute plan path>
- Gate: build = `<cmd>` ; test = `<cmd>` (baseline N/N)
- User go: "<exact approval quote>" (<when>)
- Autonomy: <run-through (one global go) | gate-per-task>

## Role bindings (from link_list)

| Role        | Terminal      | cwd   |
| ----------- | ------------- | ----- |
| implementer | <name@domain> | <cwd> |
| reviewer    | <name@domain> | <cwd> |
| committer   | <name@domain> | <cwd> |

## Tasks

| #   | Task / findings | Implement | Gate          | Review  | Commit | Notes |
| --- | --------------- | --------- | ------------- | ------- | ------ | ----- |
| 1   | <pass / ids>    | DONE      | build OK, N/N | APPROVE | <hash> |       |
| 2   |                 |           |               |         |        |       |

## Context snapshots (predictive compaction log)

`?` in link_list = that worker just compacted: treat as fresh, reset its row to
~0 and sum task estimates (upper bound) here until it reports numbers again.

| When          | Worker | Context   | Action         |
| ------------- | ------ | --------- | -------------- |
| before task N | <impl> | <K/limit> | compacted / ok |

## Dissents / deviations

- <task>: <reviewer concern> → <implementer tie-break decision> (§3.7)
- <skipped item>: <reason>

## Run end

- Final summary posted to user: <when>
- Ledger disposed (delete-after-done): <when | pending>
