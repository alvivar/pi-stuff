# PLAN: pi-link CLI flag migration (0.1.15)

Wrapper-only change. Touches `bin/pi-link.mjs`, README, and skill. No `index.ts` changes.

## Problem

Two distinct issues in current `pi-link` CLI dispatch:

### 1. Reserved-word collision

`list` and `resolve` are subcommands. The names `list` and `resolve` cannot be used as session names through the wrapper. Future subcommand additions (`delete`, `rename`) compound the collision set.

### 2. Silent typo spawn

The launcher falls through on any unknown first positional, treating it as a session name. Combined with passthrough of trailing args, this produces silent surprising behavior:

- `pi-link lst` → name=`lst`, launches a new session called `lst`. Output: `"Starting new session."` — easy to miss.
- `pi-link resolv foo` → name=`resolv`, `foo` falls through to Pi passthrough. `pi --link foo` treats `foo` as an initial prompt. **User wanted resolve; got new session named "resolv" being asked to act on prompt "foo".**

The second pattern is worse than just creating a wrong-named session — it injects garbage into Pi as an initial prompt.

## Decision

Adopt **Option B (flags) + extra-positional rejection + soft deprecation + resolve exit-code fix**.

After GPT review:

- `--list` / `--resolve` cleanly fix reserved words. They don't fully solve typo-spawn (`pi-link lst` is still ambiguous — could be a typo OR an intentional new session name "lst"), but they shrink the hazard surface from "any subcommand-like word" to "names that happen to be common typos."
- Add a defensive rule: reject orphan positionals after the session name (catches the worst case `pi-link resolv foo` directly).
- Soft-deprecate `list` / `resolve` subcommands for one release with a stderr warning. Hard cut would re-create the bug during transition (`pi-link list` would silently create a session called "list").
- While touching `resolve`, fix the known bug: exit non-zero when the name doesn't resolve to anything.

## CLI surface (after change)

### Canonical forms

```
pi-link <name> [--global|-g] [pi-flags...]
                                Resume or create a named session, connected to link.

pi-link --list [--global|-g]
                                List pi-link sessions in current cwd (or everywhere with -g).

pi-link --resolve <name> [--global|-g]
pi-link --resolve=<name> [--global|-g]
                                Print just the session path (machine-readable).
                                Exit 0 on match, exit 2 on no match, exit 1 on ambiguity.
```

### Deprecated (one-release window)

```
pi-link list ...                # works, prints deprecation warning to stderr
pi-link resolve <name> ...      # works, prints deprecation warning to stderr
```

Removed in a future release. Warning text (single stderr line, prefixed `Warning:`):

```
Warning: 'pi-link list' is deprecated. Use 'pi-link --list' instead. (Subcommand form will be removed in a future release.)
Warning: 'pi-link resolve' is deprecated. Use 'pi-link --resolve' instead. (Subcommand form will be removed in a future release.)
```

**Warning vs. error ordering:** parse-time errors short-circuit the deprecation warning. `pi-link list extra` fails with `--list does not accept argument: extra` and emits no warning. This is intentional — telling the user their command is deprecated when it's also broken is noise. The warning fires only when the deprecated form would otherwise have run successfully.

### New validation rules

- `--list` accepts only `--global` / `-g`. Any positional or other flag → error.
- `--resolve` requires exactly one name. Accept `--resolve <name>` (separate tokens) or `--resolve=<name>` (joined). `--resolve` with no following non-flag → error. Empty name (`--resolve=""`) → error.
- Cannot mix modes: `--list --resolve foo` → error. `--list <name>` → error.
- **Launcher: orphan-positional rejection.** After the session name is set, any further token that does not start with `-` and does not immediately follow a flag → error.
  - Allowed: `pi-link worker --model opus` (`opus` follows the `--model` flag, treated as its value, passed through).
  - Allowed: `pi-link worker -- anything goes here` (after `--`, all tokens passthrough).
  - Rejected: `pi-link worker extra` (`extra` is a bare positional).
  - Rejected: `pi-link worker --no-flag-value-here extra extra2` if a flag-value pair is followed by another bare. (Caveat: a no-value Pi flag immediately followed by a typo can slip through. Acceptable narrow gap.)

