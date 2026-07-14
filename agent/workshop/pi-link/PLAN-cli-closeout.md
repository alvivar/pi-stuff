# PLAN — CLI closeout (shim removal + resolution-core tests)

> **Status:** Executable (Task 3 optional, blocked on one owner call)
> **Last aligned:** 2026-07-13
> **Build from this?** Yes — Tasks 1–2 are fully decided; Task 3 only if the owner reconfirms wanting `--version`.
> **Open decisions:** none for Tasks 1–2 · Task 3 go/no-go (owner reconfirmation of the 2026-06-09 `--version` request; if go, minimal shape below).
> **Gate:** `node --check bin/pi-link.mjs` + `node test/cli-flags-test.mjs` (40/40 at plan time; ~44 after Task 2). No esbuild gate — `index.ts` is untouched by this plan.
> **Summary:** consolidates the survivors of PLAN-cli-hardening.md and PLAN-review-followups.md (both retired; see Provenance). Two tasks, serialized: **Task 1** removes the 0.1.12 deprecation shims (net-deletion, ~25 lines of compat machinery, closes the `-a`/`--all` passthrough hole); **Task 2** adds the 4-case resolution-semantics test core (no harness changes needed). **Task 3** (optional) is a minimal `--version`.

Scope is `bin/pi-link.mjs` + `test/cli-flags-test.mjs` only. Everything here
was double-reviewed (fable + sol@pi-link, 2026-07-13) under the owner's strict
minimalism lens; value ranking and case selection were unanimous.

## Provenance

- **PLAN-cli-hardening.md** (retired): #4 → Task 1; #3 → Task 3 (demoted to
  optional, minimal shape); #2 displayPath separator → **dropped** (cosmetic,
  one Windows-only column; D1 dissolves with it).
- **PLAN-review-followups.md** (retired): T1–T3 shipped (`00f155e`, `a9cd9e8`,
  `8e461d7`; reviewed, gates green); T4 dissolved as all-skip; T5 → Task 2,
  shrunk from 12 cases + 2 harness prerequisites to 4 cases + 0 harness
  changes (see Task 2 rationale).

## Settled decisions (carried over, do not re-open)

- **Tombstone for removed subcommands** (was D3a): bare `list` / `resolve` at
  the name position → hard error pointing at `--list`/`--resolve`, exit 1.
  Prevents the silent-session-named-"list" trap at the cost of ~4 lines.
  (Sol amendment: the tombstone *may* be revisited later; it is not "forever".)
