# TODO — Improve Claude Code provider without Pi core changes

## Goal
Make Claude internal tool activity feel more native in Pi without modifying Pi core.

## Plan

### 1. Reduce trace noise
- [ ] Stop showing tool `start` lines by default
- [ ] Show only concise final summaries for most tools
- [ ] Keep raw details in `debug.log`, not assistant prose

### 2. Hide or collapse noisy tools
- [ ] Suppress or collapse `TodoWrite`
- [ ] Suppress repetitive `read` / `grep` when low-value
- [ ] Always show meaningful state-changing tools like `edit`, `write`, `bash`

### 3. Improve visual style
- [ ] Replace heavy `[tool #N start/end]` style with lighter inline summaries
- [ ] Prefer prefixes like `↳ tool — summary` or `• tool — summary`
- [ ] Remove unnecessary separators if they make output feel less native

### 4. Make spacing reliable
- [ ] Keep trace + nearby prose in the same rendered text block when possible
- [ ] Avoid relying on block-boundary `\n\n`
- [ ] Avoid invisible spacer hacks

### 5. Add trace verbosity control
- [ ] Add a simple provider setting/env toggle for trace verbosity
- [ ] Modes:
  - [ ] `minimal`: show only high-value tools
  - [ ] `normal`: concise summaries
  - [ ] `verbose`: full trace/debug-style output

### 6. Validate UX with real streams
- [ ] Test long interactive streams
- [ ] Check prose ↔ trace transitions
- [ ] Verify no ordering regressions
- [ ] Verify output feels closer to native Pi

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
