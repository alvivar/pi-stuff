# PLAN — Restore `--link-name` extension flag (link-only)

**Source proposal**: `PROPOSAL-fresh-or-decouple.md` (reviewed, design clean)
**Target release**: 0.1.13 (currently has two small fixes; this becomes the headline `Added`)

---

## Diff scope (file:line touchpoints)

### 1. `index.ts` line ~112 — register the flag

Alongside the existing `pi.registerFlag("link", ...)`:

```ts
pi.registerFlag("link-name", {
  description:
    "Set the pi-link terminal name on startup (link identity only; does not affect session)",
  type: "string",
});
```

No default — undefined means absent.

### 2. `index.ts` lines ~930–941 — refactor session_start name resolution

**Current**:

```ts
const rawLinkName = process.env.PI_LINK_NAME;
delete process.env.PI_LINK_NAME;
const flagName = rawLinkName?.trim().replace(/\s+/g, " ") || undefined;

if (flagName) {
  preferredName = flagName;
  terminalName = flagName;
  pi.appendEntry("link-name", { name: flagName });
  if (!pi.getSessionName()) pi.setSessionName(flagName);
} else {
  // saved / session / random fallback
}
```

**New**:

```ts
// Resolve terminal name. Precedence:
//   --link-name flag  >  PI_LINK_NAME env  >  saved link-name  >  session name  >  random
//
// --link-name is the public CLI surface (link identity only, never touches session).
// PI_LINK_NAME is the internal handoff used by the `pi-link` wrapper, which DOES
// also seed session name when absent (the wrapper's combined-mode contract).
const cliRaw = pi.getFlag("link-name");
let cliFlagName: string | undefined;
if (typeof cliRaw === "string") {
  cliFlagName = cliRaw.trim().replace(/\s+/g, " ");
  if (!cliFlagName) {
    console.error("Error: --link-name requires a non-empty value.");
    process.exit(1);
  }
}

const envRaw = process.env.PI_LINK_NAME;
delete process.env.PI_LINK_NAME;
const envFlagName = envRaw?.trim().replace(/\s+/g, " ") || undefined;

const flagName = cliFlagName ?? envFlagName;
const fromEnv = !cliFlagName && !!envFlagName;

if (flagName) {
  preferredName = flagName;
  terminalName = flagName;
  pi.appendEntry("link-name", { name: flagName });
  // Critical: only the env path (wrapper combined mode) touches session name.
  // Public --link-name is link-only.
  if (fromEnv && !pi.getSessionName()) pi.setSessionName(flagName);
} else {
  // (unchanged) saved / session / random fallback
}

if (flagName || shouldConnect(_ctx)) scheduleStartupConnect();
```

The `flagName || shouldConnect` line stays as-is — `flagName` is truthy whenever either source provides a name, so connect-on-startup is implied for both, mirroring current `PI_LINK_NAME` behavior.

### 3. `bin/pi-link.mjs` lines ~252–255 — update rejection message

**Current**:

```js
if (key === "--link-name") {
  console.error("Error: --link-name was removed. Use: pi-link <name>");
  process.exit(1);
}
```

**New**:

```js
if (key === "--link-name") {
  console.error(
    "Error: --link-name is not accepted by the pi-link wrapper.\n" +
      "  Use 'pi-link <name>' for combined link+session,\n" +
      "  or run 'pi --link-name <name>' directly to set link name without session resolution.",
  );
  process.exit(1);
}
```

Comment on line 248 also needs an update: "plus the removed --link-name extension flag" → "plus --link-name (which exists at the `pi` level for link-only naming, but the wrapper's combined-mode contract conflicts with it)".

### 4. `CHANGELOG.md` — add `### Added` to 0.1.13

Insert above the existing `### Fixed`:

```md
### Added

- **`--link-name <name>` flag for link-only startup naming.** Run `pi --link-name worker` to join the link as `worker` while leaving Pi's normal session selection/resume behavior untouched. This restores link-name startup naming in a cleaner form than the previous session-coupled implementation: it sets only the pi-link identity, with hub collision handling unchanged. Use `pi-link <name>` when you want the combined session-by-name + link-name workflow. Empty or whitespace-only names are rejected. The `pi-link` wrapper itself does not accept `--link-name` — its rejection message now points to either `pi-link <name>` (combined) or `pi --link-name <name>` (direct, link-only).
```

### 5. `README.md` — mention `pi --link-name`

Find the discovery section that currently describes `pi-link <name>`, add a brief paragraph or row noting the link-only alternative. Phrasing TBD; keep `PI_LINK_NAME` out of README (internal-only per session rules).

---

## Test strategy

Manual verification (no automated test infra in workshop yet):

1. **`--link-name` sets identity, leaves session alone**:
   - Fresh dir, `pi --link-name foo` → terminal joins as `foo`, Pi session picked normally (whatever Pi defaults to without `--link-name`)
   - Verify: `pi.getSessionName()` is NOT `foo` (some other auto-derived name or whatever Pi uses)
   - Verify: `link_list` from another terminal shows `foo`

2. **Empty/whitespace rejection (CLI)**:
   - `pi --link-name=""` → exits with `Error: --link-name requires a non-empty value.`
   - `pi --link-name="   "` → same exit error
   - `pi --link-name` (no value) → Pi's flag parser rejects upstream with missing-value diagnostic
   - Critically, even with `PI_LINK_NAME=bar` in env, an empty CLI value still errors and exits (CLI wins; CLI's empty value is still CLI). Env's empty value continues to fall through silently (existing behavior, preserved).

3. **Precedence — CLI wins over env**:
   - `PI_LINK_NAME=bar pi --link-name foo` → terminal is `foo`, session not set to either (CLI path)
   - `PI_LINK_NAME=bar pi` → terminal is `bar`, session set to `bar` if absent (env path retains old behavior)

4. **Persistence**:
   - `pi --link-name foo`, exit, reopen same session → terminal name is `foo` (saved link-name entry restored)

5. **Wrapper rejection**:
   - `pi-link --link-name foo` → exits with new error message pointing at both alternatives
   - `pi-link foo --link-name bar` → same rejection (rejectManagedFlag runs on each arg)

6. **`pi-link <name>` unchanged**:
   - `pi-link foo` → wrapper sets `PI_LINK_NAME=foo`, env path runs in extension, session and link both seeded — exactly as before

---

## Out of scope

- **`--session-name` flag**: requires upstream Pi PR. Tracked separately in proposal's "Future work."
- **Refactoring the env path**: leave existing `PI_LINK_NAME` behavior intact, including the session-name seeding. The wrapper's combined-mode contract depends on it.
- **Skill update**: not needed (CLI-level, agents don't invoke `pi` from session).

---

## Final review pass

After implementation, send diff summary to gpt for one final sanity check before committing. Specifically verify:

- Critical guard (`if (!cliFlagName && !pi.getSessionName())`) is present and correct
- Comment updates match reality (STYLE.md rule #9)
- CHANGELOG framing avoids "we reverted"
- README mention doesn't leak `PI_LINK_NAME`

Then update workshop, verify with `tsc --noEmit` if applicable, commit.
