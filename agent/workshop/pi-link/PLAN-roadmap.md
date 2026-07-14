# PLAN — pi-link roadmap (triage index)

> **Status:** Index / source of truth
> **Last aligned:** 2026-07-14

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
- **Coordination recipes** (README `### Coordination recipes`) — adversarial
  review + independent cross-check, stated as value; SKILL keeps the mechanics.
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

## Open work (priority-ranked)

| # | Work item | File | Status | Readiness | Next action |
|---|-----------|------|--------|-----------|-------------|
| P0 | Compact-race guard (Defect 2) | `REPORT-compact-race.md` | Report → needs plan | Not executable until event surface verified | Verify `session_before_compact` / `session_compact` fire on manual/remote/auto/error paths; then write `PLAN-compact-race-guard.md` |
| P1 | Link status endpoint + `--status` | `PLAN-cli-status.md` | Executable | Ready (owner-approved, no open decisions; parser cleaned by CLI closeout, no remaining blocker) | Implement; re-check its parser line references against the post-closeout 5-phase parser before building |

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

## Deferred doc work

- **README Walkthrough seam** — Quick Start promotes `pi-link <name>`, but the
  Walkthrough still opens with `pi --link` + rename (deferred Phase 4 of the
  rev-3 README reshape). A rewrite would close the seam and could fold in the
  coordination recipes as concrete examples. No plan file; tracked here.
