# PLAN — Post-review cleanup: dead defense, one roster map set, narrower contracts

> **Status:** Implemented — lots A–D; execution record below.
> **Baseline:** HEAD 3ec03ac (groups feature at 74e732f, product 0.4.1 unpublished).
> Re-base line anchors when dispatching; they are given for HEAD 3ec03ac.
> **Origin:** fable's full review of `index.ts`, `bin/pi-link.mjs` and the five test
> suites, cross-checked by archon (REVIEW FEEDBACK). Every item below is one both
> reviewers agree on, or one the owner decided after hearing both positions.
> **Gate at baseline:** 462/462 across the five suites. No use of the live mesh
> on port 9900: CLI fixtures use isolated servers on ephemeral loopback ports;
> the ownership harness simulates the transport in memory.

## Summary

Four independent lots. **A** removes lines that defend against nothing reachable.
**B** merges the two per-role roster map sets into one, discarding snapshots on
client connection loss so the refactor does not reuse stale metadata after a
client→hub promotion. **C** narrows the Pi version check to stable releases, an owner
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
- **`--status` validates consumed fields only**; checks of shape invariants that
  draw nothing (hub-first order, `terminals[0].name === hub`, numeric `port`,
  non-empty list) are dropped. A successful `--json` invocation no longer
  certifies them; the hub's payload contract remains unchanged (lot D).

---

## Lot A — Dead defense (one commit, no decisions)

Every line here was verified unreachable under the supported contract by both
reviewers. Remove the line and its comment; add nothing.

| # | Site (HEAD 3ec03ac) | Change | Why it is dead |
|---|---|---|---|
| A1 | `captureContext` ~374 | Delete `if (typeof ctx.getContextUsage !== "function") return undefined; // older Pi` | `getContextUsage` exists in the 0.84.2 floor (verified in the tarball); anything older is refused at load. |
| A2 | `formatContext` ~451 | `if (!c) return "";` — drop `\|\| c.contextWindow <= 0` and its comment | The only producer, `captureContext`, already refuses `contextWindow <= 0`. Same version everywhere. |
| A3 | `agent_start` ~1477 | Delete `activeTools.clear(); // defensive: …` | Pi emits `agent_end` on normal, error and abort endings and forbids overlapping runs (archon read pi-agent-core 0.85.1); `agent_end` ~1528 already clears and always precedes. Keep the `agent_end` clear. |
| A4 | `terminal_left` ~847–858 and `disconnect` ~1339–1346 | Use `for (const [id, pending] of pendingCompactResponses)` in both synchronous loops; `disconnect()` currently iterates a copy of the keys and must switch to entries. Then `cleanupPendingCompact(id); pending.resolve(…)`; drop the second lookup result and its guard. | Deleting the current Map entry during iteration is valid; there is no `await` between capturing and using it. Do **not** change `cleanupPendingCompact`'s return type, add another `get` or add `!`: the timeout, abort and `!delivered` callers still need the null check. |
| A5 | `connection-ownership-test.mjs` ~1000 (groups case 1) | Replace `await new Promise((r) => setTimeout(r, 300));` with `await until(() => t.delivered.length > 0, "the flush");` | The two `receive` calls are synchronous before the flush; waiting for the delivery is the relevant synchronization. Keep both assertions as they are: the same-group content **and** sender present, the cross-group content absent, on the same batch. |

Not in scope for A5: the other `setTimeout(r, 300)` at ~518 (case 6, pre-existing)
is a negative-only wait with no positive control to await; leave it.

**Gate:** all five suites green; check counts unchanged except none (no assertions
are removed in lot A).

---

## Lot B — One roster map set (one commit, own test)

### Fact

The getters select `terminalStatuses/terminalCwds/terminalContexts` (~253–256)
when running as a client and `hubTerminalStatuses/hubTerminalContexts/hubTerminalCwds`
(~264–266) when running as a hub. The inactive set is not necessarily empty:
client snapshots can survive a promotion without being used by the hub getters.
The split costs three role-branching getters (~458–475), six clears in
`disconnect()` (~1366–1371), two role conditions in `terminal_joined`/`terminal_left`
(~831–845), and in hub `register` two early `set`s of the newcomer (~985–986) plus
three `name !== clientName` filters (~995, ~1000, ~1006) so the newcomer is not
handed its own metadata in `welcome`.

### Regression the merge must prevent

The client socket's spontaneous `close` (~1220–1232) resets `ws`, `role` and
`connectedTerminals` but **not** the three client maps; `startHub` does not clear
them either. Path: client loses its hub → reconnect → wins the election. The
current hub getters ignore those old client snapshots. A merge without clearing
would make them authoritative: `welcome` would carry stale snapshots and `/status`
would report stale metadata for a re-registering name before its first update.

