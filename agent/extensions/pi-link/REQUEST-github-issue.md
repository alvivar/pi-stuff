# GitHub Issue Draft — Contribution Proposal

## What do you want to change?

`--session` resolves by path and ID prefix but ignores display names. I'd like it to also try exact display-name matching, so `pi --session worker-1` opens the session named `worker-1`.

Resolution order: path → local ID prefix → **local name** → global ID prefix → **global name** → not found. ID prefix keeps priority. Multiple name matches should error with candidates, since names are user-assigned and not unique like IDs.

## Why?

If Pi lets users name sessions, the CLI should be able to open a session by that name.

I'm building [pi-link](https://www.npmjs.com/package/pi-link), a multi-terminal coordination extension. Terminals get names like `worker-1` and `reviewer`, and the natural command is `pi --session worker-1 --link-name worker-1`.

This needs to be in core because session selection happens in `main.js` before extensions load. By the time an extension's `session_start` runs, Pi has already created/opened a session. Wrapper/re-exec workarounds are also fragile for terminal UI behavior, especially on Windows.

`buildSessionInfo()` already extracts `name`, and `SessionManager.list()` / `listAll()` already return it. The data is there; `resolveSessionPath()` just doesn't check it.

## How?

In `resolveSessionPath()`, after each ID prefix check, add exact-name matching:

```js
const localNameMatches = localSessions.filter((s) => s.name === sessionArg);
if (localNameMatches.length === 1)
  return { type: "local", path: localNameMatches[0].path };
if (localNameMatches.length > 1)
  return { type: "ambiguous_name", arg: sessionArg, matches: localNameMatches };
```

Same pattern after the global ID check. Handle `ambiguous_name` in `createSessionManager()` by printing candidates and exiting.

Happy to submit a PR if this direction looks right.