### Error message specimens

All error lines prefixed with `Error:` (matches existing wrapper style). Helpful follow-on lines indented two spaces.

```
$ pi-link resolv foo
Error: Unexpected argument after session name: foo
  Use -- to pass positional arguments to pi.

$ pi-link --resolve
Error: --resolve requires a name argument.
  Usage: pi-link --resolve <name> [--global|-g]

$ pi-link --list extra
Error: --list does not accept argument: extra
  Usage: pi-link --list [--global|-g]

$ pi-link --resolve foo bar
Error: --resolve accepts exactly one name; got extra: bar

$ pi-link --list --resolve foo
Error: cannot combine --list and --resolve

$ pi-link --resolve foo --resolve bar
Error: --resolve specified more than once

$ pi-link --resolve nonexistent
(no stdout)
(exit code 2)
```

## Implementation outline

Parser is a single sequential pass over `process.argv.slice(2)`, populating a `state` object, then dispatching on `state.mode`.

```js
const state = {
  mode: null, // "help" | "list" | "resolve" | "launcher" | null
  resolveName: null, // string (after validation, non-empty)
  launcherName: null, // string
  global: false,
  piPassthrough: [],
  deprecated: null, // "list" | "resolve" | null (controls warning)
};
```

### Loop logic

```js
const args = process.argv.slice(2);
let afterSeparator = false;
let lastWasFlag = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];

  // Phase 1: after `--`, everything is passthrough (launcher mode only).
  if (afterSeparator) {
    state.piPassthrough.push(a);
    continue;
  }

  // Phase 2: global tokens.
  if (a === "--") {
    if (state.mode !== "launcher") {
      fail(`'--' separator only valid in launcher mode`);
    }
    afterSeparator = true;
    continue;
  }
  if (a === "--help" || a === "-h") {
    setMode("help"); // errors if combined with launcher/list/resolve
    continue;
  }
  rejectRenamedFlag(a); // --all / -a → exits with hint

  if (a === "--global" || a === "-g") {
    state.global = true;
    lastWasFlag = false;
    continue;
  }

  // Phase 3: mode-selecting flags.
  if (a === "--list") {
    setMode("list"); // errors if mode already set to something else
    continue;
  }
  if (a.startsWith("--resolve=")) {
    setMode("resolve");
    if (state.resolveName !== null) fail(`--resolve specified more than once`);
    state.resolveName = a.slice("--resolve=".length);
    continue;
  }
  if (a === "--resolve") {
    setMode("resolve");
    if (state.resolveName !== null) fail(`--resolve specified more than once`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("-")) {
      fail(
        `--resolve requires a name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`,
      );
    }
    state.resolveName = next;
    i++; // consume the value
    continue;
  }

  // Phase 4: deprecated subcommand detection (only when no mode set yet AND it's the first non-flag).
  if (state.mode === null && (a === "list" || a === "resolve")) {
    state.deprecated = a;
    if (a === "list") {
      setMode("list");
    } else {
      setMode("resolve");
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        state.resolveName = next;
        i++;
      }
      // else: leave resolveName null; validation below will error with "name required"
    }
    continue;
  }

  // Phase 5: mode-specific positionals.
  if (state.mode === "help") {
    fail(`--help does not accept arguments: ${a}`);
  }
  if (state.mode === "list") {
    fail(
      `--list does not accept argument: ${a}\n  Usage: pi-link --list [--global|-g]`,
    );
  }
  if (state.mode === "resolve") {
    // Deprecated-form leniency: `pi-link resolve --global foo` was allowed by the
    // original subcommand (order-independent --global). If we entered resolve mode
    // via the deprecated path and haven't bound a name yet, grab this positional.
    if (
      state.deprecated === "resolve" &&
      state.resolveName === null &&
      !a.startsWith("-")
    ) {
      state.resolveName = a;
      continue;
    }
    fail(`--resolve accepts exactly one name; got extra: ${a}`);
  }

  // Phase 6: launcher mode entry. mode is null here, no name set yet.
  if (state.mode === null) {
    rejectManagedFlag(a); // catches --session, --link-name etc. with the friendly message
    if (a.startsWith("-")) {
      fail(
        `Unknown argument: ${a}\n  Usage: pi-link <name> [--global|-g] [pi-flags...]`,
      );
    }
    state.mode = "launcher";
    state.launcherName = a;
    continue;
  }

  // Phase 7: in launcher mode, name is set. Tokens go to passthrough or get rejected.
  // state.mode === "launcher" here
  rejectManagedFlag(a);
  if (a.startsWith("-")) {
    state.piPassthrough.push(a);
    // `--key=value` is self-contained; only `--key` (without `=`) might consume
    // the next token as value.
    lastWasFlag = !a.includes("=");
    continue;
  }
  // Bare positional: allowed only if it follows a flag without `=` (treated as flag's value).
  if (lastWasFlag) {
    state.piPassthrough.push(a);
    lastWasFlag = false;
    continue;
  }
  fail(
    `Unexpected argument after session name: ${a}\n` +
      `  Use -- to pass positional arguments to pi.`,
  );
}
```

