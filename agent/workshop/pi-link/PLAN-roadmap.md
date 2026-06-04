# PLAN — pi-link roadmap

Sequencing plan for the next several pi-link work items. Captures the decision (made with `gpt@pi-link` + `docs@pi-link` input) that **context usage visibility is the next ship**, why it leads, and what follows it. This is a coordination/ordering document — each line item has or will have its own detailed plan file.

(Version numbers and CHANGELOG headers are handled by hand outside these plans; this roadmap stays version-agnostic.)

## Context

The README reshape (rev 3, compressed) landed. Four shipped plans were archived. A comparison against Claude Code's "Dynamic Workflows" feature confirmed that **context visibility is the one externally-validated feature** worth pulling into pi-link — every other workflow concept is an artifact of script-orchestration and doesn't fit pi-link's peer-LLM coordination model.

Key finding from that analysis: context visibility is substrate-independent. It answers "how much room does this agent have left?" — a question true of any multi-agent system regardless of orchestration model. Two independent designs (Claude Code's progress view, pi-link's own context-usage design) converged on it, which marks it as fundamental rather than incidental.

## The sequence

| Step | Work item                                           | Plan file                         | Est.    | Status             |
| ---- | --------------------------------------------------- | --------------------------------- | ------- | ------------------ |
| 1    | Prep `PLAN-context-usage.md` for execution          | (folded into that file)           | ~15 min | ✓ done             |
| 2    | Execute context usage                               | (shipped)                         | ~4h     | ✓ done + validated |
| 3    | Coordination recipes documentation                  | README `### Coordination recipes` | ~1–2h   | ✓ done             |
| 4    | Re-decide: orchestration vs README Walkthrough seam | `PLAN-orchestration.md` / new     | TBD     | **next action**    |

## Steps 1 & 2 — context usage (done)

Shipped and validated live. `index.ts` broadcasts a per-terminal `context` field — a snapshot on register/welcome/terminal_joined, live updates riding along on `status_update` (with explicit `null` to clear). The hub stores + fans it out, clients absorb it, and `session_compact` force-pushes the post-compaction drop. `/link` and `link_list` render `45K/272K (26%)`, or `?/272K` when tokens are momentarily `null`. One advisory line added to SKILL.md.

opus implemented; gpt reviewed twice — correctness, then a simplicity pass that cut the dead `sameContext` / `lastPushedContext` dedup and an unnecessary conditional-spread. Validated across the live link: per-peer attribution, mixed context windows (`272K` and `1.0M` side by side), incremental growth, and the transient `?/window` post-compaction state all confirmed.

**What it unblocks:** the orchestration line — `PLAN-orchestration.md` (compact/setModel/setThinking) needs an orchestrator to _see_ worker context before acting on it. That input now exists.

## Step 3 — Coordination recipes documentation (done)

Landed as a 6-line `### Coordination recipes` subsection at the end of README's `## LLM Tools`. Two recipes, not three:

1. **Adversarial review** — produce/edit on one terminal, `link_prompt` another to critique (blocking round-trip = independent review in the same turn).
2. **Independent cross-check** — same question to two terminals without sharing answers, then reconcile (separate contexts avoid anchoring).

**Decisions made (with gpt):** placement is **README, not `examples/`** (`examples/` isn't in the npm `files` allowlist, so it'd be invisible to npm users) and **not SKILL** (agents already have the mechanics; avoids the cookbook). Fan-out is included as a value line (the headline capability); SKILL's "Parallel batch" keeps the *mechanics* (busy rule, batching, wait-for-all) — README states the shape, SKILL states how to run it safely. SKILL left untouched.

**Doc-split principle settled here:** README = why/when/value for humans; SKILL = how / how-not-to-break-it for agents. No 1:1 mirroring; the same capability can appear in both at different depths.

## Step 4 — Re-decide (next action)

Two candidates surface once context usage ships:

- **`PLAN-orchestration.md`** — now unblocked. Three remote tools (`link_compact`, `link_set_model`, `link_set_thinking`) for an orchestrator to manage workers. Bigger effort; the ambitious direction.
- **README Walkthrough seam** — the rev-3 reshape deferred the Walkthrough rewrite. docs flagged a seam: Quick Start now promotes `pi-link <name>`, but the Walkthrough still opens with `pi --link` + rename. A Walkthrough rewrite (deferred Phase 4 of the README reshape) would close it and could fold in the coordination recipes as concrete examples.

Decide based on appetite at that point: feature depth (orchestration) vs doc polish (Walkthrough). They may even combine — the recipes doc, the Walkthrough rewrite, and orchestration examples share material.

## Not in this sequence (parked, with reasons)

- **`PLAN-monitor.md`** — orthogonal supervision feature, no dependency pressure. Pick up when there's specific demand.
- **`REPORT-sendMessage-race.md`** — real bug, but upstream (pi-agent-core, not pi-link). File as an issue against the Pi repo; not a pi-link release item. We reproduced it in the wrapper test (2 of 3 callbacks arrived).
- **`REQUEST-github-issue.md`** / **`REQUEST-pi-issue-bin-discovery.md`** — upstream issue drafts. Administrative file-and-forget, not work plans. File when convenient.

## What we explicitly decided NOT to build

From the Claude Code workflows analysis — these are artifacts of script-orchestration and wrong for pi-link's peer-coordination model:

- Script-as-orchestrator (pi-link's orchestrator is an LLM, not code)
- Save-as-`/command` (no run/script abstraction)
- Cached agent results / resumability (peers are stateful, not one-shot)
- Concurrency caps (human-scale, ~handful of terminals)
- Approval-before-launch UX (each terminal already has a user)
- `ultracode`-style keyword/effort trigger (no global-mode concept)

## Immediate next action

Step 4 — re-decide based on appetite: orchestration (`PLAN-orchestration.md`, now unblocked) vs the README Walkthrough seam rewrite. They may share material.
