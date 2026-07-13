# PLAN — Review follow-ups (2026-07 pass)

> **Status:** Draft — for discussion, not yet executable
> **Last aligned:** 2026-07-13
> **Build from this?** Not yet — discuss T4 sub-decisions first; T1–T3 and T5 carry recommendations.
> **Open decisions:** T4a startHub comment (rec: add) · T4b welcome-loop tightening (rec: skip) · T4c link_list records-then-render (rec: skip).
> **Gate:** `node test/cli-flags-test.mjs` (40/40 at plan time) + esbuild bundle check of `index.ts`. T5 extends the suite (~12 new cases).
> **Summary:** five tasks from the fresh full-codebase review @ `1a8c495` — T1 typeof guard on saved link-name (only correctness item), T2 remove redundant `.has()` guards (net −2 lines), T3 CLI `normalizeName` helper (dedupe ×4), T4 optional polish (three sub-decisions), T5 fixture tests for `--list`/`--resolve`/launcher resolution (**moved here from PLAN-cli-hardening #1** — that plan now covers shipped-code changes only).

Fresh review pass over `index.ts` (1,927), `bin/pi-link.mjs` (599), and both
test files. Verdict: strong shape; prior rulings respected and not re-opened
(six role-split maps, `hubClientByName` linear scan, unabstracted RPC pending
machinery, closure-state single file, triple row-rendering). What remains is
one small correctness hole, two simplifications, optional polish, and the
known test-coverage gap.

Gates green at plan time: 40/40 + clean bundle (47.3kb).

## Decisions

- **Recommended, no controversy expected:** T1 (correctness), T2 and T3
  (net-negative line count, zero behavior change), T5 (test-only; its
  conventions were already decided in PLAN-cli-hardening: inline temp-dir
  fixtures, no mtime-ordering assertions).
- **T4a (open) — `startHub` post-listen error swallow** (`index.ts:1002`).
  The `error` handler exists for pre-listen EADDRINUSE (→ resolve(false) →
  client attempt). Post-listen server errors are silently ignored: `resolve`
  is a no-op and the hub keeps its role. Realistically unreachable on a
  localhost listener. **Recommendation: one-line comment** ("pre-listen only;
  post-listen errors surface per-client socket"), no code change.
- **T4b (open) — welcome-case triple loop** (`index.ts:617–631`). Three
  `if (msg.x) { for … set }` blocks could each collapse to
  `for (const [k, v] of Object.entries(msg.x ?? {}))`. Saves ~6 lines; the
  current form is more explicit about optional wire fields.
  **Recommendation: skip** — churn without a readability win.
- **T4c (open) — `link_list` side-effectful `.map()`** (`index.ts:1683`).
  Populating `statuses`/`cwds`/`contexts` inside the line-building map is
  mildly non-idiomatic; a records-then-render split would be cleaner but
  doubles the iteration or adds an intermediate shape.
  **Recommendation: skip** — not worth churn alone; revisit only if this
  block is touched for another reason.

---

## T1 — typeof guard on saved link-name fallback (correctness)

**Where:** `index.ts:1229–1233` (`session_start`, no-flag fallback branch).

**Problem:** the two branches of `session_start` read the **same** `link-name`
custom entry with different rigor. The flag branch (1216–1222) casts
`{ name?: unknown }` and checks `typeof latest?.name === "string"` before use.
The fallback branch casts `{ name?: string }` and passes `saved?.name`
straight into `normalizeName()`, which only tolerates
`string | undefined | null` — a malformed entry (`{name: 42}`) throws
`TypeError` inside the handler. The CLI's third reader of this entry type
(`getSessionMeta`, bin:94) also typeof-checks; the fallback branch is the odd
one out of three.

**Fix (~2 lines):** mirror the flag branch —

```ts
const saved = latestCustomData("link-name") as { name?: unknown } | undefined;
const savedName = normalizeName(
  typeof saved?.name === "string" ? saved.name : undefined,
);
```

**Risk:** none — behavior identical for well-formed entries; malformed entries
now fall through to session-name/random instead of throwing.
**Verify:** bundle check; grep confirms no remaining `{ name?: string }` cast.

---

## T2 — remove redundant `.has()` guards (simplicity)

**Where:** `index.ts:1515` (link_compact), `index.ts:1624` (link_prompt) —
the not-delivered cleanup path in each tool's promise executor.

**Problem:**

```ts
if (!delivered && pendingCompactResponses.has(requestId)) {
  const pending = cleanupPendingCompact(requestId);
  if (pending) { ... }
```

`cleanupPending`/`cleanupPendingCompact` already return `null` when the entry
is absent, and the `if (pending)` guard is already there. The `.has()`
pre-check is dead weight; every other caller (timeout callbacks, abort
listeners, `terminal_left`, `disconnect`) correctly relies on
cleanup-returns-null alone.

**Fix:** drop the `&& pending….has(requestId)` clause in both places. This is
a simplification within the pending machinery's existing shape, not an
abstraction of it — the no-abstraction ruling is untouched.

**Risk:** none — identical semantics (has+delete is not atomic-sensitive here;
single-threaded event loop, and the inner guard stays).
**Verify:** bundle check; both tools still resolve `not_delivered` when
disconnected mid-call (covered by existing behavior, spot-check by reading).

---

## T3 — local `normalizeName` helper in the CLI (readability)

**Where:** `bin/pi-link.mjs:91, 95, 469, 476` — four inline
`.trim().replace(/\s+/g, " ")` occurrences.

**Problem:** name canonicalization is a correctness invariant — extension,
CLI matcher, and CLI validator must agree or `pi-link <name>` resolves
wrongly. Today that contract is a regex repeated four times. The extension
has `normalizeName()` for exactly this; the `.mjs`/`.ts` boundary prevents
sharing, but the concept should be single-sourced per file and greppable.

**Fix (~4 lines):** add near the top of the CLI —

```js
// Canonicalize a link/session name: trim + collapse internal whitespace.
// Must match the extension's normalizeName (index.ts).
function normalizeName(s) {
  return s.trim().replace(/\s+/g, " ");
}
```

and replace the four call sites. (Sites 91/95 feed `|| undefined` / truthiness
checks — keep those at the call site; the helper stays string→string.)

**Risk:** none — mechanical extraction, same expression.
**Verify:** `node --check bin/pi-link.mjs`; full suite green (G41 pins
whitespace normalization end-to-end).

---

## T4 — optional polish (blocked on decisions above)

- **T4a** (rec: do): comment on `startHub`'s `server.on("error")` explaining
  its pre-listen-only role. One line, zero behavior.
- **T4b** (rec: skip): welcome-case loop tightening.
- **T4c** (rec: skip): `link_list` records-then-render split.

**Risk:** T4a none; T4b/T4c pure churn risk.
**Verify:** bundle check.

---

## T5 — Fixture-based coverage for `--list` / `--resolve` / launcher resolution (test-only)

_Moved verbatim from PLAN-cli-hardening #1 (2026-07-13); that plan now
references this one. Its conventions carry over: fixtures generated inline by
the test (temp dirs, like the stub-`pi` shim); no checked-in fixture files;
no mtime-ordering assertions._

**Where:** `test/cli-flags-test.mjs` (new section H). Subject under test:
`getSessionMeta` (~L76), `scanSessions` (~L158), `findSessionsByName` (~L194),
`listSessions` (~L206), `runResolve` (~L542), and the launcher's
resolve-or-create path (~L562).

**Problem:** the suite covers only the empty-dir `--list` and missing-name
`--resolve` paths. The CLI's actual purpose — mapping a name to the right
session file — is untested: last-wins `link-name` precedence, `session_info`
fallback, whitespace normalization, malformed-line tolerance, cwd scoping,
duplicate handling, and the resume-vs-create launch decision. The worst CLI
failure mode (silently resolving to the _wrong_ session) has no regression
guard.

**Mechanics (verified against the code):**

- Default layout is `<agentDir>/sessions/<subdir>/*.jsonl` — `scanSessions`
  walks **every** subdirectory regardless of name, so fixtures can use any
  subdir name; no cwd-encoding knowledge needed. The harness already isolates
  `agentDir` per run.
- Custom layout (flat `<dir>/*.jsonl`) is selected by
  `PI_CODING_AGENT_SESSION_DIR` — settable per-case via `run()`'s env.
- Local/global scoping compares the **`session` entry's `cwd` field** against
  `process.cwd()` (normalized, case-insensitive on Windows) — not the
  directory encoding. Local-match fixtures must set `cwd` to the harness's
  spawn cwd (`stubDir`); other-cwd fixtures use any different path.
- Fixture helper, ~10 lines: `writeSession(relPath, entries)` emitting JSONL
  lines from plain objects: `{type:"session", cwd, id}`,
  `{type:"session_info", name}`,
  `{type:"custom", customType:"link-name", data:{name}}`, `{type:"message"}`.

**Cases (section H):**

| #              | Case                                                                                     | Asserts                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1             | One local session, link-name `alpha` → `--resolve alpha`                                 | exit 0, stdout contains fixture path                                                                                                                  |
| H2             | Renamed session (`link-name: alpha` then `beta`) → `--resolve beta` / `--resolve alpha`  | beta: exit 0; alpha: exit 2 (last-wins; historical names are not aliases)                                                                             |
| H3             | `session_info` name only, no link-name → `--resolve <name>` and `--list`                 | resolve: exit 0 (attach case works); list: row absent (`hasLinkName` filter)                                                                          |
| H4             | `--list` with one linked session (3 message entries, known id)                           | exit 0; row shows name, 8-char id prefix, message count `3`                                                                                           |
| H5             | Session in another cwd → `--resolve <name>` / `--resolve <name> -g`                      | local: exit 2 + "match(es) in other cwds — try --global" hint; `-g`: exit 0                                                                           |
| H6             | Same fixture → `--list` vs `--list -g`                                                   | local list omits the row; `-g` includes it                                                                                                            |
| H7             | Two local sessions, same name → `--resolve <name>`                                       | exit 1, "Multiple sessions named"                                                                                                                     |
| H8             | Valid entries + malformed trailing line (partial JSON)                                   | `--resolve` still exits 0 (active-session tolerance)                                                                                                  |
| H9             | `link-name` data `"  foo   bar "` → `--resolve "foo bar"`                                | exit 0 (trim + whitespace collapse)                                                                                                                   |
| H10            | Launcher resume: `pi-link alpha` with existing local session (expectSpawn)               | spawned argv includes `--session <fixture path>` + `--link`; `PI_LINK_NAME=alpha` (exact argv form per implementation — pin it when writing the case) |
| H11            | Flat custom layout via `PI_CODING_AGENT_SESSION_DIR` → `--resolve`                       | exit 0 (isCustom branch of `scanSessions`)                                                                                                            |
| H12 (optional) | link-name entry with empty/invalid name only                                             | `--list` shows `(unnamed)`                                                                                                                            |

**Risk:** none to shipped code (test-only). Flakiness controlled by the
no-mtime-assertions rule.
**Verify:** full suite green (40 existing + ~12 new); each new case fails
meaningfully when its target logic is deliberately broken (spot-check one,
e.g. invert last-wins).

---

## Already tracked elsewhere (not duplicated here)

- `rejectRenamedFlag` removal and `list`/`resolve` tombstones → PLAN-cli-hardening D3/D4 (#4).
- `displayPath` separator, `--version` flag → PLAN-cli-hardening #2/#3.
- `compactRunning` blind spot for local/owner compactions → REPORT-compact-race.md (root cause is pi-core reentrancy).

## Explicitly out of scope

- Re-litigating prior rulings (pending-machinery abstraction, role-split maps,
  linear scans, single-file architecture).
- Version bump / CHANGELOG edits (by hand, per convention).
- New capabilities of any kind.

## Sequencing

1. **Pass A — T1 + T2 + T4a** (one `index.ts` pass). Gate: bundle check +
   suite green.
2. **Pass B — T3** (CLI-only). Gate: `node --check` + suite green.
3. **Pass C — T5** (test-only; independent of A/B, last so the new H-section
   lands against a stable CLI). Gate: full suite green (~52), spot-check one
   inverted case.

T4b/T4c only if their decisions flip to "do" — they'd join Pass A.