### setMode helper

```js
function setMode(newMode) {
  if (state.mode !== null && state.mode !== newMode) {
    fail(
      `cannot combine ${describeMode(state.mode)} and ${describeMode(newMode)}`,
    );
  }
  if (state.mode === "launcher" && newMode !== "launcher") {
    fail(`cannot combine session name and ${describeMode(newMode)}`);
  }
  state.mode = newMode;
}
```

### Post-parse validation

```js
if (state.deprecated) {
  console.error(
    `pi-link: '${state.deprecated}' subcommand is deprecated; ` +
      `use --${state.deprecated}${state.deprecated === "resolve" ? " <name>" : ""}. ` +
      `Will be removed in a future release.`,
  );
}

if (state.mode === "resolve") {
  if (!state.resolveName || state.resolveName.trim() === "") {
    fail(
      `--resolve requires a name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`,
    );
  }
}
```

### Dispatch

```js
switch (state.mode) {
  case "help":
  case null:
    printHelp();
    process.exit(0);
  case "list":
    await runList(state);
    break;
  case "resolve":
    await runResolve(state);
    break;
  case "launcher":
    await runLauncher(state);
    break;
}
```

`runList` / `runResolve` / `runLauncher` are extracted from the current top-level `if/else` chain — minimal refactor, just moving the body into named functions and reading from `state` instead of branch-local vars.

### `runResolve` exit-code fix

Current behavior:

```js
if (matches.length === 1) {
  process.stdout.write(matches[0].path);
} else if (matches.length > 1) {
  printCandidates(name, matches); // exits 1
}
// else: missing → falls through to end of script → exit 0
```

New behavior:

```js
if (matches.length === 1) {
  process.stdout.write(matches[0].path);
  return; // exit 0
}
if (matches.length > 1) {
  printCandidates(name, matches); // exits 1
}
// missing
console.error(
  `No session named "${name}" found${global ? "" : " in this cwd"}.`,
);
if (!global && (await findSessionsByName(name, dir, isCustom)).all.length > 0) {
  console.error(`(Matches in other cwds — try --global to consider them.)`);
}
process.exit(2);
```

Exit codes:

- `0`: single match, path printed to stdout
- `1`: ambiguous (multiple matches); candidate list printed to stderr
- `2`: not found (new behavior)

## Backwards compatibility

