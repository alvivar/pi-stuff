# Pi 0.72 Alignment

## Goal

Bring pi-link in line with Pi changes between 0.65.0 (last documented migration) and 0.72.0 (current installed). Two independent fixes, worked sequentially.

## Phase 1 — Session-dir resolution in CLI

### Why

`bin/pi-link.mjs` hardcodes `SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions")`. Pi 0.71.0 added `PI_CODING_AGENT_SESSION_DIR` env, complementing `sessionDir` in `settings.json` (0.68.1 fix expanded `~`) and `PI_CODING_AGENT_DIR` for the agent dir. Users with any custom config → `pi-link list`, `pi-link resolve`, `pi-link <name>` all fail to find sessions.

### Resolution order

Match Pi's effective lookup, minus `--session-dir` (we reject it):

1. `PI_CODING_AGENT_SESSION_DIR` (direct session dir override)
2. project-local `<cwd>/.pi/settings.json` `sessionDir`
3. global `<agentDir>/settings.json` `sessionDir`
4. default: `<agentDir>/sessions`

Where `<agentDir>` is `process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")`.

Expand `~` in any path read from settings.

### Layout handling

- **Default layout**: `<sessionDir>/<encoded-cwd>/<file>.jsonl` (current `scanSessions` walker)
- **Custom layout**: `<sessionDir>/<file>.jsonl` (flat, when user sets explicit `sessionDir`)

`scanSessions` should walk both: top-level `*.jsonl` + one-level `<dir>/*.jsonl`. Single pass, no branching by config.

### Implementation

In `bin/pi-link.mjs`:

1. Add `resolveSessionDir()` helper — returns final dir as string, applies precedence + `~` expansion, defensive JSON parse (ignore malformed settings).
2. Replace `SESSIONS_DIR` constant with the resolved value (called once at CLI entry).
3. Modify `scanSessions` to accept session-dir + walk both layouts. Skip non-`.jsonl` entries.
4. Do **not** import Pi's `SettingsManager` — keep launcher lightweight, parse JSON ourselves.

### Test

- Default config: `pi-link list` works as before
- `PI_CODING_AGENT_SESSION_DIR=/tmp/test pi-link list` finds sessions in flat layout
- `~/.pi/agent/settings.json` with `"sessionDir": "~/custom"` → respected
- `<cwd>/.pi/settings.json` with `sessionDir` → overrides global
- Malformed settings.json → falls back to default, no crash

### Done

- All four resolution paths work
- Both layouts scan correctly
- `pi-link <name>`, `list`, `resolve` all use the resolved dir
- CHANGELOG Unreleased entry added

---

## Phase 2 — TypeBox 1.x migration

### Why

Pi 0.69.0 migrated from `@sinclair/typebox` 0.34.x to `typebox` 1.x. Legacy alias keeps current code working but Pi's docs now direct new extensions to import from `typebox`. README still says "`@sinclair/typebox` provided by Pi" — becoming misleading.

### Scope

pi-link uses only: `Type.Object`, `Type.String`, `Type.Boolean`, `Type.Optional`. No compiler subpath. Surface should be identical in `typebox` 1.x.

### Changes

1. `index.ts` line 18: `import { Type } from "@sinclair/typebox"` → `import { Type } from "typebox"`
2. `README.md` Dependencies → "Provided by Pi" table: replace `@sinclair/typebox` row with `typebox`
3. CHANGELOG Unreleased entry

### Test

- Extension loads without errors in current Pi (0.72.0)
- All three registered tools still validate args correctly: `link_send`, `link_prompt`, `link_list`
- No runtime errors on tool invocation

### Done

- Import migrated
- README accurate
- All tools work
- CHANGELOG entry added

### Rollback

If `typebox` 1.x has incompatible `Type.*` shape (unlikely given pi-link's narrow usage), revert the import. Pi's legacy alias keeps `@sinclair/typebox` working.

---

## Sequencing

1. Phase 1 first — higher-impact bug fix, isolated to `bin/pi-link.mjs`
2. Phase 2 after — touches `index.ts` and README; do once Phase 1 is verified shipping/working
3. Each phase gets its own CHANGELOG entry under Unreleased
4. Each phase reviewed with `gpt@pi-link` before applying

## Out of scope

- Lifecycle hardening (REVIEW.md #6 — unregistered sockets / unguarded callbacks). Tracked separately.
- New extension hook adoption (`setWorkingIndicator`, etc.) — future enhancement, not alignment.
- Monitor mode (PLAN-monitor.md). Independent feature.
