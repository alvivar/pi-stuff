# PLAN — Post-review cleanup: dead defense, one roster map set, narrower contracts

> **Status:** Approved by owner — ready to build
> **Baseline:** HEAD 3ec03ac (groups feature at 74e732f, product 0.4.1 unpublished).
> Re-base line anchors when dispatching; they are given for HEAD 3ec03ac.
> **Origin:** fable's full review of `index.ts`, `bin/pi-link.mjs` and the five test
> suites, cross-checked by archon (REVIEW FEEDBACK). Every item below is one both
> reviewers agree on, or one the owner decided after hearing both positions.
> **Gate at baseline:** 462/462 across the five suites, no port bound.

## Summary

Four independent lots. **A** removes lines that defend against nothing reachable.
**B** merges the two per-role roster map sets into one and, in doing so, fixes a
latent bug that today only sleeps (stale peer metadata surviving a client→hub
promotion). **C** narrows the Pi version check to stable releases, an owner
decision. **D** narrows the `--status` payload validation to the fields the CLI
consumes, an owner decision. One test moves from a fixed sleep to the harness's
wait. No wire change, no new state, no new parameters anywhere.

Owner's bar for every line: simple, readable, idiomatic; every line justifies its
cost; abstractions only when essential; no defensive code without clear value;
tests only when fundamental.

## Decisions already taken (do not reopen)

