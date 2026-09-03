# Review: `pi-rules.ts`

Extension purpose: branch-local "session rules" — free text appended to the system prompt on every turn, changeable at runtime via `/rules`.

**Overall verdict:** Solid and idiomatic. The core API usage (persistence, prompt injection, branch handling) matches the documented PI patterns exactly. What follows are the findings, ordered by priority.

---

## What is already correct (don't touch)

- **Prompt injection:** `before_agent_start` returns `event.systemPrompt + rules` — the documented chained pattern. Per-turn, composes with other extensions, no context pollution. Right choice over injecting a persistent `message`.
- **Persistence:** `pi.appendEntry("rules", {text})` + backward scan of `ctx.sessionManager.getBranch()` for the latest entry. `clear` writes `{text: null}`, so last-entry-wins works. This is the State Management pattern from the docs, verbatim.
- **Branch navigation:** Restoring on both `session_start` *and* `session_tree` is correct and often forgotten — `/tree` does not reload extensions. Rules correctly follow branches.
- **Widget lifecycle:** `setWidget(key, string[])` / clear with `undefined` — correct signature.
- **Mode safety:** No `ctx.hasUI` guard needed; UI methods are documented no-ops in print/json modes.

---

## Tasks (in recommended order)

### 1. Fix theme-stale widget — the only real defect

The widget pre-bakes theme colors into a string:

```typescript
ctx.ui.setWidget("pi-rules", [ctx.ui.theme.fg("dim", `⚙ ${text}`)]);
```

`docs/tui.md` ("Invalidation and Theme Changes") warns exactly against this: after a `/theme` switch, the widget keeps old ANSI colors until the next `setWidget` call.

**Fix:** use the factory form, which re-resolves the theme on every render:

```typescript
ctx.ui.setWidget("pi-rules", (_tui, theme) => ({
  render: () => [theme.fg("dim", `⚙ ${preview}`)],
  invalidate: () => {},
}));
```

### 2. Use SDK types instead of hand-rolled structural types

The local `RulesEntry` type and inline ctx shapes (`{ sessionManager: {...} }`, `{ ui: {...} }`) duplicate types exported by `@earendil-works/pi-coding-agent` (`ExtensionContext`, session entry types). Structural typing silently tolerates API drift; SDK types catch it at compile time. Every shipped example types handlers against the SDK.

### 3. Add file-path completion for `@`

`getArgumentCompletions` currently only suggests `clear`. Offering path completions after `@` would make `/rules @<file>` discoverable. Note: the callback receives only `prefix` (no ctx), so capture cwd from `session_start` or use `process.cwd()`.

### 4. Render rule changes in the transcript (optional)

Rules are stored via `appendEntry` but have no `pi.registerEntryRenderer("rules", ...)`. Adding one would show `/rules` set/clear events inline in chat history instead of only in the widget. Docs pair these two APIs explicitly for durable TUI-only content.

### 5. Warn on oversized rules (optional)

A large `@file` gets injected into **every** turn's system prompt with no size check. Add a soft warning (e.g. above ~10–20 KB) to prevent accidental context bloat.

### 6. Minor cleanups (optional, cosmetic)

- `session_start` and `session_tree` handlers are identical — share one function reference.
- The widget-preview ellipsis condition checks total length but slices the first line; correct in all cases, just indirect. Could be simplified for readability.
- `/rules clear` reserves the literal word `clear` — rules whose whole text is "clear" can't be set. Worth a one-line doc note, nothing more.
- `@file` paths are taken verbatim after trim — no quote handling. Paths with leading/trailing spaces would be altered. Edge case; document or ignore.

---

## Suggested scope

Minimum worthwhile refactor: **Task 1** (defect) + **Task 2** (type safety).
Nice-to-have UX pass: **Tasks 3–5**.
Task 6 only if touching the file anyway.
