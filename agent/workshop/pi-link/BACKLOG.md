# pi-link backlog

> **Status:** Current. Single prioritized list of candidate work.
> **Scope:** Candidates only. Current behavior lives in `README.md` and the source;
> history lives in Git. Listing a candidate here is **not** authorization to build it.
> Priority is relative order, not urgency or a schedule.

The plan files this list replaces were retired, not lost. Every one of them is
readable at the pre-cleanup revision, for example:

```sh
git show ec29de7a01857ec9535b3803e520f4c8309218da:agent/workshop/pi-link/PLAN-roadmap.md
```

The same command reads `PLAN-orchestration.md`, `PLAN-monitor.md`, `PLAN-groups.md`,
`PLAN-review-cleanup.md` and `PLAN-compact-five-minutes.md` at that revision.

The `REPORT-*.md` files are deliberately **out of scope** for this backlog. They were
not reviewed, changed or summarized here, and their items are assessed separately.

## Candidates

The order below was proposed after a code review of 0.6.1 and has **not** been
confirmed by the owner. Candidates are listed in priority order; their `BL-` numbers
are stable identifiers, not ranks. BL-12 to BL-23 come from that review, which a
second reviewer checked independently.

"Isolated probe" below means the real `index.ts` loaded in memory against stubbed
`ws`, `http` and Pi modules. No live Pi, hub, browser or real socket was used for any
of them.

### BL-12 — A malformed frame can take down the hub

**Priority:** 1. **Status:** Open, no design pinned.

The hub parses each client frame with `JSON.parse` and then reads its fields without
checking their shape (`safeParse`, `hubHandleClient`). A `chat` with no `to`, or a
`register` whose `name` is a number, throws a `TypeError` inside the `ws` message
listener, and Pi 1.5.2's interactive mode exits the process on an uncaught exception.
A `register` with an empty name stays in the roster as `""` after its socket closes,
for as long as that hub lives. Two independent isolated probes reproduced all three.
The exceptions were caught in the harness, so no real Pi was crashed, and no
production incident was reported. pi-link's own client never sends such frames; any
other local process can.

*Outcome sought:* a frame the hub cannot use is dropped without an exception and
without leaving a roster entry.

*Revisit when:* the owner authorizes it; no further evidence is needed.

*Constraints:* validate at the boundary only the fields the hub actually reads. No
schema library, protocol version or negotiation. Names that are valid today stay
valid, including `@g` and `__proto__`. The defenses the hub already has stay as they
are: registration first, the authoritative `from`, groups, and unknown types ignored.

### BL-13 — Web pages may reach the hub's WebSocket

**Priority:** 2. **Status:** Open, unverified.

The hub's `WebSocketServer` is created without `verifyClient` and never reads the
upgrade request's `Origin` header (`startHub`); the installed `ws` 8.21.3 consults
`Origin` only when `verifyClient` is set. Browsers do not apply the same-origin
policy to WebSocket connections, so a page that manages to open
`ws://127.0.0.1:9900` could register, read the roster with its cwds, and send `chat`
frames that start turns in agents, or `compact_request` frames. README limitation #1
names "any localhost process" as the boundary; a web page is not one. This is source
reading only: no browser was tested, and mixed-content rules or a browser's
local-network access controls may block the connection in some cases.

*Outcome sought:* either a connection that carries a browser `Origin` is refused, or
the README states that web pages are inside the trust boundary.

*Revisit when:* a browser test shows whether a page can complete the handshake. That
test is the first step, before any fix.

*Constraints:* this is not authentication; local processes stay trusted as
documented. pi-link's own client sends no `Origin` (`ws` adds the header only when
asked), which is what a refusal can key on. CORS on `GET /status` is not a defense
for the WebSocket. No tokens and no handshake extensions.

### BL-15 — Failing to join or host the link is silent

**Priority:** 4. **Status:** Open.

When the dial fails and the listen fails — port 9900 held by something that is not a
hub — both errors are discarded (`connectAsClient`, `startHub`), the attempt
schedules a retry, and nothing is shown. In two independent isolated probes, startup
followed by `/link-connect` produced no notification. The footer says `link: offline`
with no cause, indefinitely. Each retry comes after a 2–5 second backoff, plus up to
5 seconds of handshake timeout.

*Outcome sought:* the user learns that the terminal could neither join nor host, with
the listen error, and without one notification per retry.

*Revisit when:* the owner authorizes it; no further evidence is needed.

