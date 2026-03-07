# TODO — Improve Claude Code provider without Pi core changes

## Goal

Make Claude internal tool activity feel more native in Pi without modifying Pi core.

## Plan

### 1. Simplify trace structure while keeping verbose output

- [x] Keep verbose tool visibility by default
- [x] Remove provider-side verbosity control work
- [x] Keep raw details available in `debug.log`
- [x] Preserve enough inline detail to stay transparent and debuggable

### 2. Replace the current heavy lifecycle formatting

- [x] Rework `beginToolTrace(...)` / `endToolTrace(...)` formatting
- [x] Apply the same formatting cleanup to snapshot tool traces
- [x] Replace heavy `[tool #N start/end]` formatting with a cleaner verbose style
- [x] Reevaluate whether numbering is actually helping readability
- [x] Remove or reduce visual noise from separator lines if they feel non-native

### 3. Improve visual style without hiding tools

- [x] Add or refine `formatToolTraceLine(...)` helper
- [x] Use the target one-line format:
  - [x] `↳ read — file=src/index.ts`
  - [x] `↳ edit — file=src/index.ts old=158c new=163c`
- [x] Prefer lighter prefixes like `↳ tool — summary`
- [x] Keep all tool types visible, including low-value tools
- [x] Avoid raw JSON dumps in assistant text when a compact preview is possible
- [x] Remove numbering from tool traces
- [x] Remove separator lines from tool traces

### 4. Defer spacing changes until after formatting cleanup

- [x] Do not add new artificial newline hacks first
- [x] Validate whether cleaner verbose formatting already fixes most UX issues
- [x] Only if still needed, keep trace + nearby prose in the same rendered text block when possible
- [x] Continue avoiding block-boundary `\n\n` tricks and invisible spacer hacks

### 5. Validate UX with real streams

- [ ] Test long interactive streams
- [ ] Check prose ↔ trace transitions
- [ ] Verify no ordering regressions
- [x] Verify output feels closer to native Pi
- [ ] Verify verbose traces remain readable during long tool-heavy runs

### 6. Update docs

- [x] Document the cleaned-up verbose trace behavior
- [x] Document that all tool types remain visible by default
- [x] Move durable provider design/goal notes into `README.md`
- [x] Retire `CLAUDE_CODE_TRACKING.md`

### 7. Next priorities — preserve more authoritative Claude headless metadata

- [ ] Preserve and/or explicitly log Claude cache tier split from headless mode:
  - [ ] `cache_creation.ephemeral_5m_input_tokens`
  - [ ] `cache_creation.ephemeral_1h_input_tokens`
- [ ] Preserve and/or explicitly log final `modelUsage` from Claude result events
- [ ] Preserve and/or explicitly log final `permission_denials` from Claude result events
- [ ] Review whether any other result-level headless metadata should be normalized instead of left only inside raw `stdout_line` debug entries

### 8. Usage/cost fidelity policy

- [ ] Keep token accounting faithful to Claude headless mode output
- [ ] Keep trusting Claude-reported `total_cost_usd` when available
- [ ] Do not infer input/output/cache USD breakdown from external pricing tables
- [ ] Document clearly which usage/cost fields are authoritative vs collapsed vs not propagated
- [ ] Call out that Pi currently collapses Claude cache creation into one `cacheWrite` bucket even though Claude exposes tier split

### 9. Docs simplification

- [x] Reevaluate whether `CLAUDE_CODE_TRACKING.md` is still needed
- [x] Prefer `TODO.md` + inline documentation in `agent/extensions/claude-code-provider/index.ts` for implementation details
- [x] Prefer `README.md` for durable design goals and extension behavior notes
- [x] Retire `CLAUDE_CODE_TRACKING.md` to avoid drift

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
