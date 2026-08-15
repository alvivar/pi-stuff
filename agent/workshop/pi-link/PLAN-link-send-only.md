# PLAN — Async-only agent messaging

> **Status:** Draft adapted after Fable / Opus / Sol review
> **Last aligned:** 2026-07-17
> **Build from this?** Not until the owner accepts this final draft.

## Goal

Give agents one communication tool: `link_send`.

- Omitting `triggerTurn` defaults to `true`.
- Explicit `triggerTurn:false` preserves immediate, non-waking steering.
- Remove `link_prompt` completely.

This keeps the normal path asynchronous and returns control immediately while
removing the false-default stall, prompt blocking, busy-bounce, deadlock, and
Golden Rule failure classes.

## Final behavior

| Call | Behavior |
| --- | --- |
| `link_send({ to, message })` | Queue until the receiver is idle, then start a turn |
| `link_send({ to, message, triggerTurn:true })` | Same explicit behavior |
| `link_send({ to, message, triggerTurn:false })` | Deliver immediately as non-waking steer |
| `link_send({ to:"*", message })` | Trigger every other terminal; warn about fan-out in tool guidance |
| `/link-broadcast <message>` | Keep the existing human-facing, non-waking announcement behavior |

`link_prompt` no longer exists. Same-turn remote composition, correlated prompt
responses, prompt timeouts, and prompt disconnect errors are intentionally
removed. Async `DONE` / `BLOCKED` callbacks remain a coordination convention,
not a protocol guarantee.

## Task 1 — Make triggered send the default

**File:** `index.ts`

1. Update the `link_send` schema and description: omission means
   `triggerTurn:true`; explicit false is for intentional steering/FYI delivery.
   The tool description must warn that omitted/true with `to:"*"` wakes every
   other terminal and that false is the announcement form.
2. In `execute`, compute the effective value once:

   ```ts
   const triggerTurn = params.triggerTurn ?? true;
   ```

   Use it for both the outgoing `ChatMsg` and returned result details.
3. Update `renderCall` using effective semantics:
   - ordinary direct omitted/true: no badge;
   - explicit false: exact badge `(no turn)`;
   - omitted/true `to:"*"`: exact badge `(trigger all)`.
4. Keep `to:"*"` under the same default; do not add target-dependent behavior.
5. Keep `/link-broadcast` explicitly `triggerTurn:false`. Describe it as a
   non-waking human announcement that does not request replies; point agents
   that need to wake every terminal to `link_send({ to:"*", ... })`.

**Do not:** change inbox batching, idle gating, the false delivery branch, or
message wrapping.

**Gate:** esbuild bundle succeeds; diff shows one effective-default expression;
manual renderer inspection confirms the three exact states above.

## Task 2 — Remove `link_prompt` end to end

**File:** `index.ts`

Delete prompt-only behavior rather than hiding it behind configuration:

1. Remove prompt constants, request/response wire interfaces, and union members.
2. Remove sender/receiver prompt state, keepalive state, timeout helpers, and
   cleanup paths. Remove `KEEPALIVE_INTERVAL_MS`, which is prompt-only.
3. Remove prompt routing, hub forwarding/not-found synthesis, incoming request
   and response handlers, disconnect/terminal-left cleanup, and the automatic
   `agent_end` response. Remove or underscore the now-unused `agent_end` event
   parameter while preserving status push and inbox wakeup.
4. Remove the `link_prompt` tool registration and renderer.
5. At shared sites, edit only the prompt coupling:
   - compact's busy guard becomes `agentRunning || compactRunning`;
   - shared disconnect cleanup drops only prompt/keepalive state;
   - status handling drops only prompt inactivity resets.
6. Update the file header/tool count.

Preserve all independent infrastructure:

- `link_compact` request/response state, timeout, abort, and disconnect paths;
- `agentRunning`, `compactRunning`, status/context tracking, and `pushStatus`;
- chat routing, inbox delivery, hub election, and reconnect behavior;
- `crypto`, which remains used outside prompt handling.

Mixed-version prompt RPC is unsupported. Do not retain tombstones or dormant
wire handlers; release notes will tell users to upgrade/restart linked terminals
together.

**Gate:** esbuild bundle succeeds; the scoped zero-match checks in Task 4 find
no live prompt machinery in `index.ts`; `link_send`, `link_list`, and
`link_compact` remain registered.

## Task 3 — Rewrite user and model guidance

**Files:** `README.md`, `skills/pi-link-coordination/SKILL.md`

### README

1. Present `link_send` as the sole agent messaging tool.
2. Document default-true delivery, explicit-false steering, idle gating,
   batching, and callback convention.
