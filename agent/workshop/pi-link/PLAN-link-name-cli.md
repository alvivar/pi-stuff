# Plan: `--link-name` Cleanup + Resolver

## Problem

Spawning Pi from a Node parent process breaks shift+enter on Windows.
Terminal escape sequences are lost when a live Node parent holds the TTY.
This affects both the re-exec shim in `index.ts` and `pi-link start`.
No known fix — it's a platform-level TTY issue.

## Solution: resolver + shell function

Split into two concerns:

1. **Resolver** (`bin/pi-link.mjs`) — scans sessions, prints path, exits. No spawn.
2. **Shell function** — calls resolver, then launches `pi` directly. Pi is a direct
   child of the shell. Shift+enter works.

## Changes

### 1. Revert re-exec shim from `index.ts`

Remove everything added in commit `c2e972d`:

- Imports: `fs`, `path`, `readline`, `spawn`
- Constants: `SESSION_VALUE_FLAGS`, `SESSION_BOOL_FLAGS`
- Functions: `samePath`, `hasSessionFlag`, `buildReexecArgs`,
  `findCwdSessionsByName`, `readSessionMeta`, `tryReexec`
- The `tryReexec` call in `session_start`

`--link-name` goes back to: set name, persist, connect. No session scanning.

### 2. Discard uncommitted changes

```bash
git checkout -- agent/extensions/pi-link/index.ts agent/extensions/pi-link/bin/pi-link.mjs
```

Gets back to committed state (commit `c2e972d`), then apply the revert on top.

### 3. Convert `bin/pi-link.mjs` → `bin/pi-link.mjs`

Strip spawn logic. Script becomes:

- Takes `<name>` as sole argument
- Scans sessions by name (existing logic)
- 1 match: prints session path to stdout, exits 0
- 0 matches: prints nothing, exits 0
- Multiple: prints candidates to stderr, exits 1

No spawn. No `PI_LINK_REEXEC`. No `findPiCli`.

### 4. Update `package.json`

```json
"bin": {
  "pi-link": "./bin/pi-link.mjs"
}
```

Keeps resolver on PATH for shell functions. Old `pi-link` command removed.

### 5. Document shell functions in README

PowerShell:

```powershell
function pl {
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$name,
        [Parameter(ValueFromRemainingArguments=$true)]
        [string[]]$flags
    )
    $session = pi-link resolve $name
    if ($LASTEXITCODE -ne 0) { return $LASTEXITCODE }
    if ($session) {
        pi --session $session --link-name $name @flags
    } else {
        pi --link-name $name @flags
    }
}
```

Bash/Zsh:

```bash
pl() {
    local name="$1"
    if [ -z "$name" ]; then
        echo "Usage: pl <name> [pi flags...]" >&2
        return 1
    fi
    shift
    local session
    session=$(pi-link resolve "$name") || return $?
    if [ -n "$session" ]; then
        pi --session "$session" --link-name "$name" "$@"
    else
        pi --link-name "$name" "$@"
    fi
}
```

### 6. Update CHANGELOG

- Reverted: re-exec shim (terminal input broken when Pi spawned from Node)
- Changed: `pi-link start` → `pi-link resolve` (resolver only, no spawn)
- Added: shell function examples for session resume

## What stays

- `--link-name` flag (sets name, persists, connects — no session scanning)
- `--link` flag
- All link functionality (hub/client, tools, commands)
- Session scanning logic (in resolver script)
- Startup stale-context bug fix (commit `147e522`)

## What goes

- Re-exec shim (~190 lines from index.ts)
- `pi-link start` as an npm bin command that spawns Pi
- `PI_LINK_REEXEC` env var
- Direct node spawn / `findPiCli()` PATH scanning

## Key clarification for docs

`--link-name` sets link identity only. It does NOT resume by name.
To resume by name, use the `pi-link` shell function (which calls the resolver,
then launches `pi --session <path> --link-name <name>` directly).

## Failed approach: re-exec shim

The re-exec shim (commit `c2e972d`) tried to make `pi --link-name` self-sufficient
by scanning sessions in `session_start` and spawning a new Pi process with the
correct `--session` flag. This broke shift+enter on Windows because the parent
Node process holds the TTY and interferes with terminal escape sequences.

Tested: `cmd /c pi`, direct `process.execPath + cli.js`, `stdio: "inherit"`,
`detached: true`, destroying parent stdin — all broken. The only configuration
where shift+enter works is when Pi is a direct child of the user's shell.
