# Deferred: pi-link tools are not top-level under Oh My Pi

- **Status:** accepted compatibility issue, deferred until after the next pi-link release. **Not a blocker for that release.**
- **Last aligned:** 2026-08-28.
- **Build from this?** Not yet — retake after the release using the bounded candidate and gates below.
- **Summary:** Oh My Pi defaults every extension tool outside its built-in allowlist to `loadMode: "discoverable"`, so under OMP's default xdev-enabled presentation pi-link's three tools are mounted under `xd://` instead of the top-level callable schema, and a model cannot call them the way the bundled skill instructs.

## External evidence

A GitHub reporter described a real four-terminal OMP deployment in which pi-link's
tools were not directly callable — none of the client terminals could reach the
coordinator terminal through them — and reported that adding `loadMode: "essential"`
fixed it end to end in their fork.

Reference branch and commit:
`https://github.com/kylebrodeur/pi-link/tree/fix/loadmode-essential-omp`,
`f01ac274326048e50cdedeb200faa5883764e781`.

**Classification: reporter-observed.** The production incident and the successful fix
were reported by the user, **not reproduced locally**. No OMP session was run in this
environment. The mechanics below are what we verified ourselves.

## Independently source-verified OMP mechanics

Read directly from the OMP source at commit
`2a7db5855d2d7b2c2d2de0a7c75baac73bcef221` (2026-08-28). Every OMP path and line
number in this report refers to that commit and may drift on later ones.

- **Extension tools default to `discoverable`.** `defaultLoadModeForToolName` returns
  `"essential"` only for names in a small built-in allowlist and `"discoverable"` for
  everything else — `packages/coding-agent/src/tools/essential-tools.ts:43-46`. The
  extension adapter applies it at
  `packages/coding-agent/src/extensibility/extensions/wrapper.ts:48`.
- **pi-link's names are outside that allowlist.** The allowlist is `read`, `write`,
  `bash`, `edit`, `glob`, `computer`, `eval`, `task`, `hub`, `learn`, `manage_skill`
  (`essential-tools.ts:25-37`). `link_send`, `link_compact` and `link_list` are not in
  it.
- **`tools.xdev` defaults to `true`** — `packages/coding-agent/src/config/settings-schema.ts:4646-4649`.
  Discoverable tools therefore leave the top-level schema and mount under `xd://`
  device URLs driven through `read`/`write`.
- **`tools.xdevDocs` defaults to `builtins`** — `settings-schema.ts:4658-4663`:
  built-in docs stay inline while extension schemas are fetched on demand. So even
  under OMP's default prompt, pi-link's schemas are not merely demoted — they are not
  inlined at all.
- **A custom `--system-prompt` removes the default `xd://` dispatch guidance —
  OMP-documentation-verified.**
  `docs/system-prompt-customization.md:40-60` states that the custom template retains
  discovered skills, and that what disappears is the content unique to the default
  instruction template: its tool inventory and general tool policy, internal-URL
  catalog, and `xd://` protocol guidance. This is verified against OMP's own
  documentation rather than separately traced through its prompt-assembly code. The
  consequence is direct: the bundled `pi-link-coordination` skill still names
  `link_send`, `link_compact` and `link_list` as directly callable, while the callable
  schema lacks them and OMP's generated prompt no longer explains the alternate
  dispatch unless the custom text supplies that guidance.
- **Disabling xdev *does* restore top-level presentation.** With `tools.xdev: false`,
  enabled extension tools stay top-level. The partitioning that moves names off the
  top-level schema runs only inside `if (toolSession.xdev)` — `sdk.ts:3248-3270` — and
  `tools/index.ts:735-779` states outright that without mounting such tools are
  "already presented — and callable — top-level". **BM25 tool discovery no longer
  exists:** `config/settings.ts:2218-2231` records that `tools.discoveryMode` /
  `tools.essentialOverride` were removed with no replacement, and deletes the dead
  keys. The BM25 sentence still present in the `packages/agent/src/types.ts:708-717`
  doc comment is **stale prose**, not behaviour. Disabling xdev is therefore a real
  configuration workaround — at the cost of moving every discoverable tool top-level,
  not just pi-link's.

## Correction to the reporter's framing

pi-link 0.3 registers **exactly three** tools: `link_send`, `link_compact`,
`link_list`.

`link_prompt` was **intentionally removed** and must not come back. The reporter's
fork patches **four** tools because it targets the older four-tool surface: its
`index.ts` still contains `link_prompt`. Commit `f01ac27` is itself a **focused
four-line patch to `index.ts`** with an ordinary parent, `91cdc75b...`.

**Correction to an earlier reading of ours:** this commit was previously described
here as a squashed re-import of the whole project. That was an artifact of the
**shallow clone** used for inspection — `.git/shallow` pins `f01ac27`, its parent is
absent, so `git show --stat` reported every file as an addition. The commit itself is
narrow.