*Constraints:* keep the retry and the client-then-hub election. A listen error does
not prove another hub exists, so the message must not claim one. The ordinary
election race, where two terminals bind at once and the loser joins on its retry,
must stay quiet.

### BL-1 — Routing failure visible to the sending agent

**Priority:** 5. **Status:** Open, no design pinned.

A client's `link_send` reports success as soon as it writes the message to the hub
socket; client-side delivery is optimistic by contract, and no hub receipt or
arrival acknowledgment exists. When the hub then refuses to route it — stale
roster, target renamed or gone, target in another group — the failure reaches the
user as a notification and never reaches the sending agent, which keeps acting as
if the message arrived.

*Outcome sought:* the sending agent learns that its own message was not delivered,
attributed to the target it named.

*Revisit when:* a coordination failure is traced to a send the model believed had
landed — the cost of the silence becomes concrete rather than theoretical.

*Constraints:* no delivery receipts, no correlation ids, no blocking RPC. The
candidate direction is to return the hub's routing error to the sender as an
ordinary attributed message through the existing delivery path, with proof it can
neither route to itself nor loop. Group visibility rules stay as they are. No wire
or API design is pinned by this entry.

### BL-10 — Windows launch passes arguments through cmd.exe

**Priority:** 6. **Status:** Open.

On Windows, `pi-link <name>` starts Pi as `cmd.exe /d /c pi …` (`runLauncher`
in `bin/pi-link.mjs`). cmd.exe can reinterpret arguments instead of passing
them literally: `&` separates commands, `|` pipes, `<` and `>` redirect, `^`
escapes, and `%VAR%` expands even inside quotes. Isolated `spawnSync` probes
through cmd.exe, without Pi, confirmed this: the tokens `echo`, `x&echo`,
`PI_LINK_PROBE` ran two commands, and an environment variable expanded even
in a quoted token. The pass-through arguments are exposed, as is the
`--session` path pi-link adds if it contains such characters. The name travels
in `PI_LINK_NAME`, not interpolated into this command. No production incident
was reported in this review.

*Outcome sought:* Pi receives its intended launch arguments literally,
including pass-through values and the resolved session path.

*Revisit when:* the owner confirms its priority, or an argument or resolved
session path is seen reinterpreted.

*Constraints:* no generic quoting heuristic. A fix must prove the arguments
survive cmd.exe and the npm `.cmd` shim unchanged, or start Pi without a shell
in a way that respects how it is installed (npm shim, the managed launcher,
PATH); it cannot assume a directly runnable `pi.js`.

### BL-18 — State the Oh My Pi support scope

**Priority:** 7. **Status:** Open; a decision, not code.

The code carries two accommodations for Oh My Pi. `loadMode: "essential"` shipped in
0.5.1 after a real report of the tools not being visible there. `result.isError` in
the result renderer shipped in 0.6.1 by the owner's choice, from source reading and
not tested under Oh My Pi. BL-9 and `REPORT-omp-renderer-signature.md` record further
gaps, also from source reading and none reproduced. The README describes Pi only and
does not say what is known to work under Oh My Pi.

*Outcome sought:* a short scope note for someone who arrives through the 0.5.1 fix —
what is known to work and what is unknown — or an explicit decision that none is
needed.

*Revisit when:* the owner decides; it comes before BL-9, which depends on the answer.

*Constraints:* do not infer full support, and do not remove the two accommodations.
This entry does not authorize BL-9 or a call-renderer adapter.

### BL-9 — OMP compact contract: instructions and completion

**Priority:** 8. **Status:** Open.

The remote compaction start (`index.ts` ~728) relies on Pi's `compact()`
contract. Source reading of OMP v18.15.0 (commit 3fedf8d) reports three gaps
under OMP:

- *Instructions.* pi-link passes `{ customInstructions, onComplete, onError }`.
  OMP's `CompactOptions` has no `customInstructions`; instructions are a plain
  string argument. Under OMP, `link_compact` instructions are not delivered
  through OMP's documented channel.
- *Rejection without a callback.* `compact()` returns a promise that pi-link
  neither awaits nor catches; the `try/catch` covers only synchronous throws. OMP
  can reject early without calling `onError`, for example when a compaction is
  already running. `finish()` then never runs: `remoteCompact` and
  `compactRunning` stay set and no deadline clears them, held messages stay
  held, later requests are declined with `already_requested`, and the rejection
  is unhandled.
