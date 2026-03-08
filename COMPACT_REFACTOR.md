# Compact refactor plan — Claude Code provider

## Goal

Make `/compact` meaningful for the Claude Code provider by compacting the **real memory surface** that matters: the resumed Claude Code CLI session.

Today, Pi compaction for `claude-code` is mostly local transcript housekeeping. The provider intercepts `session_before_compact` and returns a cheap stub summary because Pi history is display-only for this provider and the real conversation memory lives in the Claude CLI session via `--resume`.

The idea in this document is to replace or augment that behavior with a **session rebase** flow:

1. Ask the **current Claude session** to generate a structured carry-forward context summary
2. Save that summary as Pi's compaction artifact
3. Start a **fresh Claude session**
4. Seed the fresh session with the carry-forward summary on the next turn
5. Continue normally from the new `session_id`

---

## Why this makes sense

Current mismatch:

- Pi compacts **Pi-local session history**
- Claude Code memory lives in the CLI session resumed via `--resume`
- Therefore current compaction does **not actually reduce Claude's working memory**

A session-rebase compaction would line up the mechanism with the true memory model of this provider.

---

## Constraints / realities

### 1. Claude headless mode does not appear to expose a native "compact this session" API

From `agent/extensions/claude-code-headless.md`, we have:

- `-p`
- `--resume`
- `--continue`
- JSON / stream-json output
- session IDs
- usage / result metadata

But we do **not** currently have evidence of a dedicated CLI primitive for:

- compacting a session in place
- checkpointing memory in a first-class way
- replacing session memory with a summary

So this plan is a **provider-built workflow**, not a native Claude CLI compaction feature.

### 2. Pi does not appear to expose a built-in `/context` slash command in the current core

What we do have is Pi's compaction machinery and summary structure/prompt style.

So the best interpretation of "use Pi /context" is:

- reuse Pi's summary structure and intent
- not necessarily call a literal `/context` built-in command

### 3. For this provider, Claude's current session is the source of truth

Pi's local transcript is incomplete relative to Claude's actual working state.

So if we want a carry-forward summary, the best source is:

- the **current resumed Claude session itself**

not Pi's local display transcript.

---

## Proposed behavior

## Manual `/compact` for `claude-code`

When the active model provider is `claude-code`, `/compact` should behave like this:

### Step 1 — Ask the current Claude session for a carry-forward summary

Use the currently remembered Claude `session_id` and send a structured summarization prompt to that same session.

Important: this should summarize the **current Claude session**, not Pi's local transcript.

### Step 2 — Store that summary as the Pi compaction artifact

Pi should still get a compaction entry so local history remains coherent and the user can inspect what happened.

### Step 3 — Clear the remembered Claude session mapping

After a successful summary is captured, stop resuming the old Claude session.

### Step 4 — Seed a fresh Claude session on the next turn

The next user prompt should prepend or otherwise include the carry-forward summary as bootstrap context.

### Step 5 — Continue using the new Claude `session_id`

Once the first prompt in the fresh session succeeds, store the new `session_id` in `sessionMap` and continue normally.

---

## Design goals

- Make `/compact` actually reduce/reset Claude's working session state
- Keep the implementation provider-local if possible
- Preserve Pi-native UX as much as possible
- Keep the first version manual-only and easy to reason about
- Reuse Pi's existing summary structure where helpful
- Avoid inventing unsupported Claude features

---

## Non-goals for V1

- No auto-compaction integration yet
- No Pi core changes unless absolutely necessary
- No attempt to preserve hidden/internal Claude state beyond what the summary carries forward
- No claim that this is lossless; it is intentionally a checkpoint/rebase

---

## Recommended summary shape

Use a structure close to Pi compaction summaries, because it is already tuned for continuation quality.

Suggested format:

```md
## Goal

...

## Constraints & Preferences

- ...

## Progress

### Done

- [x] ...

### In Progress

- [ ] ...

### Blocked

- ...

## Key Decisions

- **...**: ...

## Next Steps

1. ...

## Critical Context

- ...
```

