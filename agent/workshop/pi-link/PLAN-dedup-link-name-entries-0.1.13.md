# PLAN: Dedup `link-name` session entries (0.1.13)

Ship dedup alongside `--link-name` in 0.1.13. One rule, applied uniformly to both the env path (`pi-link <name>` via `PI_LINK_NAME`) and the CLI path (`--link-name`): skip the append when the saved name already matches.

## Goal

Stop accumulating redundant `link-name` custom entries on no-op restarts. Both `pi-link <name>` and `pi --link-name <name>` currently append a fresh entry every startup, even when the saved value is identical. After this change, the append happens only on first-time set or actual change.

## Why

The append exists for three real reasons:
1. **Persistence** — restoring link identity on the next no-flag start (else-branch reads the latest saved entry)
2. **`pi-link list` discovery** — the wrapper scans session JSONLs for the latest `link-name` to label each session
3. **`pi-link <name>` resolution** — the wrapper scans for sessions whose latest `link-name` matches the query

All three consumers `.pop()` the latest matching entry, so a single accurate record does the job. Repeated identical appends are pure noise.

For automation (the actual motivating use case for `--link-name`, and a real pattern for `pi-link <name>` too), repeated startups can produce hundreds or thousands of duplicate entries in a single session file. This bloats the file, slows `pi-link list` scans, and adds log noise without benefit.

## Approach: dedup everywhere (one rule)

Apply the same dedup logic to both flag paths. No asymmetry. The `if (flagName)` branch handles both `cliFlagName` (`--link-name`) and `envFlagName` (`PI_LINK_NAME` from the wrapper) identically.

### Recency trade-off (accepted)

`pi-link list` sorts sessions by file mtime. Today, every flagged startup writes (the duplicate append), so opening a session via `pi-link <name>` always bumps mtime — even if you immediately exit without doing anything else. After dedup, no-op restarts don't bump mtime.

**What we lose**: the ability to "promote" a session to the top of `pi-link list` just by opening it briefly with no persisted activity.

**Why that's fine**:
- `pi-link list` recency now reflects persisted session activity (messages, tool calls, edits, real link-name changes), not no-op opens
- The "open-and-immediately-quit-without-touching-anything" case is narrow and uncommon
- Persisted-activity recency is the more idiomatic mental model (matches `git log`, `ls -t`, etc.)
- For automation use cases (the real volume), every run does actual work, so recency tracks correctly

The duplicate append was acting as an implicit mtime bumper, but this was a side-effect, not the primary purpose of the entry. Note: not all activity persists — e.g., `/link` (overview command) does not write — so "persisted activity" is the precise framing.

## Implementation

Inline reverse-scan in the `if (flagName)` branch of `session_start`. No helper extraction (single callsite).

### Diff scope

`index.ts` only. ~8 added lines in the `if (flagName)` branch.

**Before** (current 0.1.13 with `--link-name` shipped):
```ts
if (flagName) {
  preferredName = flagName;
  terminalName = flagName;
  pi.appendEntry("link-name", { name: flagName });
  // Critical: only the env path (wrapper combined mode) seeds session name.
  // Public --link-name is link-only.
  if (fromEnv && !pi.getSessionName()) pi.setSessionName(flagName);
}
```

**After**:
```ts
if (flagName) {
  preferredName = flagName;
  terminalName = flagName;

  // Skip append if the saved name already matches; persistence is needed only
  // for first-time set or actual change. Reduces session-file growth on
  // repeated startups (common in automation).
  let latestSaved: string | undefined;
  const entries = _ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as {
      type: string;
      customType?: string;
      data?: { name?: unknown };
    };
    if (e.type !== "custom" || e.customType !== "link-name") continue;
    if (typeof e.data?.name === "string") latestSaved = e.data.name;
    break;
  }
  if (latestSaved?.trim().replace(/\s+/g, " ") !== flagName) {
    pi.appendEntry("link-name", { name: flagName });
  }

  // Critical: only the env path (wrapper combined mode) seeds session name.
  // Public --link-name is link-only.
  if (fromEnv && !pi.getSessionName()) pi.setSessionName(flagName);
}
```

### Why inline (not extracted helper)

Single callsite. Inline scan is ~8 lines. The else branch already has its own inline scan with slightly different shape (uses `filter().pop()`); leaving that alone preserves its current behavior and avoids touching unrelated code. Extraction would require a helper, an import, and changing two unrelated branches — more risk for no readability gain.

Style criterion: abstractions only when essential. One callsite, no abstraction needed.

### Comparison normalization

`flagName` is already normalized at the top of `session_start` (trim + collapse whitespace). The reverse-scan reads `e.data.name` raw and normalizes only at the comparison site. This handles legacy entries with stray whitespace correctly without changing the else-branch fallback semantics (which restores raw saved names).

## Edge cases

