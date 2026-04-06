# Code Review — claude-code-provider/index.ts

Joint review by opus and gpt, validated against Pi API docs and types.

## What's solid

- **Single-file, no premature splitting.** One file, direct imperative flow from CLI spawn to Pi event stream.
- **Defensive JSON parsing is earned.** Claude CLI emits inconsistent field names (`input` vs `input_tokens`, `duration_ms` vs `durationMs`, etc.). The verbosity here is the cost of robustness.
- **Dual render path (stream_event vs assistant_snapshot)** is complex but justified. Each Map names exactly what it tracks. Consolidating into nested objects wouldn't reduce actual complexity.
- **Tool traces as inline text** is confirmed correct by Pi API: `toolCall` content blocks have execution semantics. There is no display-only content type. Inline text is the least-wrong mapping.
- **Debug logging** is simple — append-only JSON lines to a file. No framework.
- **`streamSimple` signature** uses `.bind()` for closure state, which is the standard Pi pattern for custom providers.
- **No `toolcall_*` events** for Claude internal tools — correct, Pi would try to execute them.

## What to fix

Priority order. Each item is concrete and deletional — no new abstractions.

### 1. Simplify bootstrap/compaction persistence

**The problem:** ~150 lines of custom entry protocols, full runtime type guards, append/restore/consume lifecycle with in-memory mirrors. Pi's `appendEntry`/`getBranch` already handles opaque JSON round-trips. The data we store is simple (version, streamKey, summary, cost, timestamps). Full runtime type guards on self-authored data are unnecessary.

**The fix:**
- Replace `isPendingBootstrapEntryData()` and `isPendingBootstrapConsumedEntryData()` with `entry.data?.version === 1` check + cast.
- Inline `appendPendingBootstrapEntry()` and `appendPendingBootstrapConsumedEntry()` — they're thin wrappers around `pi.appendEntry()`.
- Keep `restorePendingBootstrapStateForStreamKey()` as a named function — it has real scanning + "pending until consumed" logic that makes the `before_agent_start` handler more readable.
- **Keep the staging map** (`pendingBootstrapAwaitingCompactionBySession`) — `session_compact` event only gives us `compactionEntry` (id, summary, firstKeptEntryId, tokensBefore), not our staging data (summary text for bootstrap, compactCostTotalUsd). The bridge between `session_before_compact` and `session_compact` is necessary.

**Impact:** ~40–60 lines touched, ~20–35 lines net deleted. Same behavior.

### 2. Inline tiny one-use helpers

**The problem:** `compactWhitespace()`, `truncate()`, `previewPath()` are each 1–3 lines, called from one or two places. They add indirection below the abstraction threshold.

**The fix:** Fold into their call sites (`formatToolArgsPreview` / `formatGenericToolArgsPreview`). Keep `asNumber()` — it centralizes the finite-number rule across multiple extraction paths and earns its existence.

**Impact:** ~20–40 lines touched, ~10–20 lines net deleted.

### 3. Flatten usage/metadata type aliases

**The problem:** `RateLimitInfoLike` and `RunMetadataLike` are purely internal debug-logging shapes with zero Pi API surface. They're used only in extraction functions that feed `debugLog()`. `UsageLike` is more borderline — it does real work normalizing CLI JSON into a shape close to Pi's `Usage`, but with flat `costTotal` instead of nested `cost`.

**The fix:**
- **Delete** `RateLimitInfoLike` and `RunMetadataLike`. Return inline objects or untyped from their extraction functions — the consumers are just `debugLog()`.
- **Keep or inline `UsageLike`** — it's a genuine intermediate normalization shape (flat `costTotal`, optional fields). Don't force it into `Partial<Usage>` since it serves a different purpose. If it stays, it stays as a small internal type. If we're editing nearby, consider inlining.

**Impact:** ~15–25 lines touched for the clear deletions. `UsageLike` decision is contextual.

### 4. Trim tool preview formatting surface area

**The problem:** ~100 lines of preview formatting for what is a debug/trace nicety. The per-tool special cases (edit, read, write, bash, todowrite) are individually useful, but the generic fallback path and some helper layering add more surface than the feature earns.

**The fix:** Keep explicit per-tool cases — they help readability. Trim the generic fallback and reduce layering between `formatToolArgsPreview` and `formatGenericToolArgsPreview`.

**Impact:** ~40–80 lines touched, ~20–40 lines net deleted.

### 5. Consolidate parallel tool-trace Maps

**The problem:** Four parallel Maps track tool trace state per block: `toolTraceNameByBlock`, `toolTraceSequenceByBlock`, `toolTraceInitialInputByBlock`, `toolTraceDeltaJsonByBlock`. They're always read/written together.

**The fix:** One `toolTraceByBlock: Map<number, { name, sequence, initialInput, deltaJson }>`. Same direct style, less coordination overhead.

**Impact:** ~40–70 lines touched, neutral to slight net deletion. Only worth doing alongside nearby work.

## What not to change

- **Dual render path state machinery** — complex but earned. Don't consolidate unless there's a concrete bug.
- **Defensive upstream JSON parsing** — verbosity is justified by CLI shape drift.
- **Core streaming logic** — aligned with Andre's style as-is.
- **File structure** — keep single-file until there's a real reason to split.
- **Staging map between compact events** — `session_compact` doesn't carry through our staging data; the bridge is necessary.
- **`restorePendingBootstrapStateForStreamKey()`** — real logic, keeps the event handler readable.

## Style principles for changes

- Prefer deletion over abstraction.
- Every line should justify its existence.
- Don't add helpers for things done once.
- Keep it imperative and readable.
- If in doubt, inline it.