3. Warn that omitted/true `to:"*"` wakes every other terminal; use false for
   announcements.
4. Keep `/link-broadcast` documented as a non-waking human announcement.
5. Remove prompt examples, RPC protocol/state documentation, busy-rejection
   troubleshooting, and prompt diagrams.
6. Keep `link_compact` clearly described as a separate bounded blocking tool.

### Coordination skill

1. Remove `link_prompt`, the Golden Rule, sync/async selection, and prompt busy
   guidance.
2. Make ordinary dispatch concise: omit `triggerTurn` or pass true; request a
   tagged `DONE` / `BLOCKED` callback when completion matters.
3. Reserve explicit false for FYI/status messages and intentional live steering.
   Require sender/task identity because false delivery remains raw.
4. State that callbacks are conventional and uncorrelated; track outstanding
   workers and use `link_list` when a callback is missing.
5. Keep acyclic delegation, self-contained messages, parallel batching,
   predictive compaction, and no acknowledgement-of-acknowledgement loops.
   Instruct receivers that a message requiring no action gets no reply.

Historical `CHANGELOG.md` entries remain historical and are not rewritten.
Version metadata and a new release entry are owner-managed and out of scope.

**Gate:** no current README/skill instruction recommends `link_prompt` or says
omitted `triggerTurn` is false; cross-links and examples remain coherent.

## Task 4 — Validate the complete behavior

Run mechanical gates:

```sh
npx --yes esbuild index.ts --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:ws --external:typebox \
  --external:node:* --outfile=/tmp/pi-link-check.mjs
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs
! rg -n 'PROMPT_|Prompt(Request|Response)Msg|pendingPromptResponses|pendingRemotePrompt|keepaliveTimer|cleanupPending\(|makeInactivityTimeout|resetInactivityFor|prompt_request|prompt_response|name: "link_prompt"' index.ts
! rg -n 'link_prompt|prompt_request|prompt_response|pendingRemotePrompt|pendingPromptResponses|Golden Rule' README.md skills/pi-link-coordination/SKILL.md
rg -n 'name: "link_(send|list|compact)"' index.ts
git diff --check
```

The zero-match documentation check intentionally excludes historical
`CHANGELOG.md` entries.

Then install/reload the changed extension across a same-version mesh of at
least three terminals and verify live:

1. Omitted direct `triggerTurn` reaches an idle receiver as a wrapped
   `[Link: 1 message(s) received]` block and starts a turn. When the test message
   explicitly requests a tagged callback, verify that convention separately.
2. Explicit true has the same delivery behavior.
3. Explicit false reaches a busy receiver immediately as steer.
4. Explicit false sent to an idle receiver is visible while the receiver remains
   idle; it does not start a turn.
5. Omitted/true sent to a busy receiver queues without interrupting its current
   work and surfaces at the next turn boundary.
6. Omitted `to:"*"` wakes all other terminals and renders `(trigger all)`;
   explicit false wakes none and renders `(no turn)`.
7. `/link-broadcast` remains non-waking and does not request replies.
8. `link_prompt` is absent from the available tool list.
9. `link_compact` still succeeds against an idle target and declines a busy one.
10. Hub/client routing, reconnect, `link_list`, and status/context updates still
    work after prompt protocol removal.
11. While `link_compact` runs on a target, send that target an omitted-`triggerTurn`
    message; confirm it does not start a turn mid-compaction and instead surfaces
    after compaction completes. The default flip routes ordinary traffic through
    the inbox, which widens the known compact-race window tracked separately in
    `REPORT-compact-race.md`; this step observes that exposure without changing
    the machinery.

Record the live results in the implementation report or commit handoff; do not
add a permanent test framework solely for this change.

**Release-handoff gate:** Record that prompt RPC is unsupported in a
mixed-version mesh and that all linked terminals must be upgraded and restarted
together. Publishing is blocked until the owner carries this warning into the
release notes. This is a handoff requirement, not compatibility code.

## Sequencing and commits

Tasks are serialized because Tasks 1 and 2 both edit `index.ts`, but Tasks 1–3
form one public API change and land as one coherent commit.

1. Task 1 → implement → gate → incremental independent review; do not commit.
2. Task 2 → implement → gate → incremental independent review; do not commit.
3. Task 3 → docs/skill review → holistic review of Tasks 1–3 → one feature commit.
4. Task 4 → live release gate; fix any regression through the same review loop
   and a follow-up commit if needed.

Do not publish between tasks. No version bump, package/lockfile edit, CHANGELOG
release entry, publish, or installation outside the explicit live-test step is
authorized by this plan.
