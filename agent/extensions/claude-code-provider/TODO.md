# TODO — Claude Code provider

## Goal

Keep the Claude Code provider feeling native in Pi while staying faithful to what Claude headless mode actually reports.

## Done

- [x] Switched tool traces to compact one-line summaries
- [x] Removed visible numbering and separator lines from tool traces
- [x] Kept all Claude internal tools visible by default
- [x] Improved prose ↔ trace spacing without newline/invisible-spacer hacks
- [x] Moved durable provider design notes into `README.md`
- [x] Retired `CLAUDE_CODE_TRACKING.md`
- [x] Documented the non-inferential usage/cost policy inline in `agent/extensions/claude-code-provider/index.ts`

## Next priorities

### 1. Preserve more authoritative Claude headless metadata

- [ ] Preserve and/or explicitly log Claude cache tier split from headless mode:
  - [ ] `cache_creation.ephemeral_5m_input_tokens`
  - [ ] `cache_creation.ephemeral_1h_input_tokens`
- [ ] Preserve and/or explicitly log final `modelUsage` from Claude result events
- [ ] Preserve and/or explicitly log final `permission_denials` from Claude result events
- [ ] Review whether any other result-level headless metadata should be normalized instead of left only inside raw `stdout_line` debug entries

### 2. Usage/cost fidelity

- [ ] Keep token accounting faithful to Claude headless mode output
- [ ] Keep trusting Claude-reported `total_cost_usd` when available
- [ ] Do not infer input/output/cache USD breakdown from external pricing tables
- [ ] Document clearly which usage/cost fields are authoritative vs collapsed vs not propagated
- [ ] Call out that Pi currently collapses Claude cache creation into one `cacheWrite` bucket even though Claude exposes tier split

### 3. Remaining validation

- [ ] Test long interactive streams
- [ ] Check prose ↔ trace transitions in longer runs
- [ ] Verify no ordering regressions in long sessions
- [ ] Verify verbose traces remain readable during long tool-heavy runs

## Notes

- Do not use Pi native `toolCall` for Claude internal tools
- Do not add more artificial newline hacks
- Prefer smaller provider-only diffs in `agent/extensions/claude-code-provider/index.ts`
