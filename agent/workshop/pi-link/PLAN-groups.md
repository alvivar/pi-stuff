# PLAN — Groups by name convention (`local@group`)

> **Status:** Ready to build — pending owner GO
> **Last aligned:** HEAD 2b00a1a (product at fbb56b1, post-0.4.1)
> **Build from this?** Yes. Tasks are ordered; each is independently reviewable.
> Design decisions are closed (owner + fable, with archon's feedback folded in).
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
  `compact_response` is exempt: it completes a request the hub already admitted,
  and the exemption is that — not a verified-provenance guarantee (the hub
  correlates responses by `id` only, as today).
- *Visibility* — at read time, locally: one `visibleTerminals()` lens applied
  wherever the agent or the user is shown the roster. `connectedTerminals` keeps the
  full roster; the lens never replaces it.

**Admission-time isolation.** The lens and the routing guard apply to identities as
they are *now*. Nothing is revoked retroactively: a chat already queued in the inbox
before a `/link-name` that changes group is still delivered, a compaction already
admitted still completes, history is not edited. So the precise claim is: *with
current names, nobody can address a terminal that cannot address it back.*

**What this is not.**

- Not security. The hub binds `127.0.0.1:9900` without auth, any process can
  register any name, and `GET /status` / `pi-link --status` list the whole
  network. `--status` is deliberately the human observer of all groups. Status,
  cwd and context updates from every group still transit the shared wire and are
  stored locally; they are simply never rendered. The lens saves no traffic and no
  memory; list/footer stay O(N) over the full roster.
- Not a channel. There is no `to: "@group"`, no fan-out. Broadcast was removed in
  0.3.0 and stays removed; each send routes to one named recipient.
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
  const at = requested.indexOf("@");
  const [local, tail] = at === -1 ? [requested, ""] : [requested.slice(0, at), requested.slice(at)];
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
const crossGroup =
  msg.type !== "compact_response" && groupOf(msg.from) !== groupOf(msg.to);
```

and treat `crossGroup` as "target not found": skip self-delivery and the
`hubClientByName` lookup, fall into the existing error construction
(`compact_response … reason: "not_found"` for requests, `error` "Terminal … not
found" for chat). No new message, no new reason string.

**Consequences.**
- Stable new clients never reach this path for `link_send`/`link_compact`: T4's
  `targetNotFound` already fails locally because the target is not visible. The hub
  guard is what makes isolation authoritative against raw or stale clients and
  against races (target renamed between check and route). In those cases the
  client's tool result is optimistic success and the hub's `error` frame arrives
  as a toast, exactly as any hub-side failure today.
- The hub's own agent is protected too: a client in another group cannot reach the
  hub's inbox by name.
- A cross-group `compact_request` resolves `not_found`, never busy/declined.
- `compact_response` always routes: it only exists to complete a request.
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
  silent.
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
through rosters and collisions. Ordered by mutation signal:

1. **Client → hub, cross-group chat**: `a@g1` sends to the hub named `h@g2`; hub
   returns `error` "not found", hub inbox receives nothing. Kills a guard placed
   *after* the self-delivery check.
2. **Two clients, same group, different from the hub's**: `a@g1` → `b@g1` routes
   while the hub is `h@g2`. Kills any "helpful" filtering of infrastructure.
3. **Cross-group between clients**: `a@g1` → `b@g2`, both registered: sender gets
   `error` "Terminal "b@g2" not found", `b@g2` receives nothing. Same pair in
   `g1`: delivered.
4. **Cross-group `compact_request`** → `compact_response` `reason: "not_found"`.
5. **`link_list` details, not just text**: roster `[a@g1, b@g1, c@g2, d]` seen from
   `a@g1` → `details.terminals === [a@g1, b@g1]` and `statuses/cwds/contexts` have
   no foreign keys. Kills a text-only filter. Seen from `d` → `[d]`.
6. **Same as 5 from the hub's agent** (`tool("link_list")` on the hub) while a
   same-group send between two clients still routes: view filtered, routing not.
7. **Collision invariant**: `archon@pi-link` ×2 → `archon-2@pi-link`; `a@` ×2 →
   `a-2@`; `@g` ×2 → `-2@g`; `builder` ×2 → `builder-2`. Kills suffix-at-end and
   any second boundary rule.
8. **`targetNotFound` suggestion** lists only visible names.
9. **Toasts**: `terminal_joined`/`terminal_left` for another group add nothing to
   `notes`; same group does.
10. **Hub rename across groups**: `/link-name h@g1` on a hub previously `h@g2`
    changes what its `link_list` shows next, while a `g2` client pair still routes.
11. **Plain-name regression**: existing checks with `@`-free rosters stay green
    untouched; check 11 ("hub first, then clients sorted by name") is unaffected —
    sorting is not changed.

### T6 — Documentation (no code for compatibility)

- **README**
  - "Name Uniqueness & Persistence": the rule (`local@group`, first `@`, plain =
    one implicit group), the collision forms `builder-2` / `archon-2@pi-link`, one
    sentence per surface: `link_list`/`/link` show your group; `link_send`/
    `link_compact` outside it fail as not found; `--status` shows all groups on
    purpose.
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

- Group addressing (`to: "@group"`), any fan-out, `link_compact` on a group.
- Per-group rosters or filtered join/left on the wire.
- Receiver-side filtering in `handleIncoming` (would only serve old hubs —
  compatibility code, refused).
- Any new tool parameter, setting, or persisted state.
- Changing sort order of `terminals` or of the `/status` payload.
- Retroactive isolation on rename (inbox purge, cancelling admitted compactions).
