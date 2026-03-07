# TODO — Improve Claude Code provider without Pi core changes

## Goal
Make Claude internal tool activity feel more native in Pi without modifying Pi core.

## Plan

### 1. Replace trace lifecycle with one-line summaries
- [ ] Make `beginToolTrace(...)` collect metadata only
- [ ] Make `endToolTrace(...)` emit at most one concise line
- [ ] Apply the same summary-only behavior to snapshot tool traces
- [ ] Stop showing tool `start` lines by default
- [ ] Remove unnecessary separators and numbering by default
- [ ] Keep raw details in `debug.log`, not assistant prose

### 2. Add trace verbosity control
- [ ] Add a simple provider env toggle for trace verbosity
- [ ] Suggested env var: `CLAUDE_CODE_TRACE_MODE`
- [ ] Modes:
  - [ ] `minimal`: show only `edit`, `write`, `bash`
  - [ ] `normal`: concise summaries with selective read/search visibility
  - [ ] `verbose`: full debug-style trace behavior

### 3. Add filtering for low-value tools
- [ ] Add `shouldShowToolTrace(toolName, preview, mode)` helper
- [ ] Suppress or collapse `TodoWrite` by default
- [ ] Suppress repetitive `read` / `grep` / `find` / `ls` when low-value
- [ ] Always show meaningful state-changing tools like `edit`, `write`, `bash`

### 4. Improve visual style
- [ ] Add `formatToolTraceLine(toolName, preview)` helper
- [ ] Replace heavy `[tool #N start/end]` style with lighter inline summaries
- [ ] Prefer prefixes like `↳ tool — summary` or `• tool — summary`
- [ ] Avoid raw JSON and overly verbose previews in assistant text

### 5. Defer spacing changes until after trace simplification
- [ ] Do not add new artificial newline hacks first
- [ ] Validate whether quieter trace output already fixes most UX issues
- [ ] Only if still needed, keep trace + nearby prose in the same rendered text block when possible
- [ ] Continue avoiding block-boundary `\n\n` tricks and invisible spacer hacks

### 6. Validate UX with real streams
- [ ] Test long interactive streams
- [ ] Check prose ↔ trace transitions
- [ ] Verify no ordering regressions
- [ ] Verify output feels closer to native Pi

### 7. Update docs
- [ ] Sync `agent/extensions/claude-code-provider/CLAUDE_CODE_TRACKING.md`
- [ ] Document summary-only trace behavior
- [ ] Document trace mode behavior and hidden/collapsed noisy tools

## Preferred target UX
Example:

```text
I found the particle size constants.

↳ edit — SdlGame/Constants.cs (158c → 163c)

I’ve halved both values.
```

## Notes
- Do not use Pi native `toolCall` for Claude internal tools
- Do not add more artificial newline hacks
- Prefer smaller provider-only diffs in `agent/extensions/claude-code-provider/index.ts`
