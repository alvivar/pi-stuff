# Code Review — claude-code-provider/index.ts

Joint review by opus and gpt before new feature work.

## What's solid

- **Single-file, no premature splitting.** One file, direct imperative flow from CLI spawn to Pi event stream.
- **Defensive JSON parsing is earned.** Claude CLI emits inconsistent field names (`input` vs `input_tokens`, `duration_ms` vs `durationMs`, etc.). The verbosity here is the cost of robustness.
- **Dual render path (stream_event vs assistant_snapshot)** is complex but justified. Each Map names exactly what it tracks. Consolidating into nested objects wouldn't reduce actual complexity.
- **Tool traces as inline text** is the correct architectural choice given Pi's content model constraints (documented in INTEGRATION.md).
- **Debug logging** is simple — append-only JSON lines to a file. No framework.

## What to fix

Priority order. Each item is concrete and deletional — no new abstractions.

### 1. Simplify bootstrap/compaction persistence

**The problem:** ~150 lines of custom entry protocols, full runtime type guards, append/restore/consume lifecycle with in-memory mirrors. This is the most "enterprise-y" pocket in the file — for what is essentially "save a summary string, load it next time, mark it used."

**The fix:** Replace `isPendingBootstrapEntryData()` and `isPendingBootstrapConsumedEntryData()` with `version === 1` check + cast. Collapse the append/restore helpers into smaller inline blocks.

**Impact:** ~60–100 lines touched, ~30–50 lines net deleted. Same behavior, much less ceremony.

### 2. Inline tiny one-use helpers

**The problem:** `compactWhitespace()`, `truncate()`, `previewPath()` are each 1–3 lines, called from one or two places. They add indirection below the abstraction threshold.

**The fix:** Fold into their call sites (`formatToolArgsPreview` / `formatGenericToolArgsPreview`). Keep `asNumber()` — it centralizes the finite-number rule across multiple extraction paths and earns its existence.

**Impact:** ~20–40 lines touched, ~10–20 lines net deleted.

### 3. Flatten usage/metadata type aliases

**The problem:** `UsageLike`, `RateLimitInfoLike`, `RunMetadataLike` are local DTOs wrapping untrusted CLI JSON. They're type definitions that don't carry real semantic weight — the code would read just as clearly with inline shapes or direct returns.

**The fix:** Remove the named type aliases. Use inline return types on the extraction functions, or just return untyped objects where the consumer immediately destructures.

**Impact:** ~20–35 lines touched, small net deletion.

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

## Style principles for changes

- Prefer deletion over abstraction.
- Every line should justify its existence.
- Don't add helpers for things done once.
- Keep it imperative and readable.
- If in doubt, inline it.