Archon verified this sequence with the existing harness and in-memory source
variants: current code reports unknown metadata correctly; a merge without B1
reuses old status/cwd/context; adding B1 restores the current behavior. No product
files were modified and no live mesh was used. B1 is therefore required to prevent
a regression introduced by the refactor, not a separately shipped bugfix.

### Tasks

- **B1. Clear on client close.** In the `close` handler ~1226, next to
  `connectedTerminals = [];`, clear the three maps. This discards the previous
  connection's snapshots before reconnect or promotion can reuse the unified set.
- **B2. One set.** Keep `terminalStatuses`, `terminalCwds`, `terminalContexts`
  (names and comments: "other terminals"). Delete the `hubTerminal*` trio. The hub
  writes status updates in `hubHandleClient` (~1036–1037); both roles apply
  membership metadata changes in `handleIncoming` through B4–B6.
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
sends one `status_update`, `/status` reports it. In the same block, close `r`'s
socket and register a new socket as `r` without metadata. Assert that its `welcome`
has no old `r` entry in the three snapshots and `/status` reports no status or cwd
and `context: null`. Merely checking that the disconnected row disappears would
not prove cleanup: the roster could exclude it while the maps retain its data.

This kills: a merge without B1 (stale `q`/`p` survive), a `register` that inserts
metadata before building `welcome` (own cwd echoed), a dropped self-delivery write
(hub never learns `r`'s cwd), and missing cleanup after B6 moves deletion to
`terminal_left` (reusing `r` inherits old metadata). No extra harness or matrix.

**Gate:** all five suites green; block 11's "hub first, then clients sorted by
name" and every existing welcome/roster assertion unchanged.

---

## Lot C — Stable-release version check (one commit; owner decision taken)

Fact: the npm registry lists zero prerelease versions of
`@earendil-works/pi-coding-agent`. `piVersionSupported` (~140–159) pays for full
SemVer (prerelease precedence, build metadata, leading zeros, `isSafeInteger`) plus
a ten-line docblock, and suite A of `lifecycle-compact-test.mjs` (~221–262) includes
many suffix-grammar cases that the narrower contract no longer needs.

- **C1.** Replace with: match `^(\d+)\.(\d+)\.(\d+)$` on `version.trim()`, compare
  the three numbers in order against `MIN_PI_VERSION`. Anything else is refused.
  Docblock: two or three lines — "stable releases only; a prerelease or build
  suffix is refused, not guessed at".
- **C2.** Error message (~208–211): it must not say "upgrade" to a version that may
  be newer. Wording: `pi-link requires Pi >=0.84.2 in x.y.z format, without suffixes
  (detected ${PI_VERSION || "unknown"}); pi-link 0.2.x supports Pi 0.74–0.84.1.`
  Build metadata can belong to a stable SemVer release, so "stable" alone would
  not explain its rejection. Keep the throw as the first statement of the factory.
- **C3.** Suite A: keep the floor; below-floor minor and patch; above-floor major,
  minor and patch; one malformed input; the empty string; and two suffix refusals:
  `0.85.0-beta.1 → false` and `0.84.2+build.1 → false`. These pin the two restrictions
  without retaining a grammar matrix. There is no valid major below the floor's
  zero: do not invent a negative major as an ordering case. Keep the checks that
  refusal precedes all registrations and the error names the floor and detected
  version. Drop the other grammar rows.
- **C4.** README: where the floor is stated, add "stable releases only, in x.y.z
  format without suffixes" in the same sentence. No new section.

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
  object with `name` string; `status` and `sinceSeconds` are either both present or
  both absent. When present, `status` is a non-empty string and `sinceSeconds` is
  a number; preserve the pair check in both directions. `cwd`, if present, is a
  string; `context` is `null` or `{tokens: number|null,
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
- **D5.** README `--status` / scripting documentation: preserve the hub's payload
  description, including hub-first order, sorted clients and the structural fields.
  The producer is unchanged. Clarify that `--json` writes the response body
  verbatim and the CLI validates the fields needed for its table, not the remaining
  structural invariants. A successful CLI exit no longer certifies those invariants
  or hub origin: a different service can return the same printable shape. Narrow
  nearby validator comments, README exit-code prose and changelog claims accordingly:
  incompatible consumed fields are rejected, not every foreign service's JSON.
  Do not present weaker validation as a changed wire contract.

**Gate:** suite J count drops; `--status` table output for the existing valid
fixture byte-identical.

---

## Authorized run

Owner go: **"Implementer, reviewer y committer son los aprobados. Designer queda
fuera hasta que yo lo use personalmente. Contexto saludable entre turnos 200k.
Go, run through!"**

- Mode: run-through, serial A → B → C → D; no separate owner approval before each
  commit. Material changes or unresolved required gates still require escalation.
- Roles: `implementer@pi-link`, `reviewer@pi-link`, `committer@pi-link`.
  Designer/Fable is not a participant in this run. Archon coordinates and owns
  plan/ledger updates; workers do not delegate to each other.
- Repository: `C:/Users/andre/.pi`; product: `agent/workshop/pi-link`.
  Starting branch/HEAD: `master`, `8dc5d86fbd4b56d36a8504c1304c39b5f8eaca4f`.
  Worktree and index were clean before this execution addendum. Earlier review
  amendments are already committed in that HEAD, not pre-existing dirt.
- Context: use the owner's 200K healthy-context reference between stages, keeping
  reserve for repairs and handoffs. Compact before engagement when needed, not an
  engaged worker before its task's commit. Fresh post-compaction `?` is not a hold.

### Exact task paths

Paths below are relative to the product directory. Each commit includes its
relevant `CHANGELOG.md` update. Only Archon edits this plan; authorized execution
amendments to it accompany the affected implementation commit (execution addendum
in A; implementation record and status closeout in D).

| Lot | Implementer may edit |
|---|---|
| A | `index.ts`, `test/connection-ownership-test.mjs`, `CHANGELOG.md` |
| B | `index.ts`, `test/connection-ownership-test.mjs`, `CHANGELOG.md` |
| C | `index.ts`, `test/lifecycle-compact-test.mjs`, `README.md`, `CHANGELOG.md` |
| D | `bin/pi-link.mjs`, `test/cli-flags-test.mjs`, `README.md`, `CHANGELOG.md` |

Temporary run state: `LEDGER-review-cleanup.md` beside this plan; never stage it,
remove it when the run closes, and retain this tracked plan. No version/lockfile,
dependency, installation, reload, publication or live-mesh work is authorized.

### Required verification for every lot

The implementer checks branch/HEAD, full worktree and staged state, then runs the
baseline before edits. Unexpected staging or a red baseline blocks edits. Run the
same full gate after changes, from `C:/Users/andre/.pi/agent/workshop/pi-link`:

```sh
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs
node test/lifecycle-compact-test.mjs
node test/connection-ownership-test.mjs
node test/inbox-fixed-window-test.mjs
node test/message-renderer-test.mjs
git diff --check
```

Report each command's result and suite counts, not just an aggregate. Ownership
loads the real TypeScript extension with simulated transports; lifecycle covers
the compatibility gate and compact handling; inbox covers batching; renderer
covers rendering seams; CLI covers flag/status behavior with isolated subprocesses
and ephemeral HTTP fixtures. Report whether the installed native pi-tui block ran;
its availability-dependent evidence is not a live Pi UI or full SDK E2E test.
A1/A3's API/lifecycle assumptions also require reviewer source inspection of the
supported Pi contract, not a claim that the stub suites prove Pi's own lifecycle.
Preserve each lot's additional assertions and evidence requirements above. No new
live checks or dependency downloads are required. Record coverage limitations.

## Order and commits

1. **Lot A** — smallest, no decisions, warms the gate.
2. **Lot B** — B1 and the merge together; one refactor commit with the new test
   block. B1 prevents a regression from the merge, not a current behavior bug.
3. **Lot C**, then **Lot D** — independent of each other; either order.

Before each dispatch, pin the current HEAD, exact allowed paths and required gate.
For each lot: implement, run the full gate, obtain independent review by
`reviewer@pi-link`, resolve findings, then commit before starting the next lot. Do not defer review
until after the commits.

Include the relevant Unreleased changelog update in each lot's commit, not as a
final catch-up step. Describe A/B as simplification or refactoring, not a `Fixed`
entry for B1; C changes accepted Pi versions and D changes CLI validation. Keep
notes concise: no forced entry per micro-adjustment, and related refactoring notes
may be consolidated. Version and publication remain the owner's decisions.

## Implementation record

| Lot | Commit | Post-implementation full-suite result |
|---|---|---|
| A | `0595e67` | 462 passed, 0 failed; existing assertions unchanged |
| B | `01818af` | 470 passed, 0 failed; eight fundamental ownership checks added |
| C | `145e342` | 454 passed, 0 failed; redundant version-grammar rows removed |
| D | This closeout commit | 444 passed, 0 failed; six invalid-shape fixtures removed from two modes, two accepted-path checks added |

Each lot also passed CLI syntax and diff checks. The native pi-tui block ran.
For D's existing valid status fixture, baseline and changed CLI outputs were
byte-identical in table and JSON modes against the same isolated stub server.
That comparison covers the fixture and execution environment, not every payload.

The gates use fixture/model transports (including ephemeral loopback HTTP servers
for CLI tests); native Text/Box checks are not full Pi UI/SDK integration. No live
mesh, installation, reload, version bump, dependency change or publication was
part of this run. This tracked plan is retained; only the temporary ledger is
removed on run closure. Independent review and commit remain the closing gates.

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
