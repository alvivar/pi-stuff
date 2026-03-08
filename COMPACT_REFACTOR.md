# Compact refactor plan — Claude Code provider

## Goal

Make `/compact` meaningful for the Claude Code provider by compacting the **real memory surface** that matters: the resumed Claude Code CLI session.

Today, Pi compaction for `claude-code` is mostly local transcript housekeeping. The real memory lives in the Claude CLI session resumed via `--resume`.

For V1, `/compact` should mean **manual session rebase**:

1. Ask the **current resumed Claude session** for a carry-forward summary
2. Save that summary as Pi's compaction artifact
3. Stop resuming the old Claude session
4. Save the summary for the **next** user turn
5. Start the next user turn in a **fresh Claude session**
6. Continue from the new `session_id`

---

## Why this approach

Current mismatch:

- Pi compacts **Pi-local session history**
- Claude Code memory lives in the CLI session resumed via `--resume`
- So current compaction does **not actually reduce Claude's working memory**

Claude headless mode does not appear to expose a native "compact this session" API, so this must be a **provider-built workflow**.

---

## Chosen V1 behavior

### Scope

- **Manual `/compact` only** for `claude-code`
- **No auto-compaction rebase** in V1
- **No Pi core changes** unless implementation forces them
- **No attempt to make this lossless**

### High-level behavior

When `/compact` is run while using `claude-code`:

- ask the **current Claude session** to summarize the active work
- do that as a **no-tools internal request**
- store the returned summary as Pi's compaction entry
- clear the old remembered Claude session id
- persist a pending bootstrap summary for the next turn
- show one user-visible notice

On the **next** user turn:

- if a pending bootstrap summary exists for the current `streamKey`
- and there is no Claude session id to resume
- prepend the bootstrap summary to the user prompt
- start a fresh Claude session without `--resume`
- once that succeeds and yields a new `session_id`, mark the bootstrap summary consumed

### Important decisions

- Use the **current resumed Claude session** as the source of truth
- Reuse **Pi's summary structure**, but use a **Claude-session-specific summarization prompt**
- Inject the summary into the **first user prompt only**
- Do **not** auto-send a bootstrap turn
- Show **one notice immediately after `/compact` succeeds**
- Fully discard the old Claude session id after successful rebase preparation
- Persist pending bootstrap state in the Pi session using **`custom` entries**
- Use the existing Claude-session **`streamKey`** as the identity for pending rebases
- The internal summarization request should **not** appear as a normal Pi chat turn

---

## Exact prompts

### 1. Summarization prompt used during `/compact`

```text
Summarize the active work in this Claude Code session so a fresh Claude Code session can continue it seamlessly after compaction/rebase.

This is a carry-forward checkpoint, not a user-facing response. Do not continue the task. Do not ask follow-up questions. Do not use tools. Output only the structured summary below.

Use this exact format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [User requirements, preferences, constraints]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blocking issues, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Most likely next action]
2. [Next action]
3. [Next action]

## Critical Context
- [Exact file paths, function/class names, errors, assumptions, unresolved questions, important modified/read files, or other details needed to continue]

Requirements:
- Preserve exact file paths, function names, error messages, and pending work when important.
- Include modified files and especially relevant/read files when helpful.
- Preserve unresolved questions, assumptions, and next steps.
- Keep the summary concise but continuation-ready.
- Output only the summary in the format above.
```

### 2. Bootstrap wrapper for the first fresh-session user turn

```text
Use the following carry-forward context from a previous Claude Code session as background context for this conversation. It is a checkpoint summary, not a separate task. Do not respond to or restate the summary unless the current request requires it.

<context-summary>
...
</context-summary>

Focus on the current user request below.

<current-user-request>
...
</current-user-request>
```

---

## Persisted state

Use Pi session **`custom` entries** as the durable source of truth.

Why:

- survives restart / reload
- fits Pi's append-only session model
- does **not** participate in LLM context

### Entry types

#### Pending bootstrap

