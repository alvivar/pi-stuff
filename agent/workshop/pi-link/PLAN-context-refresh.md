# Republish context after a model change or tree navigation

## Run

- **Outcome:** one task, C1: publish fresh context after `model_select` and
  `session_tree`, with the README and CHANGELOG text below. No other idle-context
  triggers, wire/protocol changes, dependencies, version or lockfile changes.
- **Repo/baseline:** `C:/Users/andre/.pi`, `master`, HEAD
  `1782ffe6ff4e3f559183de4f12ec30075ac329bd`. The only expected dirt is
  this untracked plan; the index is empty. Verify again before editing. A
  different owner commit is not itself a blocker unless it conflicts.
- **Allowed product paths:** `agent/workshop/pi-link/index.ts`, `README.md`,
  `CHANGELOG.md` (the latter two relative to the same package directory).
  Include this amended plan in the reviewed commit. Temporary probe artifacts
  stay outside the commit; the run ledger is never staged.
- **Invariants:** use the current status identity and `since`, including during
  a run or compaction; preserve the disconnected short-circuit. Do not broaden
  publication to other events or add a permanent test without an approved
  amendment. Implementer checks the plan against current source before edits;
  contradictions are blockers to report, not guesses to implement.
- **Authority:** owner approved run-through with `go run through!` for this
  plan. One implement → independent review → separate commit, serially.

## Problem

A terminal publishes its context usage with every status change. Two common idle
actions change usage without changing status, so peers keep the old figure until
that terminal runs again:

- **Model change.** Usage is measured against the current model's window: moving a
  150K-token session from a 1M to a 200K model takes it from 15% to 75%, and
  peers still see 15% — the figure an orchestrator reads in `link_list` before
  dispatching work.
- **Tree navigation.** Usage is measured on the active branch; switching branches
  changes it.

Pi emits `model_select` and `session_tree` after applying each change.

## Change

`index.ts`, after the `session_compact` handler:

```ts
  pi.on("model_select", async () => {
    pushStatus(true); // the window, and so the usage percentage, belongs to the model
  });

  pi.on("session_tree", async () => {
    pushStatus(true); // context usage belongs to the active branch
  });
```

Forced, because the status itself did not change and a normal push would be
skipped as a duplicate.

`README.md`, Internals → Agent Lifecycle Integration, after the `session_compact`
bullet:

```markdown
- **`model_select`** → Force-pushes a `status_update`: the context window, and so the usage percentage, belongs to the model.
- **`session_tree`** → Force-pushes a `status_update`: context usage belongs to the active branch.
```

and in the paragraph below, "including a forced post-compaction update" →
"including forced updates after a compaction, a model change and tree navigation".

`CHANGELOG.md`, Unreleased → Fixed:

```markdown
- **Peers see a terminal's context usage change after a model switch or tree navigation.** A terminal now republishes its context when its model changes or it moves to another branch of the session tree. Before, an idle terminal kept showing its previous figure until its next run.
```

## Check

Before edits, run each of the five existing `test/*-test.mjs` suites with
`node` from the package directory; all must pass. A separate one-off check
based on the connection-ownership mock harness must fail its new assertions against the
unmodified code (known-answer negative control), then pass after the change:
change what `getContextUsage` returns and emit each event separately. Confirm
one `status_update` per event with the new context and unchanged status kind
and `since`. When disconnected, neither event sends a frame. Re-run the five
existing suites after edits and inspect the actual README/CHANGELOG diff and
line endings. The one-off check verifies extension wiring in a mock, not live
Pi event timing or a real multi-terminal mesh.
