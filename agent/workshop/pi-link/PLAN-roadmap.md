# PLAN — pi-link roadmap (triage index)

> **Status:** Index / source of truth
> **Last aligned:** 2026-09-03 (post-0.4.0)

Single entry point for pi-link's plan backlog. Lists what shipped, what's open
(priority-ranked), what's stale, and what's parked — so a future agent or the
owner can retake work without mistaking a stale plan for a spec. Each open line
item has its own plan file; this doc only sequences and tags them.

Every backlog plan/report file carries a status header (Status / Last aligned /
Build from this? / Summary) — read it before acting. **Version numbers and CHANGELOG
headers are hand-managed by the owner outside these plans; nothing here bumps or
commits versions.**

## Shipped / closed

- **Context-usage visibility** — per-terminal `context` field on the
  wire; `/link` and `link_list` render `45K/272K (17%)`. Validated live. (No
  standalone CHANGELOG entry — shipped folded into the 0.1.16 cycle; treat as
  version-agnostic.)
- **Coordination recipes** (README) — shipped 2026-07, then **deleted** by the
  unified-delivery documentation pass (`b5825b7`): they prescribed conduct, which
  the owner's documentation principle rules out. Do not re-propose.
- **Review hardening** (0.1.17, atop an earlier refinements pass) —
  disconnected-result error contract, pre-abort fail-fast, hub duplicate-register
  guard, `link_send` self-target guard. Maintenance; all live-verified.
- **`link_compact`** (0.1.16) — shipped as an **await-completion** tool (blocks
  until the target reports done, ~180s ceiling; busy targets decline; self /
  not-found rejected). Note: this is *not* the fire-and-forget, consent-gated
  design in `PLAN-orchestration.md` — that framing was never built.
- **Review follow-ups** (2026-07-13) — typeof guard on saved link-name
  (`00f155e`), redundant `.has()` cleanup (`a9cd9e8`), CLI `normalizeName`
  helper (`8e461d7`). Double-reviewed (fable + sol).
- **CLI closeout** (2026-07-14) — 0.1.12 deprecation shims removed +
  `list`/`resolve` tombstone + `-a`/`--all` un-shadowed (`186365d`);
  resolution-semantics test core H2/H5/H7/H10 (`0db1e61`); minimal `--version`
  (`f73d563`). Suite 49/49. Plan file retired (was `PLAN-cli-closeout.md`,
  archived in git history at `4017d97`). Explicitly dropped along the way:
  displayPath separator cosmetics, the eight cut fixture cases, T4 polish
  items — do not re-propose without new evidence.

- **Async-only agent messaging** (2026-07-17) — `link_send` is the sole
  agent-to-agent messaging tool; omitting `triggerTurn` now defaults to **true**;
  explicit `false` still delivers immediate non-waking steer; `link_prompt`
  removed end to end with no tombstones (`0338ee5`), plus a residue cleanup pass
  (`f7b4ff9`). Net −527 lines. Suite 49/49. Triple-reviewed (plan: fable + opus +
  sol; code: opus for correctness, fable for simplicity). Live-validated on an
  11-terminal mesh: default-true wake, raw mid-turn steer without aborting an
  in-flight tool call, queued delivery at the next turn boundary, broadcast
  wake-all vs wake-none, non-waking `/link-broadcast`, and compact idle-succeeds /
  busy-declines. Plan file retired (was `PLAN-link-send-only.md`, archived in git
  history at `0338ee5`).
  **Release handoff delivered:** the 0.3.0 changelog carries “Upgrade and restart
  every linked terminal together.” (Observed live before the fix: an un-restarted
  peer keeps the old extension — two terminals lost `link_prompt` mid-session when
  the reload landed under them.)
  Explicitly dropped along the way — do not re-propose without new evidence:
  compatibility tombstones / dormant wire handlers, a permanent README migration
  section, a standalone extension test harness, and an asymmetric broadcast
  default (rejected because it would reintroduce the unwoken-receiver bug on the
  fan-out path).

