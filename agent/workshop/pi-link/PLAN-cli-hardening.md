# PLAN — CLI hardening (bin/pi-link.mjs + test/cli-flags-test.mjs)

> **Status:** Executable
> **Last aligned:** 2026-07-01
> **Build from this?** Yes — after clearing the open decisions below.
> **Open decisions:** D1 displayPath separator (rec: (a) forward slashes) · D2 `--version` shape (rec: bare semver to stdout, `-V` alias, mirror `--help` exclusivity) · D3 removed `list`/`resolve` fate (rec: (a) hard-error tombstone) · D4 `rejectRenamedFlag` `--all`/`-a` (rec: remove entirely).
> **Gate:** `node test/cli-flags-test.mjs` (40/40 at plan time) + esbuild bundle check.
> **Summary:** three items (shipped-code changes only) — #2 displayPath separator (cosmetic), #3 `--version` flag (owner-requested), #4 remove 0.1.12 deprecation shims (owner-requested; only item that changes existing behavior, on already-deprecated paths). Former #1 (fixture tests) **moved to PLAN-review-followups.md T5** (2026-07-13); numbering kept to preserve references. Version strings in the body predate the current release — don't copy them literally.

The index.ts review follow-ups shipped (6 findings, live-verified). The CLI
never got its own hardening pass beyond the flag-parser work. This plan now
carries the shipped-code items only; the **--list/--resolve coverage gap**
lives in PLAN-review-followups.md T5.

Gates green at plan time: `node test/cli-flags-test.mjs` → 40/40.

**Nature:** #2 is a one-line display
fix behind one decision; #3 adds a `--version` flag (owner request,
2026-06-09); #4 removes the 0.1.12 deprecation shims (owner request,
2026-06-09) — the only item that changes existing behavior, and only on
already-deprecated paths.

## Decisions

- **D1 (open) — displayPath separator style.** Pick one:
  - **(a) Forward slashes everywhere** (recommended): non-home paths also get
    `.replace(/\\/g, "/")`. Matches the `~/...` form already shown for home
    paths; one visual style per table.
  - **(b) Platform separator everywhere:** home-relative renders `~\foo` on
    Windows. More native, but changes the existing `~/` form.
- **D2 (open) — `--version` shape.** Recommended defaults, veto anything:
  - Output: **bare semver to stdout** (`0.1.16`), exit 0 — script-friendly
    (`pi-link --version | ...`), like npm. Alternative: `pi-link 0.1.16`.
  - Alias: `-V` (capital, the common CLI convention; lowercase `-v` is too
    easily confused with verbose). Alternative: no alias.
  - Combination semantics: **mirror `--help` exactly** — `--version` is an
    exclusive mode; `pi-link foo --version` → exit 1 "cannot combine" (D29
    precedent), `--version foo` → exit 1 "does not accept arguments" (E31
    precedent). Forwarding a literal `--version` to pi remains possible via
    `pi-link foo -- --version`.
  - Bonus: prepend `pi-link v<version>` to `printHelp()` output so the bare
    invocation (your help shortcut) also surfaces it.
- **D3 (open) — fate of removed `list`/`resolve` subcommands.** The hazard:
  after plain removal, `pi-link list` parses as a session **name** and
  silently creates a session called "list" — a muscle-memory trap. Pick one:
  - **(a) Hard-error tombstone** (recommended): bare `list` / `resolve` at the
    name position → `Error: 'pi-link list' was removed. Use 'pi-link --list'.`
    exit 1. ~4 lines replacing ~25 lines of working-alias machinery; the trap
    is closed; sessions named exactly `list`/`resolve` stay launchable via
    `--resolve`-printed paths (corner case, acceptable). Revisit removal of
    the tombstone never — it's free.
  - **(b) Full removal:** `list`/`resolve` become ordinary session names.
    Purest, but enables the silent-session trap for 4 releases of muscle
    memory.
- **D4 (open) — `rejectRenamedFlag` (`--all`/`-a`).** Recommended: **remove
  entirely.** It's been a hard error (not a working alias) since 0.1.12; the
  pointer text has served its purpose. Removal also fixes a real wart: the
  check is always-on, so `pi-link foo -a` currently errors instead of passing
  `-a` through to pi — the shim shadows pi's flag namespace. After removal:
  `--all` before a name → generic "Unknown argument" (correct); after a name
  → forwarded to pi (correct). Alternative: keep it; costs the passthrough
  hole.
- **Decided by convention (no sign-off needed):**
  - No version bump / CHANGELOG edits in this plan (handled by hand separately).

---

## #1 — moved

Fixture-based coverage for `--list`/`--resolve`/launcher resolution moved to
**PLAN-review-followups.md T5** (2026-07-13), together with its conventions
(inline temp-dir fixtures, no mtime-ordering assertions). Numbering of #2–#4
kept to preserve decision references.

---

## #2 — `displayPath` separator consistency (cosmetic; blocked on D1)

**Where:** `displayPath`, bin/pi-link.mjs ~L116–124. Visible in `--list`
(`CWD` column) and `--list -g`.

