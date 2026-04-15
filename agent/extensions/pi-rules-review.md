# pi-rules.ts — Consolidated Code Review

**Reviewers:** opus@pi-rules, gpt@pi-rules
**Style criteria:** Simple code where every line justifies its existence. No abstractions until truly essential. Performant, readable, idiomatically organized.

**Summary:** Small and readable. Had two session-state bugs (fixed: #1, #2). Remaining: UX indicator for active rules (#8), style cleanup (#3–#5).

---

## Bugs (must fix)

### 1. Branch-unsafe restore

`session_start` uses `getEntries()` which returns **all** entries across all branches. It should use `getBranch()` to only restore rules from the current branch path.

```ts
// Current — scans every entry in the session, including other branches
ctx.sessionManager.getEntries().filter(...)
```

This means rules set on a sibling branch can leak into the active branch after reload.

**Fix:** Use `ctx.sessionManager.getBranch()` instead.

### 2. Stale rules after tree navigation

There is no `session_tree` event handler. After `/tree` navigation moves the leaf to a different branch, the in-memory `rulesText` still reflects the old branch. `before_agent_start` then injects wrong rules until the session is reloaded.

**Fix:** Add a `session_tree` handler that re-scans the new branch and updates `rulesText`.

---

## UX (should fix)

### 8. Silent state transitions

Rules can silently change, disappear, or restore during tree navigation and branching. The user has no way to know rules are active without running `/rules`.

**Design decision:** Branch-local rules is the correct behavior — the active branch determines active state. The problem is visibility, not logic.

**Fix:** Add a persistent footer indicator via `ctx.ui.setStatus("rules", "rules")` when active, `ctx.ui.setStatus("rules", undefined)` when inactive.

- Plain text `"rules"` — compact, no icons. Presence alone means active.
- Keep existing `notify()` calls for user-triggered actions (set, load, clear). Those are explicit and worth acknowledging.
- Do **not** add notifications for branch/tree-driven changes — too noisy.

**Implementation:**
- Small `updateStatus(ctx)` helper that reflects current `rulesText` to the footer
- `restoreRules` stays focused on session reconstruction only
- Call `updateStatus` after:
  - `restoreRules()` in `session_start`
  - `restoreRules()` in `session_tree`
  - `/rules <text>` (set)
  - `/rules @<file>` (load)
  - `/rules clear`

---

## Style issues (should fix)

### 3. Over-ceremonial restore block

```ts
const saved = ctx.sessionManager
  .getEntries()
  .filter(
    (e: { type: string; customType?: string }) =>
      e.type === "custom" && e.customType === "rules",
  )
  .pop() as { data?: { text?: string | null } } | undefined;
rulesText = saved?.data?.text ?? null;
```

Problems:

- `filter().pop()` allocates an intermediate array just to grab the last match
- Inline type annotation `(e: { type: string; customType?: string })` is a workaround for missing API types — a cast is more honest and shorter
- The trailing `as` cast adds a second layer of type theater
- All this ceremony makes the real bug (#1) harder to spot

**Fix:** Replace with a simple reverse loop or `findLast` (if runtime supports it). Drop the inline type annotations in favor of a straightforward cast.

### 4. Unnecessary `async`

All three handlers (`session_start`, `before_agent_start`, command `handler`) are marked `async` but none use `await`. The API type signature accepts sync returns: `(event, ctx) => Promise<R | void> | R | void`.

**Fix:** Drop `async` from handlers that don't await.

### 5. Mixed sync/async IO

`fs.readFileSync` is used inside an `async`-marked handler. This is a consistency/readability issue — mixing idioms signals confusion about intent, not a correctness problem.

**Fix:** Either commit to sync style (drop `async`, keep `readFileSync`) or go fully async (`fs.promises.readFile` with `await`). For this use case, sync is simpler and defensible.

---

## Style observations (minor — keep as-is)

### 6. Empty-file guard

```ts
if (!text) {
  ctx.ui.notify(`Rules file is empty: ${resolved}`, "warning");
  return;
}
```

Earns its place: gives a better user-facing message than silently setting empty rules, and avoids persisting a meaningless entry.

### 7. `(args ?? "").trim()`

Normal defensive code. Command args can be undefined, so the nullish coalesce is justified.