- **Hub-rename test stays** (`connection-ownership-test.mjs` block 12, "the lens
  reads the current name"). Owner keeps it as archon's evidence that the lens is
  live on the same instance.
- **`builder → builder-2` collision row stays**: it is the only plain-name
  collision in the suite and the only input exercising `at === -1` in `uniqueName`.
- **Renderer `details.from ?? "link"` stays**: `/resume` re-renders persisted
  custom messages with the current code; older sessions carry `details.from`. This
  is reading own valid data, not mixed-version wire. Tests 1 and 6c stay.
- **Pi support is stable releases only** (`x.y.z`). Prereleases and build metadata
  are refused with a message naming the accepted format (lot C).
- **`--status` validates consumed fields only**; the shape invariants that draw
  nothing (hub-first order, `terminals[0].name === hub`, numeric `port`, non-empty
  list) are dropped, and `--json` therefore no longer guarantees them (lot D).

---

## Lot A — Dead defense (one commit, no decisions)

Every line here was verified unreachable under the supported contract by both
reviewers. Remove the line and its comment; add nothing.

| # | Site (HEAD 3ec03ac) | Change | Why it is dead |
|---|---|---|---|
| A1 | `captureContext` ~374 | Delete `if (typeof ctx.getContextUsage !== "function") return undefined; // older Pi` | `getContextUsage` exists in the 0.84.2 floor (verified in the tarball); anything older is refused at load. |
| A2 | `formatContext` ~451 | `if (!c) return "";` — drop `\|\| c.contextWindow <= 0` and its comment | The only producer, `captureContext`, already refuses `contextWindow <= 0`. Same version everywhere. |
| A3 | `agent_start` ~1477 | Delete `activeTools.clear(); // defensive: …` | Pi emits `agent_end` on normal, error and abort endings and forbids overlapping runs (archon read pi-agent-core 0.85.1); `agent_end` ~1528 already clears and always precedes. Keep the `agent_end` clear. |
| A4 | `terminal_left` ~847–858 and `disconnect` ~1339–1346 | In both synchronous loops: `cleanupPendingCompact(id); pending.resolve(…)` using the entry already in hand; drop `const p = …; if (p)` / `const pending = …; if (pending)` | The entry was just read from the map; cleanup cannot miss it. Do **not** change `cleanupPendingCompact`'s return type and do not add `!`: the timeout, abort and `!delivered` callers still need the null check. |
| A5 | `connection-ownership-test.mjs` ~1000 (groups case 1) | Replace `await new Promise((r) => setTimeout(r, 300));` with `await until(() => t.delivered.length > 0, "the flush");` | The two `receive` calls are synchronous before the flush; waiting for the delivery is the relevant synchronization. Keep both assertions as they are: the same-group content **and** sender present, the cross-group content absent, on the same batch. |

Not in scope for A5: the other `setTimeout(r, 300)` at ~518 (case 6, pre-existing)
is a negative-only wait with no positive control to await; leave it.

**Gate:** all five suites green; check counts unchanged except none (no assertions
are removed in lot A).

---

## Lot B — One roster map set (one commit, own test)

### Fact

`terminalStatuses/terminalCwds/terminalContexts` (~253–256) and
`hubTerminalStatuses/hubTerminalContexts/hubTerminalCwds` (~264–266) never hold
data in the same role: on the hub the client set is always empty (welcome only
reaches clients; hub `status_update` never passes `handleIncoming`;
`terminal_joined` writes under `role !== "hub"`), on a client the hub set is always
empty. The split costs three role-branching getters (~458–475), six clears in
`disconnect()` (~1366–1371), two role conditions in `terminal_joined`/`terminal_left`
(~831–845), and in hub `register` two early `set`s of the newcomer (~985–986) plus
three `name !== clientName` filters (~995, ~1000, ~1006) so the newcomer is not
handed its own metadata in `welcome`.

### Latent bug this lot fixes (archon's counterexample, verified)

The client socket's spontaneous `close` (~1220–1232) resets `ws`, `role` and
`connectedTerminals` but **not** the three client maps; `startHub` does not clear
them either. Path: client loses its hub → reconnect → wins the election → hub with
the previous network's metadata still populated. Today it sleeps under the
role-branching getters. With one map set it would become authoritative: `welcome`
would carry stale snapshots, and `/status` would report a stale status for a
re-registering name before its first `status_update` — the false inventory the
endpoint exists to remove. So the merge **requires** B1.

### Tasks

- **B1. Clear on client close.** In the `close` handler ~1226, next to
  `connectedTerminals = [];`, clear the three maps. This is the fix regardless of
  the merge; it is what makes "state is reset on role change" true.
- **B2. One set.** Keep `terminalStatuses`, `terminalCwds`, `terminalContexts`
  (names and comments: "other terminals"). Delete the `hubTerminal*` trio. The hub
  writes them in `hubHandleClient` (`status_update` ~1036–1037 and `close`
  ~1068–1071); the client writes them in `handleIncoming`.
- **B3. Getters without a role branch.** `getStatusFor/getCwdFor/getContextFor`
  become `name === terminalName ? <local truth> : map.get(name) ?? null`.
- **B4. `terminal_joined`/`terminal_left` without role conditions.** Drop the
  `role !== "hub"` guards; the hub's self-delivery through `hubBroadcast` now writes
  and deletes peer metadata like a client's does. Writes are idempotent.
- **B5. Hub `register` builds `welcome` before the newcomer's metadata exists.**
  Order: `clientName = uniqueName(msg.name); hubClients.set(clientWs, clientName);
  const list = terminalList();` — the socket **must** be in `hubClients` before
  `terminalList()` or the newcomer is missing from its own roster — then build
  `statuses/cwds/contexts` from the maps with no filter (the newcomer is not in
  them yet), send `welcome`, then `hubBroadcast(joined, clientName)`. The hub's
  self-delivery of `terminal_joined` writes the newcomer's `cwd`/`context`, sets
  `connectedTerminals`, calls `updateStatus()` and shows the toast. Delete the two
  early `set`s, the three filters, and the now-redundant
  `connectedTerminals = list; updateStatus();` (~988–989).
- **B6. Hub `close` handler.** Same reasoning: `hubClients.delete`, then
  `terminalList()`, then `hubBroadcast(left, name)`; self-delivery of
  `terminal_left` deletes the metadata, sets `connectedTerminals` and calls
  `updateStatus()`. Delete the three direct deletes and the direct
  `connectedTerminals = list; updateStatus();` (~1073–1074).
- **B7. `disconnect()`** clears three maps, not six. **`buildStatusPayload`** is
  unchanged: it reads through the getters.
- **B8. Hub `/link-name`** (~1937): unchanged. It broadcasts with `excludeName =
  terminalName`, so it keeps its own direct `connectedTerminals = list;
  updateStatus();` — that pair is *not* redundant there.

### Test (fundamental, one block in `connection-ownership-test.mjs`)

Promotion with populated metadata. A client is welcomed with `statuses`, `cwds`
and `contexts` for peers `p` and `q`; the hub socket then `peerClose`s; the
reconnect dial fails (`failDial`); the server phase `listening` commits the hub.
Then a socket registers as `p` **without** `cwd` or `context`. Assert:
- the `welcome` sent to `p` has no `p` key and no `q` key in `statuses`, `cwds`,
  `contexts` (the old network is gone);
- `buildStatusPayload` — read through `GET /status` on the stub http server, as
  block 11 already does — describes `p` with no `status`, no `cwd`, and
  `context: null`.
Then a second socket registers as `r` **with** `cwd` and `context`; assert `r`'s
`welcome` does not contain `r`'s own cwd/context (B5), and that a later `link_list`
on the hub shows `r`'s cwd (self-delivery wrote it). Positive control: after `r`
sends one `status_update`, `/status` reports it.

This kills: a merge without B1 (stale `q`/`p` survive), a `register` that inserts
metadata before building `welcome` (own cwd echoed), and a dropped self-delivery
write (hub never learns `r`'s cwd).

**Gate:** all five suites green; block 11's "hub first, then clients sorted by
name" and every existing welcome/roster assertion unchanged.

---

## Lot C — Stable-release version check (one commit; owner decision taken)

Fact: the npm registry lists zero prerelease versions of
`@earendil-works/pi-coding-agent`. `piVersionSupported` (~140–159) pays for full
SemVer (prerelease precedence, build metadata, leading zeros, `isSafeInteger`) plus
a ten-line docblock, and suite A of `lifecycle-compact-test.mjs` (~221–262) spends
21 cases on it, 12 of them on suffix grammar.

- **C1.** Replace with: match `^(\d+)\.(\d+)\.(\d+)$` on `version.trim()`, compare
  the three numbers in order against `MIN_PI_VERSION`. Anything else is refused.
  Docblock: two or three lines — "stable releases only; a prerelease or build
  suffix is refused, not guessed at".
- **C2.** Error message (~208–211): it must not say "upgrade" to a version that may
  be newer. Wording: `pi-link requires a stable Pi release >=0.84.2 (detected
  ${PI_VERSION || "unknown"}); pi-link 0.2.x supports Pi 0.74–0.84.1.` Keep the
  throw as the first statement of the factory.
- **C3.** Suite A: keep exactly the floor, one below on each component, one above
  on each component, one malformed, the empty string, and **one suffixed version
  refused** (`0.85.0-beta.1 → false`) so the contract is pinned. Keep the second
  check that the error names the floor and the detected version. Drop the grammar
  rows.
- **C4.** README: where the floor is stated, add "stable releases only" in the same
  sentence. No new section.

**Gate:** suite A count drops; every other suite unchanged.

---

## Lot D — `--status` validates what it prints (one commit; owner decision taken)

Fact: `isContextField/isTerminalEntry/isStatusPayload` (`bin/pi-link.mjs`
~625–661) check every field's type **and** shape invariants the table never uses.
`--status` is a diagnostic: the user runs it precisely when unsure what answers on
the port (another app, a misdirected `PI_LINK_PORT`), so a `200` with foreign JSON
is a realistic input and must print the unsupported message, never a stack trace
(archon's case; kept). Validation therefore stays for the **fields consumed** and
goes for the rest.

- **D1. Keep** (these are read by the renderer or `formatTerminalStatus`/
  `formatContext`): `payload.terminals` is an array; each entry is a non-array
  object with `name` string; if `status` is present it is a non-empty string and
  `sinceSeconds` is a number (the pair rule is what `formatTerminalStatus` relies
  on); `cwd`, if present, is a string; `context` is `null` or `{tokens: number|null,
  window: number}`.
- **D2. Drop**: `payload.hub` string check, `payload.port` number check, the
  non-empty-list rule, the `role` per-index check (`hub` first, `client` after) and
  `terminals[0].name === payload.hub`. None of them changes a printed cell.
  Delete the comment paragraphs that justified them. Keep the "shape, not
  vocabulary" note for `status` — it is the one rule still enforced.
- **D3.** The renderer comment "Payload order is meaningful…" (~730) goes; the CLI
  prints rows in the order received, which is what it already did.
- **D4.** `cli-flags-test.mjs` `MALFORMED` (~505–520): keep one fixture per class
  that still fails — a null row, a row missing `name`, a non-string `cwd`, half of
  the status pair, a non-numeric `sinceSeconds`, an empty status string, a context
  missing `window`, a JSON array (not an object). Remove: empty terminal list,
  row missing `role`, client in hub slot, hub in client slot, first row not the
  named hub, non-numeric `port`. Where a removed fixture was the only coverage of
  the *accepted* path, move it to the accepted side (e.g. an empty list now
  renders an empty table).
- **D5.** README `--status --json` paragraph (~376–390): drop any sentence that
  promises hub-first order or `terminals[0].name === hub` as a contract; state
  that `--json` writes the hub's body verbatim and the CLI checks only what it
  prints. If no such promise exists in the text, no change.

**Gate:** suite J count drops; `--status` table output for the existing valid
fixture byte-identical.

---

## Order and commits

1. **Lot A** — smallest, no decisions, warms the gate.
2. **Lot B** — B1 first as its own hunk (it is a fix), then the merge; one commit
   with the new test block.
3. **Lot C**, then **Lot D** — independent of each other; either order.
4. CHANGELOG under Unreleased, one line per lot: fix (B1), refactor (B), change
   (C: stable-only floor), change (D: `--json` invariants no longer checked).
   Version and publish are the owner's.

Each lot: full gate before commit. Review by fable after each lot or after all,
owner's choice.

## Out of scope

- The `routeMessage` guard shape (`crossGroup ? undefined : …` → one `if` block):
  optional nit; do only if `routeMessage` is edited for another reason. It is not.
- Anything touching wire format, session persistence, groups semantics, or the
  compaction lifecycle.
- New helpers, new constants, new settings.

## Kept on purpose

- `agent_end`'s `activeTools.clear()`: an unmatched `tool_execution_end` would pin
  the status; this is the clear with a cause.
- `cleanupPendingCompact`'s nullable return and the null checks at the timeout,
  abort and `!delivered` sites: a response can genuinely arrive after resolution.
- The `if (!c)` in `formatContext`: absent context is a normal value.
- `response.ok` → unsupported in `runStatus`: an old hub answers 426; this is the
  version check that matters for the CLI.
- The two `setTimeout(r, 200/300)` waits that guard negative-only assertions in
  pre-existing ownership cases: there is no positive event to await there.