- **Remove `rejectRenamedFlag` entirely** (was D4): `--all`/`-a` have been hard
  errors since 0.1.12; after removal they follow ordinary rules — unknown
  before a name, forwarded to pi after (un-shadows pi's flag namespace).
- **Task 2 case selection** (was T5): H2/H5/H7/H10 are the irreducible core
  guarding the worst failure mode (silently resolving the wrong session).
  H1 is subsumed by H2's success assertion (sol). H10 stays because existing
  G-cases only pin the *new-session* spawn path, not resume (sol, overruling
  fable's drop). H11's env-override and per-case isolation machinery are
  unnecessary once fixtures use unique names — both former harness
  prerequisites existed only to serve the full 12-case suite.
- **If Task 3 happens** (was D2, minimized per sol): bare semver to stdout,
  exit 0; **no `-V` alias**, no version line in help; exclusivity mirrors
  `--help` (cannot combine with modes or a session name; accepts no
  arguments); never forwarded to pi.
- **Conventions:** inline temp-dir fixtures, no checked-in fixture files, no
  mtime-ordering assertions, no version bump / CHANGELOG edits in this plan.

---

## Task 1 — Remove 0.1.12 deprecation shims (behavior change; owner-requested)

**Where:** `bin/pi-link.mjs` — header comment (~L12–13), `rejectRenamedFlag`
(~L249), `printDeprecationWarning` (~L302), parser phase docs, `state.deprecated`,
Phase 1 call site, Phase 4 subcommand detection, Phase 5 resolve-ordering
leniency, dispatch-time warning. Plus README's legacy-forms note (~L223) and
tests B8–B11 / E34. (Line refs drifted +6 after the T3 helper landed at the
top of the file — re-locate by symbol, not line.)

**Problem:** the 0.1.12 deprecations promised removal after one release; we're
four releases on. The compat machinery is the majority of the parser's
special-casing, and the always-on `--all`/`-a` shim blocks those flags from
ever reaching pi.

**Fix:**

- Delete `printDeprecationWarning`, `state.deprecated`, the Phase 4 detection
  block, the Phase 5 leniency clause, and the dispatch-time warning.
- Tombstone at the name-binding position (Phase 6):

  ```js
  if (token === "list" || token === "resolve") {
    fail(`'pi-link ${token}' was removed. Use 'pi-link --${token}'.`);
  }
  ```

- Delete `rejectRenamedFlag` and its Phase 1 call.
- README: drop the legacy-forms paragraph.
- Tests: rewrite B8–B11 — `list` → exit 1 "was removed"; `resolve nope` →
  exit 1 "was removed"; rewrite `E34: --all (renamed)` → exit 1 "Unknown
  argument"; **add** `foo -a` → passthrough-to-pi (expectSpawn) to pin the
  un-shadowing.

**Risk:** moderate-low — deliberate breaks on warned paths only; parser gets
simpler (net-negative diff). Pin the new `-a`-after-name passthrough carefully.
**Verify:** full suite green with rewritten B-section; manual `pi-link list`
shows the tombstone.

---

## Task 2 — Resolution-semantics test core (test-only; after Task 1)

**Where:** `test/cli-flags-test.mjs`, new section H. Subject under test:
`getSessionMeta`, `findSessionsByName`, `runResolve`, launcher resume path.

**Problem:** the suite exhaustively covers the flag parser but not the CLI's
actual purpose — mapping a name to the right session file. The worst failure
mode (silently resolving the *wrong* session) has no regression guard.

**Harness:** no changes. One fixture helper (~10 lines):
`writeSession(relPath, entries)` emitting JSONL lines from plain objects:
`{type:"session", cwd, id}`, `{type:"session_info", name}`,
`{type:"custom", customType:"link-name", data:{name}}`, `{type:"message"}`.
Default layout note: `scanSessions` walks every immediate subdirectory of
`<agentDir>/sessions/`, so fixtures can use any subdir name. Local-match
fixtures must set the session entry's `cwd` to the harness spawn cwd
(`stubDir`); other-cwd fixtures use any different path.

**Isolation by unique names** (not per-case teardown): every scenario uses
fixture names no other case looks up (`rename-old`/`rename-new`, `elsewhere`,
`dupe`, `resume-existing`). Retained cases do exact-name lookups and no
`--list`, so shared suite-level fixtures are safe and filtered single-case
runs stay deterministic.

**Cases (section H):**

| # | Case | Asserts |
|---|------|---------|
| H2 | Renamed session (`link-name: rename-old` then `rename-new`) → `--resolve rename-new` / `--resolve rename-old` | new: exit 0 + fixture path on stdout (doubles as the resolve-success case); old: exit 2 (last-wins; historical names are not aliases) |
| H5 | Session named `elsewhere` with non-local cwd → `--resolve elsewhere` / `--resolve elsewhere -g` | local: exit 2 + "match(es) in other cwds — try --global" hint; `-g`: exit 0 |
| H7 | Two local sessions both named `dupe` → `--resolve dupe` | exit 1, "Multiple sessions named" (must fail, never pick arbitrarily) |
| H10 | Launcher resume: `pi-link resume-existing` with one local fixture (expectSpawn) | spawned argv is exactly `--session <fixture path> --link`; `PI_LINK_NAME=resume-existing` (pin exact argv form when writing) |

**Risk:** none to shipped code.
**Verify:** full suite green (~44); spot-check one inversion (e.g. flip
last-wins in a scratch copy → H2 must fail); one filtered run
(`node test/cli-flags-test.mjs H7`) passes standalone.

---

## Task 3 (optional) — minimal `--version` (blocked on owner go/no-go)

**Where:** `bin/pi-link.mjs` — helper near `printHelp`; flag recognition
alongside `--help`/`-h`; one usage line in help.

**Fix (only if owner reconfirms the 2026-06-09 request):**

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

Register `--version` as an exclusive mode mirroring `--help` semantics
(cannot-combine per D29 precedent; no-arguments per E31 precedent). Stdout,
exit 0. No alias, no help-banner version.

**Tests (section I):** `--version` → exit 0, stdout `/^\d+\.\d+\.\d+/`, stderr
empty; `--version foo` → exit 1 "does not accept arguments"; `foo --version` →
exit 1 "cannot combine"; `--list --version` → exit 1 "cannot combine".

**Risk:** low.
**Verify:** section I green; `E33: --unknown` still rejects.

---

## Dropped (recorded so it isn't re-proposed)

- **displayPath separator consistency** (hardening #2 / D1): cosmetic, one
  Windows-only column in `--list -g`. Unanimous skip under minimalism.
- **T5 cases H1, H3, H4, H6, H8, H9, H11, H12** and both harness
  prerequisites: cut in the fable+sol value pass. H8 (malformed-line
  tolerance) is real behavior but low-risk — the parse loop's try/catch is
  obvious by inspection; revisit only if that loop is ever restructured.
- **T4a/T4b/T4c** polish items: all-skip, T4 dissolved.

## Explicitly out of scope

- `index.ts` (untouched by this plan; review follow-ups shipped separately).
- New CLI capabilities beyond `--version`.
- Version bump / CHANGELOG (by hand at release time, per convention).

## Sequencing

1. **Task 1** — settles the parser's final shape (rewrites B/E cases).
2. **Task 2** — adds section H against that stable shape. No collision with
   Task 1 (separate test sections) but serialized on purpose.
3. **Task 3** — anytime after Task 1, if greenlit.

**Gate after each task:**

```
node --check bin/pi-link.mjs
node test/cli-flags-test.mjs
```