- *Resolve without a callback.* In OMP's interactive TUI a failure can resolve
  the promise without calling `onError` or `onComplete`, with the same effect.
  A resolve is not proof of success.

`/link-disconnect` does not lower that stuck `compactRunning` gate either; without
an outcome, it remains until session teardown.

*Outcome sought:* under OMP, `link_compact` instructions reach the compaction,
and every request gets exactly one outcome that matches what happened.

*Revisit when:* the owner confirms its priority. A fix then needs, in order: OMP's
source confirms how to pass the instructions and how to get an unambiguous
outcome in each OMP mode; an isolated harness covers success, `onError` plus a
rejection, a rejection without a callback and a resolve without a callback, with
`finish()` running at most once and success never inferred from a resolve; and a
live OMP check authorized by the owner.

*Constraints:* no retries, arbitrary timeouts or heuristics. The evidence is
reported source reading, not runtime: none of the three gaps was reproduced.

### BL-6 — Release the inbox when a compaction fails

**Priority:** 9 — the cost is a delay, not a loss. **Status:** Open, no design pinned.

Pi 0.84.3+ emits `session_compact_failed` to extensions when a compaction fails
or is cancelled. pi-link does not handle it: a `localCompacting` gate raised by
`session_before_compact` stays up until the next agent run, a later successful
compaction, or the five-minute deadline, so messages to that terminal wait that
long after a compaction that already failed. `REPORT-session-compact-failed.md`
holds the earlier analysis; it was not re-assessed here.

*Outcome sought:* a failed or cancelled compaction releases held messages promptly.

*Revisit when:* a cancelled `/compact` is seen holding a terminal's inbox for
minutes in practice, or the floor moves to 0.84.3+ for another reason.

*Constraints:* the release must be correlated with the compaction that raised the
gate — the event carries no id, and a release on the wrong failure reopens
delivery into a compaction still running. Chosen policy, not a runtime need: ship
it with `MIN_PI_VERSION` raised to 0.84.3 and no compatibility branch for the
floor below it. A handler is runtime-safe on 0.84.2, but its typings lack the event.

### BL-11 — Session paths resolved differently from Pi

**Priority:** 10. **Status:** Open.

pi-link's `expandTilde` expands only `~` and `~/`. In comparisons on Windows,
Pi 1.5 also normalized `~\`, `/c/...` and `file://` paths that pi-link left
literal. With those forms in `PI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_SESSION_DIR` or a settings `sessionDir`, `pi-link <name>`,
`--list` and `--resolve` can look in the wrong location or fail instead of
finding Pi's session store. The comparisons ran both implementations'
extracted helpers, not full session launches; default paths are unaffected.

*Outcome sought:* pi-link resolves the session directory as Pi does, for the
explicitly supported forms.

*Revisit when:* the owner confirms its priority, or a configuration using one of
these forms is reported.

*Constraints:* decide the supported forms explicitly and test them on Windows
and POSIX. Do not copy Pi's whole path module, add a Pi dependency or raise the
floor for this. Until then, the `expandTilde` comment ("Match Pi's
expandTildePath") overstates the match.

### BL-19 — The wrapper's name does not survive `/new`

**Priority:** 11. **Status:** Open; a decision first.

`PI_LINK_NAME` is read and deleted on the first `session_start`, so child processes
do not inherit it. Pi 1.5.2 builds a fresh runtime on `/new` and calls the extension
factory again; the new session has no saved link name, so a terminal started with
`pi-link builder` takes the session name or a random `t-xxxx`, and joins the link
under it because the wrapper's `--link` is reapplied. An explicit
`pi --link-name builder` is reapplied too and keeps its name. This is source reading
of Pi and pi-link; `/new` was not run.

*Outcome sought:* a decided behavior for the link name after `/new`, documented.

*Revisit when:* a user is surprised by the rename, or the wrapper's documentation is
next edited.

*Constraints:* saved names and connection intent belong to the session by design.
Carrying `builder` into the new session creates two sessions with the same name,
which makes `pi-link builder` ambiguous on the next launch.

### BL-20 — An empty `--link-name` exits the host from `session_start`

**Priority:** 12. **Status:** Open; a decision first.

`pi --link-name ""` reaches `console.error` and `process.exit(1)` inside the
`session_start` handler, which ends Pi without its own shutdown path. Rejecting the
empty value is deliberate; ending the process this way is not a recorded decision.
The effect on terminal state was not tested.

*Outcome sought:* the rejection stays clear, and what happens to the Pi process is
decided rather than inherited.

*Revisit when:* the startup path is next touched, or a terminal is seen left in a bad
state by this exit.

*Constraints:* no fallback to a random name, and no `throw` whose capture by the host
silently changes the contract.

### BL-21 — One offline test entry point

**Priority:** 13. **Status:** Open.

`package.json` has no `test` script, so the five suites are run by hand, one command
each. Four of them carry their own copy of the module-stub loader. A sixth file,
`test/wire-dup-register-probe.mjs`, is a one-off that registers on the live hub at
`:9900` through an absolute path into the installed packages.

*Outcome sought:* one command runs every offline suite and cannot reach the live hub.

*Revisit when:* a release is next prepared, or tests are added for another candidate.

*Constraints:* list the suites explicitly; no glob that would capture the live probe,
which is removed or kept clearly outside the runner. Share only the loader plumbing:
the suites' fixtures differ on purpose (self-emitting or test-driven transports, a
simulated clock, renderer components), and one parameterized harness would cost them
their clarity.

