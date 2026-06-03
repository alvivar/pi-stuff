# PLAN — pi-link roadmap

Sequencing plan for the next several pi-link work items. Captures the decision (made with `gpt@pi-link` + `docs@pi-link` input) that **context usage visibility is the next ship**, why it leads, and what follows it. This is a coordination/ordering document — each line item has or will have its own detailed plan file.

(Version numbers and CHANGELOG headers are handled by hand outside these plans; this roadmap stays version-agnostic.)

## Context

The README reshape (rev 3, compressed) landed. Four shipped plans were archived. A comparison against Claude Code's "Dynamic Workflows" feature confirmed that **context visibility is the one externally-validated feature** worth pulling into pi-link — every other workflow concept is an artifact of script-orchestration and doesn't fit pi-link's peer-LLM coordination model.

Key finding from that analysis: context visibility is substrate-independent. It answers "how much room does this agent have left?" — a question true of any multi-agent system regardless of orchestration model. Two independent designs (Claude Code's progress view, pi-link's `PLAN-context-usage.md`) converged on it, which marks it as fundamental rather than incidental.

## The sequence

| Step | Work item                                           | Plan file                     | Est.    | Status          |
| ---- | --------------------------------------------------- | ----------------------------- | ------- | --------------- |
| 1    | Prep `PLAN-context-usage.md` for execution          | this file → that file         | ~15 min | **next action** |
| 2    | Execute context usage                               | `PLAN-context-usage.md`       | ~4h     | queued          |
| 3    | Coordination recipes documentation                  | new (small)                   | ~1–2h   | follow-on       |
| 4    | Re-decide: orchestration vs README Walkthrough seam | `PLAN-orchestration.md` / new | TBD     | after step 3    |

## Step 1 — Prep `PLAN-context-usage.md` (next action)

`PLAN-context-usage.md` was drafted earlier but never executed. Before it's execution-ready, apply:

### Cleanup (stale content)

- **Delete the `peerDependenciesMeta` section entirely.** Peer deps were removed from `package.json` during the namespace migration; the whole section is obsolete.
- The CHANGELOG draft inside that plan can be left as-is or trimmed — version/CHANGELOG details are finalized by hand at ship time, not from the plan.

### Substantive design fix (caught by gpt review)

**Context-clearing semantics.** The plan's current handler only _stores_ `msg.context` when present (`if (msg.context !== undefined)`); it never _clears_. Failure mode: a terminal reports context, later `getContextUsage()` returns undefined (model deselected, edge state), and peers show the stale value forever — same bug class as a sticky cwd or status after a terminal stops reporting.

Fix to fold into the plan:

- Wire format uses `context?: ContextSnapshot | null` — explicit `null` means "I no longer have context."
- Hub and client handlers **delete** the stored entry when `null` arrives (not just skip the update).
- `captureContext()` treats `contextWindow <= 0` as missing → returns undefined.
- Guard against truthiness bugs: `tokens: null` is **valid** post-compaction data (display `?/200K`), not "missing." Only `context === null` or absent means clear.

### API confirmation (already verified against Pi 0.75)

- `ContextUsage` interface, `ctx.getContextUsage()`, `pi.on("session_compact", ...)` all present.
- `index.ts` is ~1538 lines; plan's line refs are stale but structural anchors (`pushStatus`, `hubHandleClient`, `link_list` tool) are findable.

## Step 2 — Execute context usage

Run `PLAN-context-usage.md` once Step 1 lands. ~4h pass:

- Wire format extension (flat `context` field on `StatusUpdateMsg`, plus register/welcome/terminal_joined snapshots)
- Hub stores + forwards context; client absorbs it
- `session_compact` event triggers a force-push (tokens just dropped)
- Display: `45K/200K (23%)` segment in `/link`; nested `contexts` in `link_list` result
- One-line SKILL.md note: `/link` and `link_list` may show context; advisory signal when choosing workers
- Smoke test cases 1–6 (priority), 7–10 (nice-to-have)

Roles: `docs@pi-link` executes, `gpt@pi-link` reviews. Validation handoff specific (accuracy + voice lenses).

**Why this leads:** it's the validated pick, 90% planned, right-sized, and it **unblocks the orchestration line** — `PLAN-orchestration.md` (compact/setModel/setThinking) needs an orchestrator to _see_ worker context before it can act on it. Building the actions before the inputs would be backwards.

## Step 3 — Coordination recipes documentation

A small follow-on. Not new machinery — names patterns pi-link can already do with existing primitives (`link_prompt`, `link_send`, fan-out). Inspired by Claude Code's quality-pattern framing (`/deep-research`, adversarial review), but expressed as documentation, not a feature.

Three concrete recipes:

1. **Adversarial review** — builder terminal produces work → reviewer terminal critiques → builder responds. Tightens output past a single pass.
2. **Multi-angle drafting** — coordinator `link_prompt`s the same task to 3 terminals from different angles, then synthesizes.
3. **Source cross-check** — two researcher terminals verify a claim independently; a third resolves conflicts.

**Placement decision (open):** README new section vs `examples/RECIPES.md`. Leaning `examples/` to keep README front-door lean (consistent with the reshape's Goal 1). **Not in SKILL.md** — that would turn the skill into a prompt-engineering cookbook, against its established scope.

**Optional SKILL.md addition:** at most one line naming the shapes as pointers ("Useful coordination shapes: adversarial review, parallel drafts, source cross-check") with no explanation. Decide during execution; default is to leave SKILL untouched.

## Step 4 — Re-decide after step 3

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

Apply Step 1 edits to `PLAN-context-usage.md`. Then it's execution-ready for `docs@pi-link`.