**Do not cherry-pick it**: it is based on the old four-tool surface, and its fourth
hunk targets the now-absent `link_prompt` registration, so it is
obsolete/inapplicable on current source. Port the idea as the bounded
shared-metadata patch for the current three tools.

## Impact boundary

- This is a **presentation and visibility defect on OMP**. `loadMode` decides how an
  already-enabled tool is presented; it does not touch Pi's protocol, message
  routing, delivery or tool behaviour.
- **A custom system prompt is not required for the demotion** — it happens under
  OMP's default, xdev-enabled presentation. What the custom prompt removes is the
  documented `xd://` guidance, which is what turns a degraded experience into a
  practical failure.
- **`promptSnippet` cannot compensate.** OMP's extension `ToolDefinition` has no
  `promptSnippet` field and the identifier appears nowhere in OMP's source, so the
  one-line snippets pi-link sets on all three tools — which populate Pi's "Available
  tools" section — have no effect there. OMP does not use `promptSnippet`; explicit
  `loadMode` is the per-tool registration fix, while `tools.xdev: false` is the global
  configuration workaround.
- **Original Pi is unaffected.** It has no `loadMode` concept and already exposes all
  three tools top-level.

## Bounded candidate, after the release

- **Mark all three tools essential.** The bundled skill documents all three as
  directly callable, so a partial fix would leave the shipped skill contradicting the
  callable schema.
- **Use one shared metadata object**, spread **first** into each of the three
  registration literals:

  ```ts
  // Consumed by harnesses that demote extension tools by default (Oh My Pi);
  // preserved and ignored by Pi, whose ToolDefinition has no such field.
  const TOP_LEVEL_TOOL_METADATA = { loadMode: "essential" } as const;
  ```

  Spread it into exactly the three current tools — `link_send`, `link_compact`,
  `link_list` — and nothing else.

  Spreading first means a future explicit `loadMode` on one tool would win rather
  than be silently overwritten. `as const` matters: without it the value widens to
  `string` and would not satisfy OMP's `ToolLoadMode`.
- **Why a spread rather than a direct property.** Pi's `ToolDefinition` has no
  `loadMode` field and no index signature, while `registerTool` takes that type
  directly (`dist/core/extensions/types.d.ts:342-376`; `registerTool` at `:902` in
  0.84.2 and `:927` in 0.84.3). Pi's runtime stores the whole definition verbatim and
  nothing downstream enumerates or whitelists keys, so the field is **inert** there.
  The spread keeps an unknown property out of a fresh, narrowly typed object literal.
- **Version note — the minimum and current installed Pi versions were inspected.** Pi
  **0.84.2** was installed when this review began and was read directly; the global
  install was then updated and Pi **0.84.3** was read as well. **Neither**
  `ToolDefinition` carries `loadMode`, and **both** store the definition verbatim:
  `dist/core/extensions/loader.js:215-221` on 0.84.2 and `:239-245` on 0.84.3. This is
  verified at pi-link's declared floor, 0.84.2, and at the then-current installed
  0.84.3; later Pi versions must be rechecked when this work is retaken.
- **Calibration:** the concern that a *direct* `loadMode` property would trip
  TypeScript's excess-property check on a fresh object literal is **reasoned from
  language semantics, not compiler-measured** — no TypeScript compiler is available
  in this environment and installing one was out of scope. The spread form is
  recommended precisely because it is correct either way. If anyone prefers the
  direct property, settle it with a real `tsc` run first.
- **Do not prescribe a version number now.**

## Regression and validation gates

- Use the **connection-ownership harness** (`test/connection-ownership-test.mjs`). It
  already loads the real `index.ts` and already captures whole registration objects
  (`registerTool(tool) { tools.set(tool.name, tool); }`), so only a small accessor is
  needed to expose the captured definitions.
- Assert **before any connection is established**, at registration time: the
  registered names are exactly `link_compact`, `link_list`, `link_send`, and each
  carries `loadMode === "essential"`.
- **Do not import or simulate OMP internals.** Assert only the metadata pi-link emits;
  that is all that can honestly be checked without their runtime.
- Run every existing pi-link suite.
- Obtain a **live OMP confirmation** that the three tools are top-level and callable
  when the work is retaken.

## Costs and non-goals

- **Cost:** under OMP the three schemas will ride every request even while pi-link is
  disconnected, since tools are registered at load and only refuse at execution time.
  That is the deliberate compatibility tradeoff, and it matches what Pi already does
  today.
- **Non-goals:** no OMP support promise, no renderer fix, no skill rewrite, no
  protocol change, no tool-activation redesign, no README change, and no version,
  install, tag, push or publish action.
- **Separate debt:** `REPORT-omp-renderer-signature.md` records a source-predicted TUI
  rendering mismatch under OMP. It is a different mechanism with different evidence
  and **must not be bundled into this fix automatically**.
