# PLAN — Groups by name convention (`local@group`)

> **Status:** Approved by owner — ready to build (no open decisions)
> **Last aligned:** HEAD e83c3b7 (product at fbb56b1, post-0.4.1). Re-base the
> baseline when dispatching; the plan file itself was first committed at e83c3b7
> and this is its revised text.
> **Build from this?** Yes. Tasks are ordered; each is independently reviewable.
> Design decisions are closed (owner + fable, with archon's feedback folded in);
> scope reviewed once more against the owner's philosophy — see "Kept on purpose".
> **Summary:** A terminal whose name contains `@` belongs to the group named after
> the first `@`. Its agent sees and can address only terminals of the same group. No
> wire change, no new state, no new parameters; everything derives from names at
> read time. Isolation is for the agent's attention and addressing — it is not
> security, and it is not preserved across mixed versions (documentation only).

## Why

A fleet of Pi terminals on one machine mixes unrelated projects: an orchestrator
and its workers on one repo, a committer on another, an ad-hoc helper. Today every
agent sees every terminal in `link_list` and can send to any of them. That is noise
for the model (wrong-target risk, join/left toasts from strangers) and it makes the
agent's world larger than its job.

Groups give each set of agents a domain where they are alone. Membership is
declared by the name itself — `archon@pi-link`, `committer@.pi` — which the fleet
already does by habit. The hub learns nothing new: `terminals: string[]` already
carries everything a group needs.

## What

**Rule.** `groupOf(name)` = the text after the **first** `@`, or `""` when the name
has no `@`. That is the whole rule: `a@g` → `g`, `a@g@h` → `g@h`, `a@` → `""`,
`@g` → `g`, `a` → `""`. Two terminals are **visible to each other** iff
`groupOf(a) === groupOf(b)`. The relation is symmetric by construction.

**Plain names form one implicit group.** Terminals without `@` keep today's
behavior among themselves; a fleet of plain names is unchanged. A plain terminal
that used to collaborate with `a@g` does lose that peer — that is the feature.

**Collisions never change a group.** `uniqueName` splits at the same first `@` and
suffixes the local part: `archon-2@pi-link`, `a-2@`, `-2@g`, `builder-2`. The
invariant `groupOf(uniqueName(n)) === groupOf(n)` holds for every name, and is
pinned by a test.

**Two roles of the hub, kept apart.** As infrastructure the hub routes for every
group (any terminal can win the election) over `hubClients` / `allTerminalNames`.
As a terminal, the hub's own agent sees only its own group, through the same
read-time filter as any client.

**Where each rule is enforced.**

- *Routing* — in the hub, authoritative, for `chat` and `compact_request` only: a
  message whose `from` and `to` are in different groups is answered exactly like a
  non-existent target (`Terminal "X" not found`). From the sender's domain, X does
  not exist. The hub already overwrites `from` with the name it assigned.
  The guard is untyped: it applies to every message `routeMessage` handles,
  `compact_response` included (decision T3-D below). The hub routes responses by
  `to` as today; the `id` correlation happens in the requester's `handleIncoming`,
  not in routing, and nothing here verifies provenance.
- *Visibility* — at read time, locally: one `visibleTerminals()` lens applied
  wherever the agent or the user is shown the roster. `connectedTerminals` keeps the
  full roster; the lens never replaces it.

**Admission-time isolation.** The lens and the routing guard apply to identities as
they are *now*. Nothing is revoked retroactively: a chat already queued in the inbox
before a `/link-name` that changes group is still delivered, history is not edited,
and work already admitted is not cancelled by the filter — rename and disconnect
keep exactly their current transport behavior (a rename is a `terminal_left` of the
old name, which already resolves pending compactions as `disconnected`). So the
precise claim is: *with current names, nobody can address a terminal that cannot
address it back.*

**What this is not.**

- Not security. The hub binds `127.0.0.1:9900` without auth, any process can
  register any name, and `GET /status` / `pi-link --status` list the whole
  network. `--status` is deliberately the human observer of all groups. Status,
  cwd and context updates from every group still transit the shared wire and are
  stored locally; they are simply never rendered. The lens saves no traffic and no
  memory; list/footer stay O(N) over the full roster.
- Not a channel. A target is always one terminal's literal name; nothing
  interprets it as a group selector, and there is no fan-out. Broadcast was
  removed in 0.3.0 and stays removed. Note the corollary of the rule: `@g` is a
  valid terminal name (empty local part, group `g`), so `to: "@g"` to that
  terminal from inside `g` **must work** — do not add any rejection of targets
  that start with `@`.
- Not per-group rosters on the wire. Rejected: per-recipient computation in four
  hub sites plus rename complexity, for an isolation `--status` exposes anyway.
- Not version-tolerant. **No compatibility code, by owner decision.** With an old
  hub, a new client filters its own view and its own sends, but the hub does not
  refuse cross-group traffic, so a peer of another group can still deliver a chat or
  start a compaction on it — the model then hears from a sender it cannot see.
  With a new hub and an old client, the client sees everyone, its cross-group send
  is refused, and the refusal lands as the already-documented "routing failure
  invisible to the sender" toast. Both are handled by one README sentence:
  isolation holds only when every terminal runs the same version; upgrade and
  restart together.

## Tasks

Anchors are function names; line numbers (product at fbb56b1) will drift.

### T1 — `groupOf(name)`: one owner for the `@` rule

Module-level helper next to `normalizeName` (index.ts ~403):

```ts
// Group by name convention: everything after the first `@`; plain names are group "".
function groupOf(name: string): string {
  const at = name.indexOf("@");
  return at === -1 ? "" : name.slice(at + 1);
}
```

**Consequences.** None observable alone. Every later task reads groups through
this function, so the rule exists in one place. Names stay case-sensitive.

### T2 — Collision suffix on the local part, same boundary as T1

`uniqueName` (index.ts ~643) today yields `archon@pi-link-2`, which silently moves
a colliding terminal into a phantom group. Split at the same first `@`:

```ts
function uniqueName(requested: string): string {
  const existing = allTerminalNames();
  if (!existing.has(requested)) return requested;
  // Suffix the local part so a collision never changes the group (same boundary as groupOf).
  const at = requested.indexOf("@");
  const cut = at === -1 ? requested.length : at;
  const local = requested.slice(0, cut);
  const tail = requested.slice(cut);
  let i = 2;
  while (existing.has(`${local}-${i}${tail}`)) i++;
  return `${local}-${i}${tail}`;
}
```

**Consequences.** `archon@pi-link` ×2 → `archon-2@pi-link`; `a@` ×2 → `a-2@`
(still plain); `@g` ×2 → `-2@g` (still `g`); `builder` ×2 → `builder-2`.
Persistence unchanged: hub-assigned variants are still not saved; reconnects still
request the preferred name. README "Name Uniqueness" gains the grouped form (T6).

### T3 — Hub refuses cross-group `chat` / `compact_request`

`routeMessage` (index.ts ~735) receives three types: `chat`, `compact_request`,
`compact_response`. In the hub branch, **before** the `msg.to === terminalName`
self-delivery check:

```ts
const crossGroup = groupOf(msg.from) !== groupOf(msg.to);
```

and treat `crossGroup` as "target not found": skip self-delivery and the
`hubClientByName` lookup, fall into the existing error construction
(`compact_response … reason: "not_found"` for requests, `error` "Terminal … not
found" for chat). No new message, no new reason string.

**T3-D — decided: no `compact_response` exemption (owner, for less code).**
A response crosses groups only if one party changed group mid-compaction. That
rename is a `terminal_left` of the old name, which already resolves the
requester's pending entry as `disconnected`; a response arriving later would find
no pending entry and be ignored anyway. So the untyped guard cannot cause a hang
or a wrong result. Its only observable effect in that rare case: the hub refuses
the stray response and the renamed target sees an `error` "Terminal <requester>
not found" toast — honest from its new group's point of view. The alternative
(typing out responses) was one more condition with no behavioral gain; archon's
conceptual preference for it ("a response is transport, not addressing") is
recorded and not adopted.

**Consequences.**
- Stable clients never reach this path for `link_send`/`link_compact`: T4's
  `targetNotFound` already fails locally because the target is not visible. The
  guard exists so that isolation is a property of the link, not of each client's
  conduct — it is what turns "the tool does not offer it" into "you cannot send".
  It also covers the race where the target is renamed between the local check and
  routing. It does not protect against a raw socket that picks a foreign `@group`
  for itself: there is no auth, and that is not this feature's job.
- When the guard does fire for a `chat` from a client, that client's `link_send`
  already returned optimistic success and the hub's `error` frame arrives as a
  toast — exactly as any hub-side failure today. For a `compact_request` the
  requester instead receives `compact_response { ok: false, reason: "not_found" }`
  and its `link_compact` resolves with it, never busy/declined. Two contracts, as
  today.
- The hub's own agent is protected too: a client in another group cannot reach the
  hub's inbox by name.
- A `compact_response` can still fail for the reasons it fails today (requester
  gone, unknown name); the group guard adds or removes only the T3-D case.
- Wire format unchanged.

### T4 — `visibleTerminals()` at every read site

Inside the extension closure, next to `targetNotFound`:

```ts
// The agent's and the user's view of the roster: same group only. Routing never
// uses this — the hub routes over hubClients; this is a lens over connectedTerminals.
function visibleTerminals(): string[] {
  const group = groupOf(terminalName);
  return connectedTerminals.filter((n) => groupOf(n) === group);
}
```

Apply it here, replacing reads of `connectedTerminals` meant for people or the
model. These are all of them (archon audited the remaining reads: none other is
UI-facing).

| Site | Anchor | Change |
| --- | --- | --- |
| `link_list` tool | `registerTool({ name: "link_list"` | iterate `visibleTerminals()`; `details.terminals/statuses/cwds/contexts` contain visible names only |
| `link_list` description | same | "List all Pi terminals…" is no longer true — say "terminals in your group" |
| `/link` command | `registerCommand("link"` | list and "N online" over `visibleTerminals()` |
| `targetNotFound` | ~1558 | membership test **and** the `Connected: …` suggestion over `visibleTerminals()` |
| `updateStatus` footer | ~324 | `count = visibleTerminals().length` |
| Welcome toast | `case "welcome"` | `(N online)` over `visibleTerminals()` |
| `terminal_joined` toast | `case "terminal_joined"` | notify only if `groupOf(msg.name) === groupOf(terminalName)`; roster/cwd/context bookkeeping unchanged |
| `terminal_left` toast | `case "terminal_left"` | same condition; pending-compact cleanup loop unchanged |

Never touch: `allTerminalNames`, `terminalList`, `hubBroadcast`,
`hubClientByName`, the `/status` payload builder, register/status/close handlers.
They are infrastructure and must keep seeing every group.

**Consequences.**
- The model's `link_list` shows only its group, `(you)` marked as today, with no
  stranger's status/cwd/context in `details` to filter or be confused by.
- `link_send`/`link_compact` to an invisible name fail locally with the same
  `not_found` text a typo gets; the suggestion list names only the group. Document
  as "not found in your group"; do not present it as leak prevention (`--status`
  is global).
- Join/left toasts and the footer count reflect the group. A stranger joining is
  silent. The toast condition is the inline comparison
  `groupOf(msg.name) === groupOf(terminalName)`: no array is built just to answer
  one yes/no. (`targetNotFound` legitimately does use
  `visibleTerminals().includes(to)` — it needs the membership test and the
  suggestion list from the same snapshot.)
- Footer and welcome count are one token each; unfiltered they would say
  "8 terminals" while `link_list` shows 3.
- Rename across groups needs no code: `/link-name a@g2` on a client reconnects and
  gets a fresh view; on the hub it rebroadcasts `terminal_left old` +
  `terminal_joined new`, and each toast is filtered by its own name's group, so the
  old group sees a leave and the new group a join. Nothing cached, nothing stale —
  subject to admission-time semantics above.
- Hub-side `connectedTerminals` is never filtered on assignment.

### T5 — Tests (`test/connection-ownership-test.mjs`, existing harness)

The harness already exposes `notes` (via `notify`), `sent`/`receive` on the fake
socket, `delivered`, `tool()`, `cmd()`. Its fake `compact()` invokes no callbacks,
so compaction rejection is observed as a `not_found` frame, never as compact
success. Do **not** export `groupOf` from production for tests; exercise the rule
through rosters and collisions. Seven cases, ordered by mutation signal; each names
the mutation it kills. Existing checks with `@`-free rosters must stay green
untouched (sorting is not changed, so check 11 "hub first, then clients sorted by
name" is unaffected) — that is a gate, not a new case.

1. **Client → hub, cross-group chat**: `a@g1` sends to the hub named `h@g2`; hub
   returns `error` "not found" and nothing reaches the hub's inbox. `delivered` is
   fed by the deferred batch flush, so an immediate `delivered.length === 0` proves
   nothing: use the harness's existing flush window with a **positive control** —
   the same chat from a same-group client *is* delivered in that window, the
   cross-group one is not. No new sleeps. Kills a guard placed *after* the
   self-delivery check.
2. **Two clients, same group, different from the hub's**: `a@g1` → `b@g1` routes
   while the hub is `h@g2`. Kills any "helpful" filtering of infrastructure.
3. **Cross-group between clients**: `a@g1` → `b@g2`, both registered: sender gets
   `error` "Terminal "b@g2" not found", `b@g2` receives nothing. Kills a missing
   or inverted guard. (The same-group positive is already case 2, which is the
   stronger form; do not repeat it here.)
4. **Cross-group `compact_request`** → requester receives `compact_response`
   `{ ok: false, reason: "not_found" }`. Kills a guard written for `chat` only and
   pins the per-type error shape. No compact callback, no waiting: the fake
   `compact()` never calls back.
5. **`link_list` details and `targetNotFound` suggestion**: roster
   `[a@g1, b@g1, c@g2, d]` with **populated** `status`, `cwd` and `context` for
   both own and foreign names (empty maps would pass vacuously). Seen from `a@g1`
   → text lists only `a@g1`, `b@g1`; `details.terminals === [a@g1, b@g1]`; the keys
   of `statuses/cwds/contexts` are exactly those two. A send to `c@g2` fails
   locally with `Connected: a@g1, b@g1`. Seen from `d` → `[d]`. Kills a text-only
   filter.
6. **Collision invariant on boundary inputs**: `archon@pi-link` ×2 →
   `archon-2@pi-link`; `a@` ×2 → `a-2@`; `@g` ×2 → `-2@g`; `a@g@h` ×2 →
   `a-2@g@h`. The last two are what kill `lastIndexOf` and the old `at > 0` rule —
   the first two alone let both mutants pass. Also exercise `@g` and `a@g@h` as
   roster members in case 5 so the lens agrees with the collision boundary. Four
   examples pin the boundary; they do not prove the invariant for every string,
   and the plan does not claim so.
7. **Toasts**: `terminal_joined`/`terminal_left` for another group add nothing to
   `notes`; same group does. Kills unfiltered toasts. (A hub-rename case was
   considered and dropped: this plan changes no rename code, and "no cached group"
   is a property of having no cache, recorded under Kept on purpose rather than
   tested.)

### T6 — Documentation (no code for compatibility)

- **README**
  - "Name Uniqueness & Persistence": one paragraph — the rule (`local@group`,
    first `@`, plain = one implicit group), the collision forms `builder-2` /
    `archon-2@pi-link`, and that the tools and `/link` work within your group while
    `--status` shows all groups on purpose. The existing `link_list` / `link_send` /
    `link_compact` sections are not rewritten.
  - Limitations table, new row — *Groups isolate attention, not access*: no auth,
    any process may pick any name, `--status` sees everything, other groups'
    updates still transit the shared wire; and isolation holds only when every
    terminal runs the same version — upgrade and restart together.
- **Skill** (`skills/pi-link-coordination/SKILL.md`, under "Names are identities"):
  one bullet — `@group` in your name limits `link_list`, `link_send` and
  `link_compact` to that group; to reach another project's terminal you must share
  its group.
- **CHANGELOG**: implementer drafts the entry under *Unreleased*. Version header,
  release target and bump are the owner's (0.4.1 is not yet published; the
  behavior change to mixed-`@` fleets suggests a minor, owner decides).

### T7 — Roadmap (after commits are approved, not before)

Move this plan to "Shipped / closed" in `PLAN-roadmap.md` with the commit list, and
carry the Parked section below verbatim so it is not re-derived.

## Kept on purpose (philosophy review, owner-approved)

Every production line was re-justified against "simple, performant, readable,
idiomatic, every line justified, abstractions only when essential":

- Two helpers, no state, no parameter, no protocol message, no class. `groupOf`
  exists for correctness (one boundary rule, five consumers — two boundary rules
  is how `a@-2` happened); `visibleTerminals` exists because six read sites share
  one filter.
- The hub guard (T3) is kept because it makes isolation a property of the link.
  It is the plan's one deliberate redundancy: `targetNotFound` already refuses
  locally, the guard makes the refusal the link's, not the client's. It is untyped
  (T3-D): the earlier claim that a `compact_response` exemption prevents a 180 s
  hang was wrong (a rename already resolves the pending compaction as
  `disconnected`) and was withdrawn; with it went the extra condition.
- Rejected during the review: caching the own group (state a rename invalidates),
  `sameGroup(a, b)` (a comparison of two `groupOf` reads better than a new name),
  a `reachable(msg)` helper (inline is clearer), building `visibleTerminals()` for
  the join/left toasts (one comparison answers them), receiver-side filtering
  (compatibility code).
- Trimmed: T5 from eleven cases to seven, then case 3's duplicate positive and
  the hub-rename case (tests nothing this plan changes); T6 to one README
  paragraph plus one Limitations row.
- No defensive code anywhere: no try/catch, no input validation on names beyond
  today's `normalizeName`, no fallbacks, no version checks, no normalization of
  case or whitespace around `@`.

## Parked — resolve later, do not build now

- **Root / global agent.** A terminal that sees and addresses every group. It must
  preserve symmetry (workers must see root to reply), so it is an explicit
  exception to `groupOf(a) === groupOf(b)`, not a group. Decided only when a
  concrete workflow needs it. Note: with the adopted rule `@g` is an ordinary
  member of `g` with an empty local part, so no name form is reserved for root.
  Until then the human observer is `pi-link --status`.
- **`--status <group>` filter.** Derivable by eye from the `@`; not worth a flag.
- **Grouped ordering in `--status`.** Cosmetic; only surface that shows several
  groups at once.

## Out of scope (decided)

- Interpreting a target as a group selector, any fan-out, `link_compact` on a
  group. (The literal name `@g` stays an ordinary, addressable identity.)
- Per-group rosters or filtered join/left on the wire.
- Receiver-side filtering in `handleIncoming` (would only serve old hubs —
  compatibility code, refused).
- Any new tool parameter, setting, or persisted state.
- Changing sort order of `terminals` or of the `/status` payload.
- Retroactive isolation on rename (inbox purge, cancelling admitted compactions).
