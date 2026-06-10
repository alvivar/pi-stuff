# PLAN — SKILL.md accuracy touch-up (pi-link-coordination)

Review of `skills/pi-link-coordination/SKILL.md` (2026-06-09): structure,
altitude, and decision-shaped layout are right — **keep all of it as-is**.
Three accuracy findings remain, one of which is staleness we introduced
ourselves (the link_send self-target guard, commit `2f162dc`). Doc-only;
~4 lines of change total.

**Verified against:** index.ts implementation (line-level review) and the
live 12-pattern coordination test run (2026-06-09). Everything else in the
skill checked out: delivery-shape split, Golden Rule busy-bounce, status
vocabulary, `(you)` marker, dedup suffixes, one-prompt-per-target, mid-wait
disconnect → error, partial context reporting, compact busy-decline.

## Decisions

None open. Constraint: **no structural edits** — additions slot into existing
sections; the file's shape (selection rule → golden rule → tools →
constraints → anti-patterns → quick reference) is deliberately preserved.

---

## #1 — link_send self-target rejection (staleness, ours)

**Where:** `### link_send` section, first paragraph ("Fire-and-forget. Send to
one terminal or `to: \"*\"`…").

**Problem:** since commit `2f162dc` (review follow-up #5), `link_send` rejects
self-targets with `"Cannot send to yourself"` / `error: "self_target"`. The
skill documents self-rejection for `link_prompt` only. README was updated;
the skill was missed.

**Fix:** one clause in that paragraph, e.g.:

> Sending to yourself is rejected — use the link only to reach _other_
> terminals.

(Match the README's `### link_send` wording for consistency.)

**Verify:** live `link_send` to own name → error result; skill sentence
matches actual message.

---

## #2 — link_send delivery feedback (undersold capability)

**Where:** `### link_send` section (same paragraph or immediately after), and
it reinforces "Messages are ephemeral" in Operating Constraints.

**Problem:** the skill says offline messages aren't queued but never says the
sender _learns of the failure_ — a send to a missing/unknown name returns a
not-found error rather than silently dropping. For automation this is the
difference between fire-and-pray and fire-and-verify; agents reading the
current text may add unnecessary `link_list` pre-checks or assume silent loss.

**Fix:** one sentence, e.g.:

> Sends to a name that isn't connected fail with an error result — delivery
> failure is visible to the sender, not silent.

**Verify:** `link_send` to a bogus name → tool result shows the error (already
exercised in the live test run).

---

## #3 — link_compact timeout missing

**Where:** `### link_compact` section.

**Problem:** `link_prompt` gets its numbers (90s inactivity, 30min ceiling)
but compact's 180s ceiling (`COMPACT_TIMEOUT_MS = 180_000`) is absent. An
orchestrator blocking on `link_compact` should know how long "blocks until
done" can mean before it errors.

**Fix:** one clause, e.g. after "Blocks until the target finishes compacting,
then returns":

> (3 min ceiling — large-context compactions that exceed it resolve as an
> error).

**Verify:** clause matches `COMPACT_TIMEOUT_MS` in index.ts.

---

## Considered and rejected (don't re-litigate)

- **Broadcast-`"*"`-with-`triggerTurn:true` anti-pattern** (every terminal
  activates, including e.g. a committer) — already implied by the
  parallel-batch section + "no exclusion filter"; marginal tokens for
  marginal protection.
- **Rename mechanics** (`/link-name` appearing as left+joined to observers) —
  real but niche; wrong altitude for this file.
- **Quick Reference vs Tool Selection Rule redundancy** — deliberate
  reinforcement at two retrieval points; keep both.
- **Receiver-side `link_prompt` guidance** — transparent to the receiver (runs
  as a typed prompt); nothing to instruct.

## Out of scope

- README/CHANGELOG edits (README already current for #1; #2/#3 are
  skill-altitude details, not README gaps).
- `orchestrate-code-pipeline` skill (separate file, separate owner concerns).
- Any index.ts/bin changes.

## Sequencing

Single pass; the three edits are independent and tiny. No mechanical gate
applies (doc-only) — verification is the per-item checks above plus one
full re-read of the skill for flow after the insertions.

**Note for the implementer:** the skill ships in the npm package (`files`
includes `skills/`), so this lands for users at the next release; no version
bump in this plan (handled by hand, per convention).