```ts
customType: "claude-code-provider/pending-bootstrap"
data: {
  version: 1,
  streamKey: "...",
  compactionEntryId: "...",
  summary: "...",
  createdAt: "..."
}
```

#### Consumed bootstrap

```ts
customType: "claude-code-provider/pending-bootstrap-consumed"
data: {
  version: 1,
  streamKey: "...",
  compactionEntryId: "...",
  consumedAt: "..."
}
```

### Reconstruction rule

For the current `streamKey`:

- find the latest relevant `pending-bootstrap` entry
- if there is a later matching `pending-bootstrap-consumed` entry, it is no longer pending
- otherwise it is still pending and should be used for the next fresh-session turn

### Identity

Use the existing provider identity scheme for V1:

- `${options?.sessionId || "default"}:${model.id}`

Optional debug metadata can be added later if needed, but it is **not required** for the minimal V1 flow.

---

## Control flow

### A. Manual `/compact`

Hook: `pi.on("session_before_compact", ...)`

When provider is `claude-code`:

1. Compute `streamKey`
2. Check whether a remembered Claude `session_id` exists for that key
3. If no remembered session exists:
   - do **not** attempt rebase compaction
   - show a clear notice that there is no active Claude Code session to compact yet
4. If a remembered session exists:
   - send the summarization prompt to the **existing resumed Claude session**
   - do that as a **no-tools internal request**
   - parse the returned summary text
   - return that summary as Pi's compaction artifact
   - clear the remembered Claude session id for that key
   - append a `pending-bootstrap` custom entry
   - optionally mirror it in memory for convenience
   - show this notice:
     - `Claude session checkpointed. Your next message will start a fresh Claude session from the compacted context.`

### B. Next normal turn after `/compact`

In `streamClaudeCli(...)`:

1. Compute `streamKey`
2. Restore pending bootstrap state from session `custom` entries if needed
3. If a pending bootstrap summary exists for that key **and** there is no remembered Claude session id:
   - wrap the next user request using the bootstrap wrapper
   - start a fresh Claude session **without `--resume`**
4. Once that fresh turn succeeds and yields a new usable `session_id`:
   - save the new `session_id` in `sessionMap`
   - append a `pending-bootstrap-consumed` custom entry
   - clear any in-memory pending state for that key

### Clear-after-success rule

Only clear/consume the pending bootstrap summary **after** the first fresh-session turn succeeds and establishes the new Claude session.

Do **not** clear it earlier.

---

## User-visible notices

### Successful `/compact`

Show exactly one notice immediately after `/compact` succeeds:

`Claude session checkpointed. Your next message will start a fresh Claude session from the compacted context.`

### No active Claude session to compact

Show a clear notice such as:

`No active Claude Code session to compact yet.`

---

## What not to do in V1

- Do **not** use auto-compaction for session rebasing
- Do **not** inject bootstrap context into the system prompt
- Do **not** auto-send a bootstrap turn
- Do **not** surface the internal summarization request/response as a normal chat turn
- Do **not** keep the old Claude session id after successful rebase preparation
- Do **not** use `custom_message` for bootstrap persistence
- Do **not** introduce a separate provider-owned persistence file unless session-backed state proves insufficient

---

## Implementation status

### Completed

- **Phase 1 — state helpers**
  - Added shared `streamKey` helper reuse
  - Added pending-bootstrap custom entry constants/types
  - Added helpers to append pending-bootstrap and consumed entries
  - Added helper to restore pending bootstrap state for a `streamKey`
- **Phase 2 — `/compact` happy path**
  - `session_before_compact` now intercepts `claude-code` compaction requests
  - If no remembered Claude session exists, `/compact` shows a clear notice and cancels
  - If a remembered Claude session exists, the provider sends a **no-tools** internal summarization request to the resumed Claude session
  - The returned summary is used as Pi's compaction artifact
  - After compaction completes, the provider persists a `pending-bootstrap` custom entry, clears the old remembered Claude session id, mirrors the pending state in memory, and shows the checkpoint notice

### Not implemented yet