| Scenario                          | Old behavior                                                                                                                                       | New behavior                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-link list`                    | List subcommand                                                                                                                                    | Same output, plus stderr deprecation warning                                                                                                                   |
| `pi-link resolve foo`             | Resolve subcommand                                                                                                                                 | Same output, plus stderr deprecation warning                                                                                                                   |
| `pi-link resolve --global foo`    | Worked (--global was order-independent)                                                                                                            | Preserved via deprecated-form leniency in Phase 5 — `--global` parses normally, then `foo` is grabbed as the resolve name. Stderr deprecation warning emitted. |
| `pi-link resolve` (missing name)  | Error "Usage: ..."                                                                                                                                 | Same                                                                                                                                                           |
| `pi-link --list`                  | Today: launches new session named `--list`? Actually no — `--list` starts with `-` so it hits the "Unknown argument before name" check and errors. | New: works as list mode                                                                                                                                        |
| `pi-link --resolve foo`           | Today: errors as unknown flag                                                                                                                      | New: works as resolve mode                                                                                                                                     |
| `pi-link foo extra-positional`    | Passthrough to Pi (silently surprising)                                                                                                            | **Error**: "Unexpected argument after session name"                                                                                                            |
| `pi-link foo --model opus`        | Passthrough                                                                                                                                        | Passthrough (`opus` follows `--model` with no `=`, consumed as its value)                                                                                      |
| `pi-link foo --model=opus`        | Passthrough                                                                                                                                        | Passthrough (self-contained, no value-after-flag consumption)                                                                                                  |
| `pi-link foo --model=opus extra`  | Passthrough (silently surprising)                                                                                                                  | **Error**: `extra` is bare positional; `--model=opus` is self-contained                                                                                        |
| `pi-link foo --model opus extra`  | Passthrough                                                                                                                                        | **Error**: `opus` consumed as value of `--model`; `extra` is then a bare positional                                                                            |
| `pi-link foo -- anything here`    | Passthrough after `--`                                                                                                                             | Same                                                                                                                                                           |
| `pi-link foo --help`              | Passthrough → pi prints its own help                                                                                                               | **Error**: "cannot combine session name and --help". Run `pi --help` to see pi's help directly.                                                                |
| `pi-link --session foo.jsonl`     | Hit managed-flag rejection (worked today via pre-loop check)                                                                                       | Same: managed-flag rejection in Phase 6                                                                                                                        |
| `pi-link foo` where foo == "list" | Impossible (list was reserved)                                                                                                                     | Still triggers deprecation warning during window; after removal, works as expected                                                                             |

## Test plan

Use `bin/pi-link.mjs` directly under Node. Each case asserts exit code and key stderr/stdout substrings. Smoke priorities marked ⭐.

### A. Canonical forms

1. ⭐ `pi-link --list` (empty cwd) → exit 0, stdout: "No pi-link sessions..." OR table
2. ⭐ `pi-link --list -g` → exit 0, global scope
3. ⭐ `pi-link --resolve foo` (existing session) → exit 0, stdout = session path, no trailing newline
4. ⭐ `pi-link --resolve foo` (missing) → exit 2, stderr: "No session named..."
5. `pi-link --resolve=foo` (existing) → exit 0, same as #3
6. `pi-link --resolve=foo` (missing) → exit 2
7. `pi-link --resolve foo -g` → exit 0/2 with global scope applied

### B. Deprecation aliases

8. ⭐ `pi-link list` → exit 0, stderr has deprecation warning, output matches `--list`
9. ⭐ `pi-link resolve foo` → exit 0/2, stderr has deprecation warning + same output as `--resolve foo`
10. `pi-link list -g` → deprecation warning + global scope
11. `pi-link resolve foo -g` → deprecation warning + global scope

### C. Orphan-positional rejection (launcher mode)

**Note: cases that don't error require a stubbed `pi` on PATH (a shim that records argv and exits 0) since they would otherwise spawn a real Pi session. Cases marked [stub] need this; cases that exit before the launch can run against real PATH.**

12. ⭐ `pi-link foo extra` → exit 1, stderr: "Unexpected argument after session name"
13. ⭐ `pi-link resolv foo` → exit 1, stderr: "Unexpected argument after session name" (this is the typo case GPT flagged)
14. [stub] `pi-link foo --model opus` → passthrough; spawned argv contains `--model opus`
15. [stub] `pi-link foo --model=opus` → passthrough; spawned argv contains `--model=opus`
16. ⭐ `pi-link foo --model=opus extra` → exit 1, "Unexpected argument after session name: extra" (`=`-form is self-contained, `extra` is orphan)
17. `pi-link foo --model opus extra` → exit 1, "Unexpected argument after session name: extra" (`opus` consumed as flag value; `extra` is orphan)
18. [stub] `pi-link foo -- extra extra2` → passthrough (everything after `--`)

### D. Mode-selecting validation

19. `pi-link --list foo` → exit 1, stderr: "does not accept argument"
20. `pi-link --resolve` → exit 1, stderr: "requires a name argument"
21. `pi-link --resolve --global` → exit 1, stderr: "requires a name argument" (--global doesn't satisfy --resolve)
22. `pi-link --resolve foo bar` → exit 1, stderr: "accepts exactly one name"
23. `pi-link --list --resolve foo` → exit 1, stderr: "cannot combine"
24. `pi-link --resolve=""` → exit 1, stderr: "requires a name argument"
25. `pi-link foo --list` → exit 1, stderr: "cannot combine session name and --list"
26. `pi-link --resolve foo --resolve bar` → exit 1, stderr: "--resolve specified more than once"
27. `pi-link --resolve=foo --resolve=bar` → exit 1, stderr: "--resolve specified more than once"
28. [stub] `pi-link --global --resolve foo` → same as `--resolve foo -g` (mode-flag-after-global works)
29. `pi-link foo --help` → exit 1, stderr: "cannot combine session name and --help"

### E. Help / unknown / managed-flag rejection

30. `pi-link --help` / `-h` → exit 0, prints usage
31. `pi-link --help foo` → exit 1, stderr: "--help does not accept arguments"
32. `pi-link` (no args) → exit 0, prints usage to stderr
33. `pi-link --unknown` → exit 1, stderr: "Unknown argument: --unknown"
34. `pi-link --all` → exit 1, stderr: "--all was renamed to --global" (existing renamed-flag rejection)
35. `pi-link --session foo.jsonl` → exit 1, stderr: "--session is managed by pi-link. Remove it." (managed-flag rejection, now fires correctly via Phase 6 ordering fix)
36. `pi-link foo --session bar.jsonl` → exit 1, stderr: "--session is managed by pi-link. Remove it."
37. `pi-link foo --link-name bar` → exit 1, stderr: explicit "--link-name is not accepted by the pi-link wrapper" message

### F. Launcher mode (unchanged behavior, sanity check — manual smoke)

38. `pi-link <existing-name>` → resumes session, launches Pi
39. `pi-link <new-name>` → creates new session, launches Pi
40. `pi-link <existing-name> -g` → resumes via global scope
41. `pi-link <ambiguous-name>` → exit 1, prints candidates (requires same-name sessions in 2+ cwds)

### Test harness notes

- Cases marked [stub] require a fake `pi` on PATH. Suggested shim: a small Node script that writes `process.argv.slice(2).join(" ")` to a file in the working dir and exits 0. Assert on file contents.
- All other automatable cases either error before spawning Pi (most of A–E) or are manual launcher smoke (F).
- Smoke priorities ⭐ are cases **1, 2, 3, 4, 8, 9, 12, 13, 16**.

## Edge cases

| Case                                                                              | Behavior                                                                                                                                                                                          | Note                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-link list list` (deprecation window)                                          | dep warning, then "does not accept positional arguments" error                                                                                                                                    | The second `list` is a positional under `--list` mode                                                                                                                                                                             |
| `pi-link list extra-arg` (deprecation window)                                     | dep warning + "does not accept positional arguments" error                                                                                                                                        | Same as above                                                                                                                                                                                                                     |
| `pi-link "" --list`                                                               | empty-string first positional; today this would proceed to launcher with empty name → error from name validation. New: same path.                                                                 |                                                                                                                                                                                                                                   |
| `pi-link --resolve foo bar` where `foo` and `bar` are non-flag                    | Error "accepts exactly one name". User probably wanted `--resolve "foo bar"` (quoted), but we don't auto-join.                                                                                    |                                                                                                                                                                                                                                   |
| `pi-link foo --` (trailing separator, nothing after)                              | Launcher with name `foo`, passthrough empty. Same as `pi-link foo`.                                                                                                                               |                                                                                                                                                                                                                                   |
| `pi-link -- foo`                                                                  | Launcher with no name set yet, then `--` hits "only valid in launcher mode" error.                                                                                                                | Reasonable — `--` is for separating Pi flags from name, not for opening sessions named "list".                                                                                                                                    |
| `pi-link --global` alone                                                          | No mode set → falls to help branch. Today: same.                                                                                                                                                  |                                                                                                                                                                                                                                   |
| `pi-link --global --list`                                                         | --list works, global=true.                                                                                                                                                                        |                                                                                                                                                                                                                                   |
| `pi-link --list -g foo`                                                           | Error "does not accept positional arguments: foo"                                                                                                                                                 |                                                                                                                                                                                                                                   |
| `pi-link foo --some-bool-flag extra` (hypothetical no-value Pi flag, not managed) | `extra` follows a flag with no `=` → accepted into passthrough as if it were the flag's value. Pi receives `--some-bool-flag extra` and may treat `extra` as a prompt. **Narrow documented gap.** | Wrapper has no Pi-flag schema. `--no-session`, `--session`, `--continue`, `-c`, `--resume`, `-r`, `--fork`, `--session-dir`, `--link-name` are all managed and rejected before this rule applies, so the gap is genuinely narrow. |
| `pi-link --list list` (deprecation form, immediate)                               | Phase 4 sets mode=list via deprecated path, dep warning set. Then second `list` is bare positional under mode=list → "does not accept argument: list" error.                                      | Edge case: someone literally typing `pi-link list list`. Rare but defined.                                                                                                                                                        |
| Renamed-flag rejection still fires                                                | `pi-link --all` → "renamed to --global" (existing behavior)                                                                                                                                       | Order-independent: works whether `--all` is first or later token                                                                                                                                                                  |