### BL-17 — Unreachable not-found handling for the hub's own requests

**Priority:** 14. **Status:** Open, optional. No operational failure observed.

On the hub, `link_send` and `link_compact` call `targetNotFound()` and then route in
the same synchronous step, and the roster that check reads is updated together with
`hubClients`. Three branches therefore have no normal producer: the hub arm of the
failure reason in `link_send`, the self-delivery of a synthesized `not_found`
response to the hub's own request in `routeMessage`, and the "answered in this stack"
case in `link_compact`. Established by reading; two reviewers found no producer.

*Outcome sought:* those three branches are removed, or their comments say they are
defensive.

*Revisit when:* the routing code is next touched for another reason.

*Constraints:* keep not-found routing for requests from clients, where the target can
leave or be renamed between the client's check and the hub's routing. Keep local
delivery to the hub of traffic received from clients, and keep `false` for a client
whose hub connection is not open.

### BL-16 — One local rule for "the status changed"

**Priority:** 15. **Status:** Open, optional. A simplification; no defect shown.

Five handlers repeat the same sequence — read the status identity, mutate, compare,
move `stateSince`, push — and `syncCompactionStatus()` keeps a separate
`wasCompactionGated` to answer the same question about the gate. A helper that
remembers the last observed identity locally, independent of what was published,
could replace the five copies and that boolean. It was not implemented or tested.

*Outcome sought:* one place decides that the status changed and moves the clock.

*Revisit when:* those handlers are next touched for another reason.

*Constraints:* `lastPushedStatus` stays; it answers what was published, not what
changed. The local clock must keep moving while disconnected, which is the case
documented at `syncCompactionStatus()`. Forced pushes for a context change with no
identity change must still go out, and a handover between two calls of the same tool
stays one status.

### BL-22 — Package metadata: host packages and `.npmignore`

**Priority:** 16. **Status:** Open.