For this provider, explicitly ask Claude to include:

- exact file paths when important
- modified files
- files heavily read / relevant
- unfinished tasks
- assumptions worth preserving
- known risks or unresolved questions
- brief context for the current branch/task

---

## Prompt strategy

## Preferred source of truth

Ask **the current Claude session** to summarize itself.

Reason:

- it has the real memory
- it knows tool history and internal context better than Pi's display transcript
- it is the thing we are actually trying to rebase

## Recommended prompt style

Use a **Claude-session-specific summarization prompt** that is strongly derived from Pi's compaction structure, rather than reusing Pi's current compaction prompt verbatim.

Recommendation:

- keep Pi's section structure / output shape
- rewrite the instructions for the actual job here: creating a carry-forward checkpoint for a **fresh Claude Code session**

Why:

- Pi's current compaction prompt is transcript-oriented and tuned for summarizing Pi's serialized local history
- this provider needs a handoff/checkpoint prompt aimed at rebasing the **current resumed Claude session**
- the source of truth here is Claude's active session, not Pi's display transcript

So the target prompt should explicitly tell Claude:

- summarize the active work so a fresh Claude Code session can continue seamlessly
- preserve exact file paths, function names, errors, decisions, constraints, and pending work
- include modified files and especially relevant/read files when helpful
- preserve unresolved questions, assumptions, and next steps
- do not continue the task
- output only the structured summary

In short:

- **reuse Pi's summary format**
- **do not reuse Pi's compaction prompt text verbatim**
- prefer a shorter Claude-session-specific variant with Pi-compatible headings

---

## How to inject the summary into the fresh session

Bootstrap context should be injected into the **first user prompt only**.

There are two plausible options in general, but for this plan V1 is explicitly:

### Option A — Prepend bootstrap context to the first user prompt

This is the chosen approach for V1.

Shape:

```text
Use the following carry-forward context from a previous Claude Code session as background context for this conversation. Do not treat it as a separate task by itself.

<context-summary>
...
</context-summary>

Current user request:
...
```

Why this is preferable:

- it is conversation context, not behavior policy
- easier to debug
- easier to keep one-shot
- avoids overloading the system prompt

### Option B — Inject into system prompt for one turn

Possible, but less attractive.

Why not preferred:

- system prompt should remain for policy/instructions
- harder to distinguish from normal provider prompt shaping
- easier to accidentally persist or over-apply

Recommendation: **Option A for V1**.

---

## Proposed provider state additions

Likely minimal additions:

- `pendingBootstrapSummaryByStreamKey: Map<string, string>`
  - stores the carry-forward summary to inject into the next fresh session turn
- optional: `pendingBootstrapSourceByStreamKey` / metadata if we want debugging
- optional: `isCompactingSessionByStreamKey` if needed to guard concurrency

`streamKey` should likely stay aligned with the current provider scheme:

- `${options?.sessionId || "default"}:${model.id}`

---

## Proposed control flow

## A. Manual compact path

Current hook: `pi.on("session_before_compact", ...)`

Today it returns a cheap stub.

Proposed new behavior when provider is `claude-code` and a remembered Claude session exists:

1. Build a summarization prompt
2. Run a Claude CLI request against the **existing resumed session**
3. Parse the returned summary text
4. Store that summary as the compaction result returned to Pi
5. Clear the remembered session ID for that stream key
6. Save the summary in `pendingBootstrapSummaryByStreamKey`

If anything fails:

- either abort compaction with a clear error
- or fall back to today's cheap stub behavior

Recommendation for V1:

- prefer a clear error or an explicit fallback policy decided up front
- do not silently hide failures

## B. Next normal turn after compact

In `streamClaudeCli(...)`:

1. Compute `streamKey`
2. Check whether there is a pending bootstrap summary for this key
3. If yes **and** there is no remembered session ID being resumed:
   - prepend the bootstrap summary to the user prompt
   - start a fresh Claude session without `--resume`
