# TODO — Improve Claude Code provider without Pi core changes

## Goal

Make Claude internal tool activity feel more native in Pi without modifying Pi core.

## Plan

### 1. Simplify trace structure while keeping verbose output

- [ ] Keep verbose tool visibility by default
- [ ] Remove provider-side verbosity control work
- [ ] Keep raw details available in `debug.log`
- [ ] Preserve enough inline detail to stay transparent and debuggable

### 2. Replace the current heavy lifecycle formatting

- [ ] Rework `beginToolTrace(...)` / `endToolTrace(...)` formatting
- [ ] Apply the same formatting cleanup to snapshot tool traces
- [ ] Replace heavy `[tool #N start/end]` formatting with a cleaner verbose style
- [ ] Reevaluate whether numbering is actually helping readability
- [ ] Remove or reduce visual noise from separator lines if they feel non-native

### 3. Improve visual style without hiding tools

- [ ] Add or refine `formatToolTraceLine(...)` helper
- [ ] Use the target one-line format:
  - [ ] `↳ read — file=src/index.ts`
  - [ ] `↳ edit — file=src/index.ts old=158c new=163c`
- [ ] Prefer lighter prefixes like `↳ tool — summary`
- [ ] Keep all tool types visible, including low-value tools
- [ ] Avoid raw JSON dumps in assistant text when a compact preview is possible
- [ ] Remove numbering from tool traces
- [ ] Remove separator lines from tool traces

### 4. Defer spacing changes until after formatting cleanup

- [ ] Do not add new artificial newline hacks first
- [ ] Validate whether cleaner verbose formatting already fixes most UX issues
- [ ] Only if still needed, keep trace + nearby prose in the same rendered text block when possible
- [ ] Continue avoiding block-boundary `\n\n` tricks and invisible spacer hacks

### 5. Validate UX with real streams

- [ ] Test long interactive streams
- [ ] Check prose ↔ trace transitions
- [ ] Verify no ordering regressions
- [ ] Verify output feels closer to native Pi
- [ ] Verify verbose traces remain readable during long tool-heavy runs

### 6. Update docs

- [ ] Sync `agent/extensions/claude-code-provider/CLAUDE_CODE_TRACKING.md`
- [ ] Document the cleaned-up verbose trace behavior
- [ ] Document that all tool types remain visible by default

## Preferred target UX

Example:

```text
I found the particle size constants.

↳ read — file=src/index.ts
↳ edit — file=src/index.ts old=158c new=163c

I’ve updated the file.
```

## Notes

- Do not use Pi native `toolCall` for Claude internal tools
- Do not add more artificial newline hacks
- Prefer smaller provider-only diffs in `agent/extensions/claude-code-provider/index.ts`