**Problem:** the two return branches disagree on Windows — home-relative paths
render with `/` (`~/projects/foo`), non-home paths keep `\` (`D:\work\bar`) —
two path styles in the same table column. Display-only; `normalizePath`
comparisons are unaffected.

**Fix (per D1a, recommended):**

```js
return p.replace(/\\/g, "/");
```

on the final branch (and the `normP === normHome` → `"~"` branch stays as-is).
If D1b instead: replace the home-branch's `.replace(/\\/g, "/")` with the
platform separator.

**Risk:** none (display string only).
**Verify:** `--list -g` on Windows with home and non-home sessions shows one
separator style. (Can ride on H6's fixtures if PLAN-review-followups T5 lands
first; otherwise eyeball.)

---

## #3 — `--version` flag (feature; owner request)

**Where:** bin/pi-link.mjs — version helper near `printHelp` (~L287); flag
recognition alongside `--help`/`-h` in the mode-selection phase (the `"help"`
dispatch, ~L490); usage line in `printHelp`.

**Problem:** the CLI has no way to report what's installed — the only options
today are `npm ls pi-link` or reading package.json by hand. Routine for
"is my install current?" checks, bug reports, and pairing the CLI with the
extension version shown in Pi.

**Fix:**

```js
function printVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    console.log(pkg.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
}
```

- `readFileSync` is already imported; the `URL` form needs no new imports and
  is correct regardless of cwd or how the bin was invoked (npm shim, direct
  node, symlink).
- Parser: register `--version` (and `-V` per D2) exactly where `--help`/`-h`
  is recognized, dispatching a `"version"` mode with the same exclusivity
  rules (cannot combine with a session name or other modes; accepts no
  arguments). Never forwarded to pi.
- Output to **stdout** (machine-readable), unlike help's stderr — deliberate.
- Add one usage line to `printHelp`.

**Tests (section I, extends the gate):**

| #   | Case                  | Asserts                                                 |
| --- | --------------------- | ------------------------------------------------------- |
| I1  | `--version`           | exit 0; stdout matches `/^\d+\.\d+\.\d+/`; stderr empty |
| I2  | `-V` (if D2 keeps it) | same as I1                                              |
| I3  | `--version foo`       | exit 1, "does not accept arguments" (mirror E31)        |
| I4  | `foo --version`       | exit 1, "cannot combine" (mirror D29)                   |
| I5  | `--list --version`    | exit 1, "cannot combine" (mirror D23)                   |

**Risk:** low — new exclusive mode; only collision surface is the parser's
unknown-flag path, covered by I3–I5.
**Verify:** section I green; `E33: --unknown` still rejects (proves `--version`
recognition didn't loosen unknown-flag handling).

---

## #4 — Remove 0.1.12 deprecation shims (behavior change; owner request)

**Where:** bin/pi-link.mjs — header comment (L12–13), `rejectRenamedFlag`
(~L243), `printDeprecationWarning` (~L296), parser phase docs (L318–322),
`state.deprecated` (~L332), Phase 1 call site (~L348), Phase 4 subcommand
detection (~L395), Phase 5 resolve-ordering leniency (~L420), dispatch warning
(~L483). Plus README's legacy-forms note (~L223) and tests B8–B11.

**Problem:** the 0.1.12 deprecations promised removal after one release;
we're four releases on. The compatibility machinery is now the majority of
the parser's special-casing: a dedicated state field, a detection phase, an
ordering-leniency rule that exists _only_ for the deprecated form, and an
always-on flag shim that blocks `-a`/`--all` from ever reaching pi.

**Fix (per D3a + D4-remove, recommended):**

- Delete `printDeprecationWarning`, `state.deprecated`, the Phase 4 detection
  block, the Phase 5 leniency clause, and the dispatch-time warning.
- Replace with a tombstone at the name-binding position:

  ```js
  if (token === "list" || token === "resolve") {
    fail(`'pi-link ${token}' was removed. Use 'pi-link --${token}'.`);
  }
  ```

- Delete `rejectRenamedFlag` and its Phase 1 call; `--all`/`-a` now follow
  the ordinary rules (unknown before a name, forwarded to pi after).
- README: drop the legacy-forms paragraph.
- Tests: rewrite B8–B11 — `list` → exit 1 "was removed"; `resolve nope` →
  exit 1 "was removed"; rewrite `E34: --all (renamed)` → exit 1 "Unknown
  argument"; add `foo -a` → passthrough-to-pi (expectSpawn) to pin the
  un-shadowing.

**Risk:** moderate-low — deliberate breaks on warned paths only; the parser
gets _simpler_ (net-negative diff). The one behavior to pin carefully is the
new passthrough of `-a`/`--all` after a name (expectSpawn case).
**Verify:** full suite green with rewritten B-section; manual
`pi-link list` shows the tombstone.

---

## Noted, no action

- **Bare `pi-link` prints help, exits 0** — owner decision (2026-06-09),
  guarded by test `E32`.
- **CHANGELOG "Deprecated" entries (0.1.12)** — historical record, never
  edited retroactively; #4's removal gets its own entry at release time (by
  hand, per convention).
- **Full-file JSONL scans in `--list`/`--resolve`** — required for correctness
  (last-wins link-name + message counts need the whole file). Fine at personal
  scale; revisit only at hundreds of multi-MB session files.

## Explicitly out of scope

- `index.ts` — covered by the shipped review passes.
- New CLI capabilities (JSON output mode, session pruning, richer `--list`) —
  separate plan if ever wanted.
- Sort-order assertions (mtime flake risk).
- Refactors to `bin/pi-link.mjs` structure — the 7-phase parser is settled.

## Sequencing

1. **Pass B — D1 decision, then #2.** One-line edit + manual eyeball of
   `--list -g` (or ride on T5's H6 fixtures if those landed). Gate: full
   suite green.
2. **Pass C — D2 decision, then #3.** `printVersion` + parser registration +
   help line + section I tests, in one pass (feature and its tests are one
   unit). Gate: full suite green.
3. **Pass D — D3/D4 decisions, then #4.** Shim removal + tombstone + B-section
   rewrite + README note, in one pass. Last on purpose: it rewrites existing
   tests, so it must not interleave with passes that rely on the current
   B-section as a stable gate. Gate: full suite green; manual tombstone check.

**Gate (mechanical, after each pass):**

```
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs
```

(No esbuild gate — `bin/pi-link.mjs` is plain Node ESM, run directly.)
