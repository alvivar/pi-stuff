# Pi 0.72 Alignment

## Goal

Bring pi-link in line with Pi changes between 0.65.0 (last documented migration) and 0.72.0 (current installed). Two independent fixes, worked sequentially.

## Phase 1 — Session-dir resolution in CLI

### Why

`bin/pi-link.mjs` line 17 hardcodes `SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions")`. Pi reads its session location from env vars, project settings, and global settings — none of which pi-link respects. For users with any custom config:

- `pi-link list` silently lies ("no sessions found")
- `pi-link resolve <name>` returns no match
- `pi-link <name>` silently starts a new session instead of resuming, fragmenting session history into orphans across the real sessionDir

### Pi's resolution (verified from `dist/main.js:384` and `dist/core/session-manager.js:970`)

```
sessionDir =
    --session-dir
    ?? expandTilde(env.PI_CODING_AGENT_SESSION_DIR)
    ?? settingsManager.getSessionDir()    // deepMerge(global, project), project wins
    ?? undefined

// Then in SessionManager.create:
dir = sessionDir ?? <agentDir>/sessions/<encoded-cwd>
```

Where `<agentDir> = process.env.PI_CODING_AGENT_DIR ?? <home>/.pi/agent`.

`PI_CODING_AGENT_DIR` also relocates global settings to `<agentDir>/settings.json`.

Tilde expansion handles only `~` and `~/...` (not `~user/...`).

### Resolution order for pi-link (we reject `--session-dir`)

1. `expandTilde(env.PI_CODING_AGENT_SESSION_DIR)`
2. `expandTilde(readJSON(<cwd>/.pi/settings.json)?.sessionDir)` — project, if string
3. `expandTilde(readJSON(<agentDir>/settings.json)?.sessionDir)` — global, if string
4. else `undefined` → fall back to default scan path

### Layout handling

Match Pi exactly — resolve once, scan only the active layout (no double-scan):

- **`sessionDir` resolved** (steps 1–3): scan `<sessionDir>/*.jsonl` flat, no encoded-cwd subdir. All cwds share this dir; cwd filtering uses session metadata as today.
- **`sessionDir` undefined** (step 4): scan `<agentDir>/sessions/<dir>/*.jsonl` — current walker behavior.

### Decisions (settled)

- **Malformed `settings.json`**: warn to stderr (`pi-link: ignored malformed <path>: <error>`), fall through to next source.
- **Non-string `sessionDir`** in settings: treat as absent, fall through silently. Different from JSON parse errors.
- **Single-resolve**: resolve `agentDir` and `sessionDir` once at CLI entry, pass into `scanSessions(dir, isCustom)`.
- **Don't import Pi's `SettingsManager`**: keep launcher lightweight, parse JSON ourselves.

### Implementation

1. Helpers in `bin/pi-link.mjs`:
   - `expandTilde(p)` — handles `~` and `~/...` only
   - `readSessionDirFromSettings(path)` — read+parse JSON, return string `sessionDir` or `undefined`. Warn to stderr on JSON parse error. Return `undefined` for missing file or non-string field.
   - `resolveAgentDir()` — `expandTilde(env.PI_CODING_AGENT_DIR) ?? join(home, ".pi", "agent")`
   - `resolveSessionDir(cwd, agentDir)` — implements the 4-step chain, returns `{ dir, isCustom }`. `isCustom=true` when steps 1–3 hit; `false` for step 4.
2. Replace the `SESSIONS_DIR` constant with one call at CLI entry; pass `(dir, isCustom)` into `scanSessions`.
3. Modify `scanSessions(dir, isCustom)`:
   - `isCustom=true`: read `dir`, take only `*.jsonl` entries, parse each
   - `isCustom=false`: current walker — read `dir`, recurse one level into subdirs, parse `*.jsonl` files
4. Existing cwd filtering in `listSessions` (via `getSessionMeta().cwd`) keeps working unchanged in both layouts.

### Test

- Default config: `pi-link list`, `resolve`, `<name>` work as before
- `PI_CODING_AGENT_SESSION_DIR=/tmp/test pi-link list` lists sessions in flat layout
- `~/.pi/agent/settings.json` with `"sessionDir": "~/custom"` → respected, `~` expanded
- `<cwd>/.pi/settings.json` `sessionDir` → overrides global
- `PI_CODING_AGENT_DIR=/opt/pi` with no other config → reads global settings from `/opt/pi/settings.json`, default scan at `/opt/pi/sessions/`
- Malformed `settings.json` → stderr warning, falls through, no crash
- `"sessionDir": 42` → silently treated as absent
- `pi-link <name>` with matching session in custom dir → resumes correctly (no orphan)

### Done

- All four resolution paths work, with correct layout per path
- `list`, `resolve`, `<name>` all use the resolved dir
- Stderr warning on malformed settings JSON
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