- **Unified delivery** (2026-07-18) — `link_send({to, message})` lost its delivery-mode
  parameter; every message passes `triggerTurn: true` internally and Pi decides from
  the receiver's state. Removed the plain-append path, the idle gate
  (`ctx.isIdle()` deferral, `IDLE_RETRY_MS`, the `agent_end` kick), `/link-broadcast`,
  the `to:"*"` path and the hub's wildcard arm (`ed713c5`, −78). Delivery is held
  while a **manual-reason** compaction runs, released by three transitions with an
  explicit deadline and no polling (`e4e2c97`, +14 executable). Documentation rewritten
  as mechanics only (`b5825b7`, −23). Follow-ups from fable's value review: the
  `agent_start` comment corrected (`366cd85`), `compacting` made visible in
  `link_list` (`cd6ef77`), the planning lesson folded into the plan schema
  (`93dfad9`). Compaction mechanics found while testing, documented (`a33c24c`,
  `ad24423`).
  Reviewed independently at every step — the run surfaced **22 defects, not one of
  which any static gate could catch**, including a liveness race that would have
  stranded the inbox mesh-wide, and the deleted Golden Rule reappearing in fresh
  words inside the very file that deleted it, past two clean greps.
  **All sixteen live gates passed** on the restarted mesh, including the cancelled
  compaction releasing at the 180s deadline and automatic compaction delivering
  through Pi's own queue. Plan and ledgers retired with this entry.
  **Release handoff delivered:** shipped as **0.3.0** (published to npm) with the
  upgrade-and-restart-together note in the changelog, which also records the
  observed mixed-version asymmetry (unattributed bare-text delivery to a 0.2.0
  receiver, no fault reported, both builds claiming the same version).

- **Link status endpoint + `pi-link --status`** (0.4.0, 2026-09-03) — the hub owns
  a `node:http` server and answers read-only `GET /status` on `127.0.0.1:9900`
  (hub first, clients sorted; `status`/`sinceSeconds` optional pair, absence =
  unknown, never a default; `context` always present, null = no snapshot; 404
  elsewhere). CLI `--status [--json]` with automation-grade exit codes: 0 valid,
  2 “No link hub running on :<port>.” (all timeouts, including stalled bodies),
  1 usage or “Link hub does not support /status …” (a 0.3.0 hub's hardwired 426
  lands here — verified against a live 0.3.0 hub). `wss.close()` never closes a
  provided HTTP server, so all three teardown sites close it explicitly, each
  singly observable in tests (mutation-proofed; a zombie :9900 breaking hub
  election machine-wide was the one real hazard). Election untouched (ws forwards
  `listening`/`error` from the provided server). Suite 195→286.
  Commits `8068231d`, `7d32908`, `ec2ca5a`, `b0a684d`, `04652c0` — the last from
  an independent post-pipeline philosophy review (fable: SHIP-QUALITY; two dead
  formatter guards deleted, single-use helper inlined; the dual absence encodings
  — `cwd` omitted vs `context` null — are frozen contract, recorded so nobody
  “cleans them up” later).
  One review dissent, owner-ratified: the CLI validates `status` as **non-empty
  string, deliberately not a frozen enum** — the vocabulary grew once already
  (`compacting`, in 0.3.0) and a strict enum would blank the whole fleet view
  intermittently on older CLIs when a future kind appears. Do not re-freeze
  without new evidence.
  Explicitly rejected along the way — do not re-propose: `probe:true` on register
  (fail-dirty against old hubs), LIVE/DEAD wording (connection ≠ process health),
  a CONNECTED column in `--list` without an end-to-end session id, `--watch`,
  auth/CORS, extension-side `PI_LINK_PORT`. Plan files retired (`PLAN-link-status.md`;
  superseded `PLAN-cli-status.md`; both archived in git history at `8068231d`).