4. Once a successful response yields a new `session_id`:
   - save it in `sessionMap`
   - clear the pending bootstrap summary for that key

Important:

- only consume the bootstrap summary once the fresh session actually starts successfully
- avoid clearing it too early

---

## Minimal V1 implementation plan

### Phase 1 — manual-only session rebase compact

- Add a helper to request a compact summary from the current Claude session
- Use the existing `session_before_compact` hook to call that helper for `claude-code`
- Save the returned summary as Pi compaction content
- Clear the old remembered Claude session
- Save bootstrap summary for the next turn
- Prepend bootstrap summary to the next prompt when starting the fresh session

### Phase 2 — diagnostics / observability

- Log compact-start / compact-summary / compact-rebase events to `~/.pi/agent/debug.log`
- Log whether post-compact turn used bootstrap summary
- Log old and new session IDs, carefully and only where appropriate

### Phase 3 — polish

- Possibly add a dedicated info message or notification explaining:
  - old Claude session was checkpointed
  - next turn started a fresh Claude session

---

## Recommended fallback behavior

There are two reasonable choices.

### Fallback A — strict

If summary generation from the current Claude session fails:

- fail `/compact`
- tell the user the Claude session checkpoint failed

Pros:

- honest
- no hidden semantic downgrade

Cons:

- more disruptive

### Fallback B — degrade to today's local stub compact

If summary generation fails:

- return today's cheap local stub compaction instead
- do not clear the old Claude session

Pros:

- safer operationally
- user still gets some Pi-local cleanup

Cons:

- semantic mismatch remains
- could surprise the user if not made visible

Recommendation for V1:

- either strict failure, or fallback with explicit notification/logging
- avoid silent downgrade

---

## Risks / caveats

### 1. The summarization request may fail if the current Claude session is already too overloaded

If the upstream session is already near or over its limits, even asking for the summary may be fragile.

Implication:

- manual compaction should ideally be used before catastrophic overflow
- auto-compaction should wait until this manual path is proven reliable

### 2. The summary is lossy

A fresh session only has:

- the summary
- the repo/files on disk
- the next user prompt

Some nuanced working memory may be lost.

### 3. Bad bootstrap formatting could confuse the fresh session

If the carry-forward context is injected poorly, Claude may respond to the summary itself instead of the actual task.

This is why the bootstrap wrapper should be explicit and narrow.

### 4. Compaction semantics become provider-specific

For `claude-code`, `/compact` would mean more than local transcript compaction.

That is acceptable, but it should be documented.

### 5. Split-turn edge cases

Pi compaction supports split-turn summaries. A Claude-session summary may not map 1:1 to Pi's split-turn semantics.

Recommendation:

- keep V1 simple
- summarize the entire active Claude session context in one checkpoint
- do not overfit to Pi's split-turn internals initially

---

## Open questions

1. Summarization prompt shape:
   - Recommendation: use a **shorter Claude-session-specific variant** that keeps Pi's section structure but does not reuse Pi's compaction prompt text verbatim.
2. On failure, should `/compact` fail hard or fall back to today's cheap stub?
3. Bootstrap summary injection:
   - Decision: inject it into the **first user prompt only**.
   - Do not use a one-time system prompt in V1.
4. Should we surface a user-visible notice that the Claude session was reset/rebased?
5. Should the old session ID be retained anywhere for debugging, or fully discarded after success?
6. Should a manual `/compact` immediately trigger a bootstrap turn, or simply prepare the next user turn to start fresh?

Recommendation:

- do **not** auto-send a bootstrap turn in V1
- prepare the next user turn to start fresh

---

## Best V1 recommendation

Implement **manual-only session rebasing** for `/compact`:

- ask the current Claude session for a structured carry-forward summary
- store it as Pi's compaction entry
- clear the old resumed Claude session
- prepend the summary to the next user prompt in a fresh Claude session
- store the new `session_id` and continue normally from there

This is the cleanest path to making compaction actually meaningful for the Claude Code provider without assuming unsupported Claude APIs.
