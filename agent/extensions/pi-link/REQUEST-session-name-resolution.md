# Feature request: allow `--session` to resolve by display name

## Summary

`pi --session worker-1` should be able to find a session whose display name is `worker-1`, not only a session whose ID starts with `worker-1`.

## Current behavior

`--session <arg>` resolves as:

1. File path (if contains `/`, `\`, or ends with `.jsonl`)
2. Local session ID prefix match
3. Global session ID prefix match
4. Not found → error

Display names assigned in the UI or via `setSessionName()` are ignored during resolution, even though `buildSessionInfo()` already extracts them and `SessionManager.list()`/`listAll()` already return them.

## Proposed behavior

Add exact display-name matching after ID prefix matching:

1. File path
2. Local session ID prefix match
3. **Local exact display-name match**
4. Global session ID prefix match
5. **Global exact display-name match**
6. Not found → error

ID prefix keeps priority over name to preserve backward compatibility.

## Example

```bash
# Name a session
> /name worker-1

# Later, resume it by name
$ pi --session worker-1
```

## Ambiguity handling

Display names are user-assigned and may not be unique. When multiple sessions share a name:

```
Multiple sessions named "worker-1":

  2026-04-25 13:10  cwd: C:\projects\repo-a
  abc12345  C:\Users\...\.pi\agent\sessions\...\abc12345.jsonl

  2026-04-24 18:02  cwd: C:\projects\repo-b
  def67890  C:\Users\...\.pi\agent\sessions\...\def67890.jsonl

Use a session ID or path to disambiguate:
  pi --session abc12345
```

Rules:

- Exactly one local match → open it
- Multiple local matches → error with candidates
- No local match, exactly one global match → existing global-session behavior (prompt to fork if different cwd)
- No local match, multiple global matches → error with candidates

## Implementation sketch

In `resolveSessionPath()`, after the existing ID prefix checks:

```js
// After local ID prefix check, before global search:
const localNameMatches = localSessions.filter((s) => s.name === sessionArg);
if (localNameMatches.length === 1) {
  return { type: "local", path: localNameMatches[0].path };
}
if (localNameMatches.length > 1) {
  return { type: "ambiguous_name", arg: sessionArg, matches: localNameMatches };
}

// After global ID prefix check:
const globalNameMatches = allSessions.filter((s) => s.name === sessionArg);
if (globalNameMatches.length === 1) {
  const match = globalNameMatches[0];
  return { type: "global", path: match.path, cwd: match.cwd };
}
if (globalNameMatches.length > 1) {
  return {
    type: "ambiguous_name",
    arg: sessionArg,
    matches: globalNameMatches,
  };
}
```

Then handle `ambiguous_name` in `createSessionManager()` by printing candidates and exiting.

Exact matching only — no fuzzy or case-insensitive lookup in v1. This proposal does not change existing ID-prefix behavior; ambiguity handling applies only to display-name matches.

## Why this belongs in Pi core

Session selection happens in `main.js` before extensions load. Extensions see flags only after Pi has already created/opened a session, so they cannot implement resume-by-name. Wrapper and re-exec workarounds are fragile, especially for terminal UI behavior on Windows.

The clean solution is for Pi to resolve names where it already resolves IDs.

## Motivating use case

This came up building a Pi extension that assigns terminal names and connects on startup. The desired workflow:

```bash
pi --session worker-1 --link-name worker-1
```

Without name resolution, the extension ships a separate resolver CLI and platform-specific shell scripts — all to bridge the gap between "Pi knows the session name" and "Pi can't look it up." Supporting name lookup in `--session` would eliminate that tooling.

But the need is general: if users can name sessions, the CLI should be able to open them by name.
