# PLAN — Review Follow-ups (index.ts)

Fresh review pass after all 7 items from `PLAN-code-review-refinements.md` landed
(verified applied in current code). Gates green at review time:
`node test/cli-flags-test.mjs` → 40/40; esbuild bundle check clean.

**Nature:** one genuine defect (#1, cosmetic + machine-contract); the rest are
small consistency/robustness items and one comment-only note.
No performance problems found. The "Explicitly out of scope" rulings from the
previous plan still hold and are extended below.

Line numbers are from the current revision; re-locate by the anchors given.

## Decisions (resolved 2026-06-09, owner)

- **#5 → guard.** `link_send` rejects self-target, mirroring `link_prompt` /
  `link_compact`. Plus one README sentence.
- **Bare `pi-link` stays exit 0.** The no-args invocation doubles as the help
  shortcut; former item #7 dropped to "Noted, no action".
- **#3 abort check goes first** — before even the `role === "disconnected"`
  guard.
- **No version bump or CHANGELOG edits in this plan.** Versioning is handled by
  hand separately (next version), per the standing roadmap convention.
- **Functional/live testing is out of scope.** Per-item _Verify_ lines below
  define expected behavior only; executing them is a later, separate
  workstream. The only gates run during implementation are the mechanical ones
  in "Sequencing".

With these resolved, the plan is implementation-ready: all changes land in
`index.ts` plus one README line. `bin/pi-link.mjs` and `test/` are untouched.

---

## #1 — `notConnectedResult()` omits `details.error` → failures render as ✓ (DEFECT)

**Where:** `notConnectedResult`, index.ts ~1319. Used by all four tools
(~1376, 1442, 1540, 1655).

**Problem:** every other failure path sets `details.error` (`not_found`,
`self_target`, `timeout`, `not_delivered`, `aborted`, …) and both renderers key
on it:

- `renderIconResult` → `link_send` / `link_compact` while disconnected display
  **`✓ Not connected to link`** with the success icon.
- `link_prompt.renderResult` → takes the success branch and displays
  **`✓ [unknown] Not connected to link`**.

It also breaks the machine-readable contract: an LLM inspecting `details` sees
no error marker on this one failure class.

**Fix:**

```ts
function notConnectedResult() {
  return textResult("Not connected to link", { error: "not_connected" });
}
```

(`link_list`'s renderResult falls back to plain text when `details.terminals`
is absent — unaffected.)

**Risk:** none (failure path only; text unchanged).
**Verify:** with link disconnected, `link_send` / `link_prompt` / `link_compact`
render `✗ Not connected to link`; `details.error === "not_connected"`.

---

## #2 — `shouldConnect(_ctx)` dead parameter (nit)

**Where:** index.ts ~436 (definition), ~1240 (call site in `session_start`).

**Problem:** the body uses only `latestCustomData` and `pi.getFlag`; `_ctx` is
never read. It predates the `latestCustomData` extraction (which closes over
module `ctx`). A parameter that does nothing invites the wrong inference —
that connection intent is context-dependent.

**Fix:** drop the parameter and the argument:

```ts
function shouldConnect(): boolean { ... }
// session_start:
if (flagName || shouldConnect()) scheduleStartupConnect();
```

**Risk:** none.

---

## #3 — No pre-aborted `signal` check in `link_prompt` / `link_compact` (robustness)

**Where:** index.ts ~1475 (`link_compact` abort listener), ~1577 (`link_prompt`
abort listener); the check goes **first** in each `execute`, before even the
`role === "disconnected"` guard (decided): an aborted call's result is
discarded by the caller anyway, so `aborted` is the most truthful outcome when
multiple error conditions apply.

**Problem:** `signal?.addEventListener("abort", ..., { once: true })` never
fires if `signal.aborted` is already `true` when `execute` runs (the event was
already dispatched). A pre-aborted call then burns the full timeout
(90 s inactivity / 180 s flat) instead of resolving instantly — against the
file's own fail-fast convention.

**Fix:** as the first statement of each tool's `execute`:

```ts
// link_prompt
if (signal?.aborted)
  return textResult("Prompt request aborted", {
    to: params.to,
    error: "aborted",
  });
// link_compact
if (signal?.aborted)
  return textResult("Compact request aborted", {
    to: params.to,
    error: "aborted",
  });
```

(Reuse the exact strings/details of the existing abort-listener results so both
abort paths are indistinguishable to callers.)

**Risk:** none (new early-exit on a path that today only wastes time).
**Verify:** code inspection; normal abort mid-wait still resolves as `aborted`.

---

## #4 — Hub accepts duplicate `register` on the same socket (robustness)

**Where:** `hubHandleClient`, index.ts ~850 (`if (msg.type === "register")`).

**Problem:** a second `register` from an already-registered socket is processed
as a fresh registration: `hubClients.set` overwrites the name, but the _old_
name's entries in `hubTerminalStatuses` / `hubTerminalContexts` /
`hubTerminalCwds` linger until socket close (whose cleanup deletes by the _new_
name only), and no `terminal_left` is broadcast for the old name. The pi-link
client never re-registers on a live socket, so this is protocol-misuse
robustness only — but the hub already guards the inverse case (non-`register`
from unregistered clients), and the symmetric guard is one line:

```ts
if (msg.type === "register") {
  if (clientName) return; // already registered — ignore duplicate
  ...
```

**Risk:** none (rejects a message sequence the real client never produces).
**Verify:** normal join/leave still broadcasts `terminal_joined` /
`terminal_left` exactly once.

---

## #5 — `link_send` rejects self-target (DECIDED: guard)

**Where:** `link_send` execute, index.ts ~1376ff.

**Problem:** `link_prompt` and `link_compact` both reject
`to === terminalName`; `link_send` silently routes a message to yourself. With
`triggerTurn:true` it lands in your own idle-gated inbox and fires after the
current run — an undocumented "remind me later" behavior. Asymmetry by
accident.

**Fix:** mirror the other tools. Place the guard **inside** the existing
`params.to !== "*"` block, before the `targetNotFound` check (gpt review,
2026-06-09: keeps broadcast semantics reserved/unchanged even if a terminal
somehow ends up named `"*"`):

```ts
if (params.to !== "*") {
  if (params.to === terminalName)
    return textResult("Cannot send to yourself", {
      to: params.to,
      error: "self_target",
    });
  const miss = targetNotFound(params.to);
  if (miss) return miss;
}
```

**README:** add one sentence to `### link_send` noting self-target is rejected,
matching the wording already used for `link_prompt` / `link_compact`.

**Risk:** low — changes behavior only for a call pattern with no known users.
**Verify:** `link_send` to own name returns `error: "self_target"`; broadcast
still delivers to all others.

---

## #6 — Keepalive presumes `sendUserMessage` starts a run (comment only)

**Where:** `prompt_request` handling, index.ts ~775–785 (keepalive setup,
`KEEPALIVE_INTERVAL_MS`).

**Problem (documented, not fixed):** `pendingRemotePrompt` is set, the 30 s
keepalive starts, then `pi.sendUserMessage(...)` is called. Everything
downstream assumes `agent_start`/`agent_end` follow. If a run never
materializes (platform regression), the target stays busy forever **and** the
keepalive keeps resetting the sender's inactivity timer — so the sender waits
the 30-minute ceiling instead of 90 s. The keepalive reports "alive" when the
honest answer is "stuck".

A watchdog is **not** warranted today — `sendUserMessage` triggering a turn is
a platform contract, and the hard ceiling recovers the sender. Make the
assumption discoverable instead:

```ts
// Keepalive presumes sendUserMessage() starts a run (platform contract);
// if it ever doesn't, the sender's 30 min hard ceiling is the backstop.
```

**Risk:** none (comment).

---

## Noted, no action

- **Bare `pi-link` prints help and exits 0:** deliberate (owner decision,
  2026-06-09) — the no-args invocation doubles as the help shortcut. Behavior
  and test case `E32: no args` stay as-is.
- **`displayPath` slash inconsistency (CLI):** home-relative paths render with
  `/`, non-home Windows paths keep `\`. Cosmetic, `--list --global` only.
- **Full-file JSONL scans in `--list`/`--resolve`:** necessary (last-wins
  `link-name`, message counts) and fine at current scale. O(total session
  bytes); revisit only if session dirs reach hundreds of multi-MB files.

---

## Explicitly out of scope (examined this pass; leave as-is)

Extends the standing rulings in `PLAN-code-review-refinements.md`:

- **RPC pending machinery** (`pendingPromptResponses` vs
  `pendingCompactResponses`): prior ruling holds. Different timer topologies
  (resettable inactivity + ceiling vs flat), different response shapes
  (`response/error` vs `ok/reason`), different cleanup text. A generic
  `awaitRemote()` would hide debugging-relevant behavior.
- **`hubClientByName` linear scan:** a reverse `name → ws` Map is redundant
  mutable state to keep in sync for ~2–10 terminals. Single source of truth
  (`hubClients`) wins.
- **Six role-split maps** (`terminal*` vs `hubTerminal*`) + the three
  `getXFor` selectors: the split encodes real ownership (hub-authoritative vs
  replicated snapshot); the `role !== "hub"` guards depend on it. A merge would
  introduce a clearing hazard at client→hub promotion (`startHub` doesn't clear
  client-era maps — today an invisible few-hundred-byte hold, post-merge it
  would be _visible stale data_). Current shape is the easier one to reason
  about.
- **Closure-state single-file architecture:** idiomatic for Pi extensions;
  section banners + README state table keep it navigable. Splitting forces a
  threaded context object or exported mutable state — both worse.
- **`process.exit(1)` on empty `--link-name` in `session_start`:** startup-time
  flag validation; mirrors the CLI wrapper. The alternative (notify + continue
  with a random name) hides user error.
- **Rename-as-left+joined on hub rename:** a `terminal_renamed` wire message
  would be a 12th type serving a cosmetic notification difference. Documented
  limitation; correct trade.

---

## Sequencing

1. **Pass A (behavior-identical / failure-path only):** #1, #2, #6.
2. **Pass B (small behavior additions):** #3, #4.
3. **Pass C:** #5 guard + the one-line README addition.

No version bump, no CHANGELOG edits, no test-file changes (see Decisions).
Functional/live verification is deferred to a later testing workstream.

**Gate after each pass (mechanical regression only):**

```
npx --yes esbuild index.ts --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:ws --external:typebox \
  --external:node:* --outfile=/tmp/pi-link-check.mjs
node test/cli-flags-test.mjs
```