`index.ts` imports three packages the host supplies (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`, `typebox`) and `package.json` declares none of them; Pi's
`docs/packages.md` asks for them in `peerDependencies` with a `"*"` range. Loading
works today because Pi maps those modules. `.npmignore` repeats what the `files`
allowlist already excludes.

*Outcome sought:* the package metadata matches Pi's package contract, with nothing
redundant.

*Revisit when:* a release is next prepared.

*Constraints:* check the effect on `npm i -g pi-link` first. Pi suppresses automatic
peer installation for managed packages, but the global CLI install is plain npm. No
install or pack was run for this entry.

### BL-23 — Small source cleanups

**Priority:** 17. **Status:** Open, optional.

- `flushInbox()` returns on `!ctx`, a state with no normal producer, and the function
  does not use `ctx`. `getUi()` and `isRuntimeLive()` are a different matter and stay.
- The startup connect is deferred with `setTimeout(…, 0)` for a real reason — the
  stale-context crash fixed in 0.1.10 — that the code does not state next to it.
- In `bin/pi-link.mjs` the dispatch runs in the middle of the file, which is why
  `UNKNOWN` carries a comment about its temporal dead zone; dispatching at the end
  removes that dependency. The post-parse `resolveName === null` check and the
  dispatch `default` are unreachable with the current parser.

*Outcome sought:* the same behavior with less to explain.

*Revisit when:* the surrounding code is next touched for another reason.

*Constraints:* behavior-identical. The startup deferral itself stays.

### BL-2 — Remote model / thinking control

**Priority:** 18. **Status:** Parked.

A terminal cannot ask a peer to change its model or thinking level; today each
user sets both on the terminal that owns the task.

*Outcome sought:* an orchestrator can raise or lower a worker's model or thinking
level for a specific pass, with the worker's consent.

*Revisit when:* a concrete workflow needs it — for example escalating one worker to
high thinking for a sensitive pass. Until then it is a solution looking for a
problem.

*Constraints:* receiver consent is essential, because these levers change a peer's
cost, quality and latency — unlike compaction, which shipped without a consent
gate. Keep only that intent: the old control-request protocol, capability
advertisement, cooldown and fire-and-forget semantics were never built and must not
be treated as a specification.

### BL-3 — Root / global agent across groups

**Priority:** 19. **Status:** Parked.

Groups isolate an agent's attention to terminals sharing its `@group`. There is no
agent that spans them.

*Outcome sought:* one terminal that sees and can address every group.

*Revisit when:* a workflow actually needs cross-group coordination by an agent
rather than by a human reading `pi-link --status`, which is today's global observer.

*Constraints:* visibility must stay symmetric — a worker must be able to see the
root terminal in order to reply to it — so this is an explicit exception to the
same-group rule, not a group. No name form is reserved: under the current rule `@g`
is an ordinary member of group `g` with an empty local part.

### BL-4 — Traffic monitor

**Priority:** 20. **Status:** Parked.

No terminal can observe traffic between other terminals.

*Outcome sought:* an opt-in mode where a terminal receives copies of direct traffic
for supervision, oversight or progress summarization.

*Revisit when:* a real oversight demand justifies the cost. This is active model
traffic, not a passive audit log and not guaranteed delivery: copies wake the
monitor, raising model usage, attention noise and — when a monitor intervenes —
loop risk.

*Constraints:* a fresh design is required. The retired sketch predates groups and
relies on mechanisms that no longer exist (remote prompts, broadcast fan-out, the
idle-gated inbox), so it cannot be revived as written.

### BL-5 — Grouped ordering in `pi-link --status`

**Priority:** 21 — low, cosmetic. **Status:** Parked.

`--status` lists every terminal of every group in one flat table.

*Outcome sought:* output grouped by `@group`, so a multi-group fleet reads more
easily. Cosmetic only; no behavior, payload or exit-code change.

*Revisit when:* someone routinely reads a fleet large enough for the flat table to
be the friction.

*Constraints:* this is ordering of the existing output. It is not `--status <group>`
— a filter that was declined because the group is readable by eye — and it must not
grow into one.

## Decisions not to reopen without new evidence

These were decided against, and each parked candidate above has a plausible path
back into one of them. Rejecting them again is not free; do not re-derive.

- **No script or run orchestration layer** — pi-link's orchestrator is an LLM, not
  code: no script-as-orchestrator, saved `/command` runs, cached or resumable agent
  results, concurrency caps or approval-before-launch UX.
- **No restored prompt/broadcast machinery, and no chat receipts** — remote prompt
  execution and `to: "*"` fan-out were removed on purpose, and chat delivery gets no
  receipts and no blocking chat RPC: it stays one unified, attributed, non-blocking
  path. This is about agent messages only — a `link_compact` outcome is not a chat
  RPC: pi-link itself produces it, correlated by request ID, as a notification.
- **No mixed-version compatibility branch** — behavior holds when every terminal
  runs the same version; upgrade and restart together.
- **No implicit group selector or fan-out** — a target is always one terminal's
  literal name, and the literal name `@g` stays an ordinary addressable identity.
- **No broad wire or roster redesign** — no per-group rosters, filtered membership
  messages, or new tool parameters, settings and persisted state for the above.

The 0.6.1 review raised the next three as removable and withdrew each one. They are
kept on purpose:

- **The `link_compact` abort pre-check stays** — "an already-aborted call sends
  nothing" is part of the 0.6.0 contract and is tested (inbox 6i). An isolated probe
  of Pi 1.5.2's real `runToolCall` also showed an executor receiving a signal that
  was already aborted.
- **The `busy` and `unsupported` reason texts stay** — they only word a reason
  received from a target on an earlier version. 0.6.1 removed the producer and kept
  the text deliberately; this is not a mixed-version compatibility branch.
- **`pi-link --status` keeps validating the fields it prints** — the port does not
  authenticate who answers, and 0.5.0 already reduced the checks to what the table
  draws.
