# PLAN — Groups by name convention (`local@group`)

> **Status:** Approved by owner — ready to build (no open decisions)
> **Last aligned:** HEAD c2dc9f6 (product at fbb56b1, post-0.4.1). The G1
> baseline passed at this HEAD; reverify the snapshot before implementation.
> **Build from this?** Yes. Tasks are ordered; each is independently reviewable.
> Scope follows the owner's simplicity constraints — see "Design constraints".
> This plan does not authorize implementation; execution requires a separate GO.
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

- *Routing* — in the hub, authoritative, for all three types handled by
  `routeMessage`: `chat`, `compact_request` and `compact_response`. A message whose
  `from` and `to` are in different groups follows the existing target-not-found
  path. From the sender's domain, the target does not exist. The hub already
  overwrites `from` with the name it assigned. Responses route by `to` as today;
  `id` correlation happens in the requester's `handleIncoming`, not in routing,
  and nothing here verifies provenance.
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

## Execution and verification

Owner authorized **run-through** with "Go, run through!": implement, independently
review and commit G1, then do the same for G2. T1–T7 below are ordered steps, not
seven separately shipped changes. No release or live-mesh operations are authorized.

- Repository: `C:/Users/andre/.pi`; product: `C:/Users/andre/.pi/agent/workshop/pi-link`.
- Preflight snapshot: branch `master`, HEAD
  `c2dc9f6a8d2677c19774775e705003ecc58bfbe2`, ahead 5, staging empty. The only
  pre-existing worktree change is this owner-approved plan, edited by the
  orchestrator. The implementer must verify this snapshot before edits; unexpected
  staged work or a red baseline blocks implementation.
- Roles: `implementer@pi-link`, independent `reviewer@pi-link`, and
  `committer@.pi`, all reporting cwd `C:/Users/andre/.pi`. Reconfirm before each
  stage; cwd alone is not proof of branch/repository identity.
- Temporary run state: `C:/Users/andre/.pi/agent/workshop/pi-link/LEDGER-groups.md`.
  Never stage it. This tracked plan is retained, with amendments committed alongside
  the implementation; it is not disposable run state.

### G1 — Groups, tests and documentation (T1–T6)

Allowed product-relative paths: `index.ts`, `test/connection-ownership-test.mjs`,
`README.md`, `skills/pi-link-coordination/SKILL.md`, `CHANGELOG.md` and
`PLAN-groups.md` (orchestrator-owned plan amendments only). No new product files.

**Required baseline and post-edit gate**, from the product directory:

```sh
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs
node test/lifecycle-compact-test.mjs
node test/connection-ownership-test.mjs
node test/inbox-fixed-window-test.mjs
node test/message-renderer-test.mjs
node "C:/Users/andre/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/esbuild/bin/esbuild" index.ts --bundle --platform=node --format=esm --packages=external --outfile=<unique-temp-file>
```

Delete and verify removal of the temporary bundle. Report actual suite counts,
failures, exit codes and native renderer block RAN/SKIPPED, not an inherited total.
Run `git diff --check`, inspect the complete staged path list and worktree scope,
and byte-check that each modified file retains its existing newline convention
(CRLF in production files; this plan currently uses LF). Do not normalize files.

Coverage: the connection harness exercises the new routing/visibility/collision
and rename cases in T5; lifecycle/inbox/renderer suites protect existing behavior;
CLI fixtures protect unchanged wrapper/status behavior; esbuild checks bundling.
Source/diff inspection must additionally verify every T4 display site, unchanged
infrastructure, the all-three-types guard, and documentation accuracy. This source
inspection is required evidence for surfaces not directly exercised by T5; it is
not runtime validation. Tests remain fixture/model evidence; the native renderer
block proves only installed Text/Box assumptions, not extension UI integration.

**Optional evidence:** targeted read-only mutation probes only to resolve a
concrete coverage doubt. No mutation quota. Live UI/mesh checks remain unverified
and require separate owner authorization; they are not silently counted as passed.

### G2 — Record completion (T7)

Start only after the approved G1 commit. Allowed product-relative paths:
`PLAN-roadmap.md` and `PLAN-groups.md` (completion header only). Record the verified
G1 hash under Shipped / closed, distinguishing code completion from npm publication;
copy this plan's Parked entries verbatim. Retain both plans and unrelated backlog.

Required gate: inspect the referenced commit and its paths with git, check that the
completion text matches G1's actual gate/review/limitations, verify the Parked copy
against this plan, preserve each file's newline convention, and run
`git diff --check` plus status/staged-scope checks. Independent documentation review
is required. Do not rerun code suites for this documentation-only task.

### Standing execution constraints