- **Phase 3 — next-turn bootstrap injection**
- **Phase 4 — consume after successful fresh-session start**
- **Phase 5 — logging/docs polish** beyond the minimal logging already added for the compact path

### Current partial behavior

Right now `/compact` can checkpoint the current Claude session and persist the pending bootstrap summary, but the next normal user turn does **not yet** consume that summary automatically. That wiring is still part of Phase 3 and Phase 4.

---

## Preferred implementation order

Build this as a thin vertical slice with small diffs, mostly in `agent/extensions/claude-code-provider/index.ts`.

### Phase 1 — state helpers

Add the smallest possible helper layer for pending bootstrap state:

1. `streamKey` helper reuse/alignment
2. constants for:
   - `claude-code-provider/pending-bootstrap`
   - `claude-code-provider/pending-bootstrap-consumed`
3. helpers to:
   - append pending-bootstrap custom entry
   - append consumed custom entry
   - restore pending bootstrap state for a `streamKey`

Keep this minimal. Optional/debug-only state should wait unless implementation proves it is needed.

### Phase 2 — `/compact` happy path

In `session_before_compact`:

1. keep non-`claude-code` behavior unchanged
2. if no remembered Claude session exists:
   - show the "no active Claude Code session to compact yet" notice
   - do not attempt rebase compaction
3. if a remembered Claude session exists:
   - run the internal **no-tools** summarization request against that resumed session
   - return the summary as Pi's compaction artifact
   - clear the old remembered Claude session id
   - persist the pending-bootstrap custom entry
   - show the success notice

### Phase 3 — next-turn bootstrap injection

In the normal Claude request path:

1. compute `streamKey`
2. restore pending bootstrap state if needed
3. if pending bootstrap exists **and** there is no remembered Claude session id:
   - wrap the next user request with the bootstrap wrapper
   - start a fresh Claude session without `--resume`

### Phase 4 — consume after successful fresh-session start

In the response/session-id success path:

1. once the fresh turn succeeds and yields a usable new `session_id`:
   - save the new `session_id`
   - append the `pending-bootstrap-consumed` custom entry
   - clear any in-memory pending state

### Phase 5 — logging and docs

After the happy path works:

1. add compact-specific `debugLog(...)` entries for start / success / consume
2. update docs to match actual behavior:
   - `CLAUDE_CODE_TRACKING.md`
   - `COMPACT_REFACTOR.md`
   - `TODO.md` only if still needed

### Implementation guardrails

- Prefer one-file code changes in `agent/extensions/claude-code-provider/index.ts`
- Avoid broad provider refactors during V1
- Do not add auto-compaction behavior in this pass
- Do not over-design concurrency/failure handling before the happy path exists

---

## Deferred items

### Failure policy

Still intentionally deferred.

When implementation/testing begins, decide whether `/compact` should:

- hard-fail clearly if summary generation fails
- or fall back to today's cheap stub behavior

For simplicity, the happy path should be implemented first.

### Future enhancements

- revisit auto-compaction semantics for `claude-code`
- add extra debug metadata if it proves useful
- add stronger failure recovery only after real testing exposes a need

---

## Risks / caveats

- The summary is lossy by design
- The summarization request may fail if the current Claude session is already overloaded
- Bad bootstrap formatting could confuse the fresh session, so the wrapper must stay explicit and narrow
- Compaction semantics become provider-specific for `claude-code`
- Split-turn edge cases should be ignored in V1; summarize the whole active Claude session as one checkpoint

---

## Best V1 recommendation

Implement **manual-only session rebasing** for `/compact`:

- ask the current Claude session for a structured carry-forward summary
- do that as a **no-tools** internal request
- store the summary as Pi's compaction entry
- clear the old resumed Claude session
- persist it as pending bootstrap state
- prepend it to the **next** user prompt in a fresh Claude session
- store the new `session_id` and mark the bootstrap state consumed
- do **not** surface the internal summarization request as a normal chat turn

This is the simplest path to making compaction actually meaningful for the Claude Code provider without assuming unsupported Claude APIs.