## Open questions

1. **Should `--resolve` accept STDIN piping for the name?** e.g., `echo foo | pi-link --resolve -`. No — out of scope. Defer until a use case arises.

2. **Should the deprecation warning be suppressible via env var?** e.g., `PI_LINK_NO_DEPRECATION_WARN=1` for users with scripts. Probably no — the deprecation window is short, and the warning is stderr-only so it doesn't pollute stdout pipes. Defer.

3. **Should the help text show both forms during the deprecation window, or just the canonical form?** Lean: just canonical. Deprecated forms still work; they just don't need to be advertised.

4. **Should `pi-link <name>` where name is empty after trim be a more helpful error?** Currently it says "Usage: ..." which is fine. Could say "session name cannot be empty". Cosmetic.

5. **`--resolve` with ambiguous name: keep exit 1 with candidate list, or change to exit 3?** Plan keeps exit 1 (matches today). Multiple distinct exit codes for resolve outcomes is overkill — stderr message disambiguates.

6. **Should we keep the renamed-flag rejection (`--all` → `--global`) past the next major version?** Not in scope for this plan, but worth noting: it's been there since 0.1.12. Probably safe to remove eventually.

## CHANGELOG entry (draft, folds into 0.1.15)

```
### Added

- **`--list` and `--resolve <name>` flag forms** for the `pi-link` CLI wrapper. Use instead of the `list` / `resolve` subcommands. `--resolve=<name>` joined form also accepted.

### Changed

- **`pi-link resolve <missing-name>` now exits with code 2** (was 0). Single match still exit 0; ambiguous still exit 1; not found is now distinguishable.
- **`pi-link <name> <extra-positional>` now errors** instead of silently passing the extra to Pi as a prompt. Catches typos like `pi-link resolv foo`. Use `--` separator to pass bare positionals through: `pi-link worker -- some-positional-arg`.

### Deprecated

- **`pi-link list` and `pi-link resolve` subcommands.** Use `--list` / `--resolve` instead. Subcommands still work for one release with a stderr warning, then will be removed.
```

## Implementation order

1. Refactor current `if/else` dispatch into `runList(state)` / `runResolve(state)` / `runLauncher(state)` functions. No behavior change yet. Smoke-test that everything still works.
2. Add the sequential parser populating `state`. Wire dispatch through it.
3. Add `--list` / `--resolve` flag handling.
4. Add deprecated-subcommand detection + warning.
5. Add orphan-positional rejection in launcher mode.
6. Fix `runResolve` exit code on missing.
7. Update README usage section.
8. Update skill (`skills/pi-link-coordination/SKILL.md`) wherever it shows `pi-link list` / `pi-link resolve` examples.
9. Update help text printed on `--help` / no-args.
10. Run automated cases 1–28.
11. Manual smoke for 29–32.

Estimated implementation: ~120 LOC added, ~30 LOC modified in `bin/pi-link.mjs`. ~10 LOC of skill/README updates.

Smaller than context-display work. Disjoint from `index.ts`; can ship together in 0.1.15 with low risk-compounding.
