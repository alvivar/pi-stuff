# FUTURE: Dedup `link-name` session entries

**Status: deferred indefinitely.** Needs a clean recency-semantics story before revival.

## What it would do

Skip the `appendEntry("link-name", { name: flagName })` call when the latest saved `link-name` entry already matches `flagName`. Reduces session-file growth for heavy `pi-link <name>` users; existing duplicates are unaffected (only future appends are gated).

## Why deferred

The duplicate append is **load-bearing for `pi-link list` recency ordering**.

Pi does NOT bump session-file mtime on resume (confirmed via `SessionManager.open()` reading entries without writing back, per gpt review). The duplicate `link-name` append was therefore acting as the implicit mtime bumper for `pi-link <name>` opens.

Dedup would silently remove that bump. `pi-link foo` opens would no longer rise in the recency list. That's a user-visible semantic shift, not polish.

## Options if revisited

1. **Accept the recency change.** Document loudly: "`pi-link list` recency now reflects activity (messages, edits) not opens." Defensible but a behavior shift.
2. **Replace implicit mtime bumper with explicit `utimes` call.** Adds a hidden filesystem side-effect just to preserve behavior after removing another side-effect. Gpt advised against — adds operational opacity without net benefit.
3. **Keep duplicate appends.** Accept that "dedup" isn't pure polish here — the duplicate appends serve a real purpose (recency bump). Don't dedup at all.
4. **Track recency separately.** A small JSON file at known location (e.g., `~/.pi/agent/extensions/pi-link/recency.json`) maps session-id → last-open-time. `pi-link list` consults it and falls back to mtime. Decouples open-recency from file-mtime. Bigger architectural change but cleanest semantically. Worth considering only if the file growth becomes a real complaint.

## What the implementation would look like

(For future reference only — do not apply without resolving recency story first.)

### Helper (inline first, extract only if duplication makes the code worse)

Under the project's style (abstractions only when essential), inline both callsites first and judge whether the duplicated scan actually hurts readability. The helper is borderline-justified — 2 callsites in the same function, naming a real domain operation — but inline may still read better.

If extracted:

```ts
function readLatestSavedLinkName(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as {
      type: string;
      customType?: string;
      data?: { name?: unknown };
    };
    if (entry.type !== "custom" || entry.customType !== "link-name") continue;
    return typeof entry.data?.name === "string" ? entry.data.name : undefined;
  }
  return undefined;
}
```

Returns raw saved name. Reverse-iteration short-circuits at first match.

### Comparison-site (in `if (flagName)` branch)

```ts
if (flagName) {
  preferredName = flagName;
  terminalName = flagName;

  const latestRaw = readLatestSavedLinkName(_ctx);
  const latestNormalized = latestRaw?.trim().replace(/\s+/g, " ") || undefined;
  if (latestNormalized !== flagName) {
    pi.appendEntry("link-name", { name: flagName });
  }

  if (fromEnv && !pi.getSessionName()) pi.setSessionName(flagName);
}
```

Normalization is comparison-only. Else branch (saved-fallback) restores raw, preserving today's behavior.

### Else branch refactor

```ts
} else {
  const savedRaw = readLatestSavedLinkName(_ctx);
  if (savedRaw) {
    preferredName = savedRaw;
    terminalName = preferredName;
  } else {
    const sessionName = pi.getSessionName()?.trim().replace(/\s+/g, " ");
    if (sessionName) terminalName = sessionName;
  }
}
```

## Edge cases (already traced)

| Case                                             | Latest saved            | flagName | Action                           | Correct? |
| ------------------------------------------------ | ----------------------- | -------- | -------------------------------- | -------- |
| First startup, no entries                        | undefined               | "foo"    | append                           | ✓        |
| Restart same name                                | "foo"                   | "foo"    | skip                             | ✓        |
| Change name                                      | "foo"                   | "bar"    | append                           | ✓        |
| 50 duplicates from 0.1.12 era                    | "foo" (latest)          | "foo"    | skip                             | ✓        |
| "foo" vs "FOO"                                   | "foo"                   | "FOO"    | append (case-sensitive)          | ✓        |
| Malformed `data`                                 | undefined               | "foo"    | append (heals)                   | ✓        |
| Legacy `"foo "` saved + flag `"foo"`             | normalized both → match | "foo"    | skip                             | ✓        |
| Resume via `pi-link <name>` (env) matching saved | "foo"                   | "foo"    | skip; setSessionName independent | ✓        |

Logic is sound; the blocker is the mtime side-effect, not correctness.

## Review history

- Round 1 (gpt): identified else-branch normalization regression → fixed (helper returns raw, normalize at comparison site)
- Round 2 (gpt): identified mtime / recency side-effect → defer dedup indefinitely
- Round 3 (style review): noted helper extraction is borderline against user's style (2 callsites, single function); inline-first is the recommended approach if revived