| Case | Latest saved | flagName | Action | Correct? |
|---|---|---|---|---|
| First startup, no entries | undefined | "foo" | append | ✓ |
| Restart same name | "foo" | "foo" | skip | ✓ |
| Change name | "foo" | "bar" | append | ✓ |
| 50 historical duplicates from 0.1.12 era | "foo" (latest) | "foo" | skip | ✓ |
| Case sensitivity ("foo" vs "FOO") | "foo" | "FOO" | append | ✓ (link names are case-sensitive) |
| Malformed `data` field | undefined | "foo" | append (heals) | ✓ |
| Legacy `"foo "` saved + flag `"foo"` | normalize both → match | "foo" | skip | ✓ |
| `pi-link <name>` env path with matching saved | "foo" | "foo" (env) | skip | ✓ |
| `pi --link-name` CLI path with matching saved | "foo" | "foo" (cli) | skip | ✓ |
| Mixed: `/link-name bar` mid-session, then restart with `--link-name foo` | latest = "bar" | "foo" | append | ✓ (bar → foo is a real change) |
| Hub collision rename to `foo-2`: saved entry stays "foo" | "foo" | "foo" (next start) | skip | ✓ (intent preserved) |

## Interaction with `/link-name` slash command

`/link-name` already has its own dedup logic for the truly-redundant case (`newName === terminalName && newName === preferredName` → skip notify). It DOES append when `newName === terminalName` but preferredName differs (the "claim hub-assigned name as my new preferred" case). That's a meaningful state change, not a no-op.

Our flag dedup compares the new value to the latest **saved** entry; `/link-name` compares to live in-memory state. Different mechanisms because the contexts differ (startup vs mid-session), but the philosophy is consistent: skip records that are already accurate, append on actual change.

## CHANGELOG

Add a bullet under 0.1.13 `### Changed`:

> `link-name` session entries no longer accumulate on no-op restarts. Both `pi-link <name>` and `pi --link-name <name>` skip the append when the saved name already matches. Sessions opened and exited without any persisted activity will no longer bump `pi-link list` recency from the same-name startup alone; recency still updates on messages, tool calls, edits, and real link-name changes.

The recency note is explicit because it's the only user-visible behavior change.

## Test strategy

Manual.

**IMPORTANT — flush gotcha**: Pi's `SessionManager._persist()` does not necessarily flush custom entries to JSONL until the first assistant message of a session. A brand-new session that exits immediately may leave the `appendEntry("link-name")` in memory only. For JSONL-count tests, send at least one short prompt and let the assistant respond before exiting, so persisted state is on disk.

Test cases:

1. **First-time set**: create a fresh session, run `pi --link-name foo`, send any short prompt and let it complete, exit. Verify session JSONL contains exactly ONE `link-name=foo` entry.
2. **No-op repeat**: from same session, run `pi --link-name foo` again, send a short prompt, exit. Verify session JSONL still contains ONE `link-name` entry (no new append).
3. **Real change**: from same session, run `pi --link-name bar`, send a short prompt, exit. Verify session JSONL now contains TWO `link-name` entries (foo, bar).
4. **Env path symmetry**: create another fresh session via `pi-link baz`, send a short prompt. Re-run `pi-link baz` on it, send a short prompt, exit. Verify only ONE `link-name=baz` entry exists.
5. **Mixed paths CLI → env**: create session via `pi --link-name qux` (with prompt), then run `pi-link qux` on it (with prompt), exit. Verify only ONE `link-name=qux` entry (env path dedups against CLI-path-set saved value).
6. **Mixed paths env → CLI**: create another fresh session via `pi-link quux` (with prompt), then run `pi --link-name quux` on it (with prompt), exit. Verify only ONE `link-name=quux` entry (CLI path dedups against env-path-set saved value).
7. **`pi-link list` resolution**: after the above, verify `pi-link list` correctly shows all five sessions with their respective names.
8. **`pi-link <name>` resolution**: verify `pi-link foo`, `pi-link bar`, `pi-link baz`, `pi-link qux`, `pi-link quux` each resolve to the correct session.

## Risk

Low. The append's three downstream consumers (else-branch fallback, list scanner, name resolver) all use `.pop()` on the latest matching entry — a single accurate record satisfies them just as well as a hundred duplicates. No correctness regression possible from the reduction.

The only user-visible behavior change is the narrow recency case documented above, accepted as a fair trade.

## Rollout

1. Apply the inline dedup logic to `index.ts`
2. Add the `### Changed` CHANGELOG bullet under 0.1.13
3. Doc consistency sweep (release-prep, not strictly dedup):
   - `index.ts` header comment currently lists opt-in via `--link`, `pi-link <name>`, `/link-connect` — add `--link-name`
   - README "Without `--link` or `pi-link`…" sentence — add `--link-name` to the list
4. Final GPT diff review
5. Manual test pass (7 cases above, with prompt-and-exit pattern to avoid flush gotcha)
6. Ship 0.1.13

## Review history

- Round 1 (gpt): identified else-branch normalization regression in earlier draft → resolved (raw read, normalize at comparison site)
- Round 2 (gpt): identified recency / mtime side-effect → initially deferred; later revisited
- Round 3 (style): noted helper extraction is borderline → adopted inline scan
- Round 4 (asymmetric proposal): briefly considered Option 6 (CLI-only dedup) → rejected after recognizing both paths see automation use, semantic distinction insufficient justification for asymmetry
- Round 5 (this plan): one rule everywhere; recency trade-off accepted as fair given real activity bumps mtime naturally
- Round 6 (gpt final review): tightened recency framing ("persisted session activity, not no-op opens"); flagged Pi flush gotcha for tests (brand-new sessions don't flush custom entries until first assistant message); added doc consistency sweep for `--link-name` references in `index.ts` header and README intro; multi-line cast formatting
