# GitHub Issue Draft — Contribution Proposal

## What do you want to change?

Make `--session` also match by display name. Right now `pi --session worker-1` only checks paths and ID prefixes. If there's a session named `worker-1`, it should find it.

ID prefix matching should stay first for backward compat. If multiple sessions share the same name, error out and show the candidates — names aren't unique.

## Why?

I maintain [pi-link](https://www.npmjs.com/package/pi-link), a multi-terminal coordination extension. Each terminal gets a name like `worker-1` or `reviewer`, and resuming a session by that name is the common case: `pi-link worker-1`.

The extension can't do name resolution from inside Pi — session selection happens in `main.js` before extensions load. So `pi-link` ships a launcher that walks `~/.pi/agent/sessions/`, reads session metadata, finds the match, and spawns `pi --session <path>`. It works, but it duplicates logic that already lives in `SessionManager` (`buildSessionInfo()`, `list()`, `listAll()`) — the launcher reimplements file scanning, name extraction, and ambiguity handling outside the package that owns that data.

If `--session` matched by display name natively, the launcher could be removed and `pi --session worker-1` would just work for everyone, not only pi-link users.

`buildSessionInfo()` already extracts `name` and `list()`/`listAll()` already return it. `resolveSessionPath()` just doesn't check it.

## How?

After each ID prefix check in `resolveSessionPath()`, add a name check:

```js
const localNameMatches = localSessions.filter((s) => s.name === sessionArg);
if (localNameMatches.length === 1)
  return { type: "local", path: localNameMatches[0].path };
if (localNameMatches.length > 1)
  return { type: "ambiguous_name", arg: sessionArg, matches: localNameMatches };
```

Same after the global ID check. Handle `ambiguous_name` in `createSessionManager()` by printing candidates and exiting.

I can submit a PR if you're open to this.
