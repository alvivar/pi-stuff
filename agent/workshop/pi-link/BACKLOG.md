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

### BL-1 — Routing failure visible to the sending agent

**Priority:** 1 — principal candidate. **Status:** Open, no design pinned.

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

### BL-2 — Remote model / thinking control

**Priority:** 2. **Status:** Parked.

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

**Priority:** 3. **Status:** Parked.

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

**Priority:** 4. **Status:** Parked.

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

**Priority:** 5 — low, cosmetic. **Status:** Parked.

`--status` lists every terminal of every group in one flat table.

*Outcome sought:* output grouped by `@group`, so a multi-group fleet reads more
easily. Cosmetic only; no behavior, payload or exit-code change.

*Revisit when:* someone routinely reads a fleet large enough for the flat table to
be the friction.

*Constraints:* this is ordering of the existing output. It is not `--status <group>`
— a filter that was declined because the group is readable by eye — and it must not
grow into one.

### BL-6 — Release the inbox when a compaction fails

**Priority:** 6 — low; the cost is a delay, not a loss. **Status:** Open, no design pinned.

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
delivery into a compaction still running. Requires raising `MIN_PI_VERSION` to
0.84.3; no compatibility branch for the floor below it.

### BL-7 — `!ctx.compact` guard and the `"unsupported"` reason

**Priority:** 7 — cleanup. **Status:** Open.

`compact` is a required member of `ExtensionContext` on every supported Pi
(`types.d.ts` 246), so the `!ctx.compact` sub-guard in the `compact_request`
handler defends a case the API excludes. Whether the whole `"unsupported"` result
is reachable depends on `!ctx`, which no path was found to reach by reading.

*Outcome sought:* either the branch is shown reachable and stays, or it goes with
README's "unsupported" bullet and test B1 in `lifecycle-compact-test.mjs`.

*Constraints:* a removal is a behavior change to a documented result; it travels
with its documentation and test in one commit.

## Decisions not to reopen without new evidence

These were decided against, and each parked candidate above has a plausible path
back into one of them. Rejecting them again is not free; do not re-derive.

- **No script or run orchestration layer** — pi-link's orchestrator is an LLM, not
  code: no script-as-orchestrator, saved `/command` runs, cached or resumable agent
  results, concurrency caps or approval-before-launch UX.
- **No restored prompt/broadcast machinery, and no chat receipts** — remote prompt
  execution and `to: "*"` fan-out were removed on purpose, and chat delivery gets no
  receipts and no blocking chat RPC: it stays one unified, attributed, non-blocking
  path. This is about agent messages only — `link_compact` remains what it is, a
  request/response tool that waits for the target's result.
- **No mixed-version compatibility branch** — behavior holds when every terminal
  runs the same version; upgrade and restart together.
- **No implicit group selector or fan-out** — a target is always one terminal's
  literal name, and the literal name `@g` stays an ordinary addressable identity.
- **No broad wire or roster redesign** — no per-group rosters, filtered membership
  messages, or new tool parameters, settings and persisted state for the above.