- **Compact-race guard (former P0, Defect 2)** — closed at the extension level by
  `e4e2c97`. `flushInbox` holds while `localCompacting || compactRunning`, and
  `releaseInbox()` centralises the "drain only when no gate remains" invariant.
  **Still owed to Pi upstream, not to this repo:** `compact()` assigns
  `_compactionAbortController` *after* `await this.abort()` with no reentrancy guard,
  so overlapping compactions clobber the shared field. Evidence and reproduction in
  `REPORT-compact-race.md`; the owner files it. A second, weaker upstream ask
  surfaced during the gates: a failed or cancelled compaction is reported to the user
  but never to extensions, which is why the deadline has to exist at all.

## Open work (priority-ranked)

None — the backlog is empty. Next candidates live under Parked and in the
deferred `REPORT-*.md` files below; each carries its own status header.

## Stale / historical

- **`PLAN-orchestration.md`** — **do not build from this.** Its `link_compact`
  design (fire-and-forget, `/link-control` consent, `capabilities`, cooldown)
  was superseded by the simpler await-completion tool that actually shipped.
  Kept as a historical design record. Its only unshipped remnant —
  `link_set_model` / `link_set_thinking` — is parked (see below).

## Parked (with reasons)

- **Remote runtime control** (`link_set_model` / `link_set_thinking`) —
  speculative; a solution looking for a problem. Users already set model/thinking
  on the terminal that owns the task. Revive only with a concrete workflow
  (e.g. "escalate one worker to high-thinking for a sensitive pass"); if so,
  write a fresh `PLAN-runtime-control.md` with a `/link-control` consent gate
  (these mutate a peer's cost/quality — consent is warranted, unlike compact).
- **`PLAN-monitor.md`** — opt-in traffic-copy supervision mode. No demand;
  increases model usage/noise. Self-contained, ready if a use case appears.

## What we explicitly decided NOT to build

From the Claude Code "Dynamic Workflows" analysis — artifacts of
script-orchestration, wrong for pi-link's peer-LLM coordination model:

- Script-as-orchestrator (pi-link's orchestrator is an LLM, not code)
- Save-as-`/command` (no run/script abstraction)
- Cached agent results / resumability (peers are stateful, not one-shot)
- Concurrency caps (human-scale, ~handful of terminals)
- Approval-before-launch UX (each terminal already has a user)
- `ultracode`-style keyword/effort trigger (no global-mode concept)

## Deferred design work

- **Sender attribution on raw delivery** — **CLOSED by unified delivery.** The two
  unattributed paths were explicit-`false` sends and `/link-broadcast`; both were
  deleted in `ed713c5`. Every delivery now carries the batch header and a
  `From "name":` line per message, confirmed live including inside a batch of three.

- **Status is absent from `RegisterMsg`** — a terminal that reconnects mid-compaction
  reports nothing until its next `pushStatus()`. Pre-existing, affects every status
  kind equally rather than just `compacting`, and surfaced by the implementer during
  the `compacting`-status work rather than caused by it. Declared and deliberately
  not fixed there. No plan file; tracked here.

- **Hub routing failure is invisible to the sender** — a send can report success
  against a stale roster, the hub fails to route, and the failure surfaces only as a
  human-facing notification. Documented as a mechanic; no code. If revisited, the
  candidate direction is returning the hub's routing error to the sender as an
  ordinary attributed message through the unified path, with proof it cannot route to
  itself or loop — never receipts, correlation, or blocking RPC.

## Deferred reports (each self-contained; read its header before acting)

- `REPORT-compact-race.md` — upstream Pi reentrancy evidence (see the compact-race
  entry above); the owner files it.
- `REPORT-omp-tool-visibility.md` / `REPORT-omp-renderer-signature.md` — OMP
  (third-party Pi fork) integration issues; consultive analysis only, reproduce
  before writing any code.
- `REPORT-session-compact-failed.md` — opportunity deferred until compaction
  ownership is demonstrable upstream; a bare `setCompacting(false)` handler is
  explicitly ruled out without correlation.

## Deferred doc work

- **README Walkthrough seam** — Quick Start promotes `pi-link <name>`, but the
  Walkthrough still opens with `pi --link` + rename (deferred Phase 4 of the
  rev-3 README reshape). A rewrite would close the seam and could fold in the
  coordination recipes as concrete examples. No plan file; tracked here.