Serial implement → review → commit; two repair rounds maximum per task, shared
between gate and review repairs. Report material deviations or unpinned decisions
with rationale; the orchestrator relays them verbatim to the reviewer. Missing
required evidence blocks advancement. No worker-to-worker delegation.

No staging or committing except by the committer, using exact authorized paths.
No version/lockfile changes, dependencies, install, Pi launch/reload, live hub/port
9900 probes, `test1–4`, push, amend, tag, merge or publish. The canonical isolated
CLI fixtures above are permitted; `wire-dup-register-probe.mjs` is not part of this
gate. Use `/dev/null`, never `NUL`. No unrelated cleanup or additional features.

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

### T3 — Hub refuses cross-group `chat`, `compact_request` and `compact_response`

`routeMessage` (index.ts ~735) receives three types: `chat`, `compact_request`,
`compact_response`. In the hub branch, **before** the `msg.to === terminalName`
self-delivery check:

```ts
const crossGroup = groupOf(msg.from) !== groupOf(msg.to);
```

and treat `crossGroup` as "target not found": skip self-delivery and the
`hubClientByName` lookup, fall into the existing error construction
(`compact_response … reason: "not_found"` for requests, `error` "Terminal … not
found" for chat or responses). No new message, no new reason string.

**Uniform guard.** Responses have no group exemption. Renaming a target already
emits `terminal_left` for its old name and resolves pending requests to that name
as `disconnected`; the group filter does not change that cleanup. A later
cross-group response follows the existing target-not-found path: a responding
client receives an `error` frame as a toast, while a response from the hub itself
returns false without an extra toast. No new notification behavior is added.

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
- A `compact_response` remains subject to existing routing failures (requester
  gone, unknown name), and is also refused when its current `from` and `to`
  belong to different groups.
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

Apply it at the following roster display sites, replacing reads of
`connectedTerminals` meant for people or the model. In `link_list`, `/link` and
`targetNotFound`, compute `const visible = visibleTerminals()` once per invocation
and reuse it for text, counts, details or the membership test and suggestion.
This is a local snapshot, not a persistent cache; do not filter again for each use.

| Site | Anchor | Change |
| --- | --- | --- |
| `link_list` tool | `registerTool({ name: "link_list"` | iterate `visibleTerminals()`; `details.terminals/statuses/cwds/contexts` contain visible names only |
| `link_list` description and `promptSnippet` | same | say "terminals in your group" consistently in both model-facing descriptions |
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
  one yes/no. `targetNotFound` instead uses `visible.includes(to)` and
  `visible.join(", ")` from its one local snapshot.
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
through rosters and collisions. The seven cases below protect distinct behavior;
the named mutations explain their purpose, not a target count of checks or probes.
Existing checks with `@`-free rosters must stay green untouched (sorting is not
changed, so check 11 "hub first, then clients sorted by name" is unaffected) — that
is a gate, not a new case.

Keep tests fundamental: reuse the existing harness and small fixture tables, with
no new test framework. Do not duplicate covered legacy behavior or expand into
all combinations of names, roles and message types. Boundary names are table
inputs, not separate test suites. Run targeted mutation probes only when they
resolve a concrete coverage doubt; no additional mutations for evidence volume.

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
7. **Toasts and hub view after rename**: `terminal_joined`/`terminal_left` for
   another group add nothing to `notes`; same group does. Kills unfiltered toasts.
   With peers in both groups, the hub `h@g2` initially lists only itself and its
   `g2` peers. Run `/link-name h@g1` on that same instance; its next `link_list`
   must show itself under the new name and its `g1` peers, with no `g2` peers or
   old self name in text or `details.terminals`. This tests the new lens's live
   dependency on the current name and kills a group captured before rename.

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
- **CHANGELOG**: create `## Unreleased` above the existing 0.4.1 section and draft
  the groups entry there. No version number or date for this heading. Preserve
  the existing 0.4.1 header/date and release notes; release target and version
  bump remain the owner's decision.

### T7 — Roadmap (after commits are approved, not before)

Move this plan to "Shipped / closed" in `PLAN-roadmap.md` with the commit list, and
carry the Parked section below verbatim so it is not re-derived.

## Design constraints

- Two helpers only: `groupOf` owns the boundary rule; `visibleTerminals` shares
  the roster filter across display sites. No new state, parameters, protocol
  messages or classes.
- Local target checks give immediate feedback; the hub guard enforces the same
  group boundary during routing, for all three message types.
- Read the current name when filtering; never cache its group. Keep group
  comparisons inline for routing and toasts, without extra predicate helpers or
  roster allocations just for toast eligibility.
- No new try/catch, name validation beyond today's `normalizeName`, fallbacks,
  version checks, or normalization of case or whitespace around `@`.

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
