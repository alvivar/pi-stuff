# Deferred: OMP `renderCall` signature mismatch

- **Status:** deferred until after the next pi-link release. **Not a release blocker.**
- **Last aligned:** 2026-08-28.
- **Build from this?** No — reproduce under a live OMP session first.
- **Summary:** pi-link's `link_send` and `link_compact` call renderers take Pi's `(args, theme)` argument order, while Oh My Pi passes `(args, options, theme)`, so under OMP the second argument is an options object rather than a theme and the custom call rendering is predicted to fail into OMP's generic fallback.

## How this was found

During source review of the GitHub issue about pi-link tools not being reachable as
top-level tools under Oh My Pi (OMP). That issue is about **tool visibility**, which
is a different mechanism with a different fix; see `REPORT-omp-tool-visibility.md`.
This finding was deliberately excluded from that work and from the next release. It
surfaced from reading OMP's extension adapter, not from any report of broken
rendering.

## The contract difference

Every OMP path and line number in this report was read at OMP commit
`2a7db5855d2d7b2c2d2de0a7c75baac73bcef221` (2026-08-28); they may drift on later
commits.

**Pi** — `dist/core/extensions/types.d.ts:374`, read from the installed
`@earendil-works/pi-coding-agent` (see the version note below):

```ts
renderCall?: (args, theme: Theme, context: ToolRenderContext) => Component;
```

**OMP** — `packages/coding-agent/src/extensibility/extensions/types.ts:659`:

```ts
renderCall?: (args, options: ToolRenderResultOptions, theme: Theme) => Component;
```

OMP's extension adapter forwards in its own order —
`packages/coding-agent/src/extensibility/extensions/wrapper.ts:54-56`:

```ts
this.renderCall = (args, options, theme) =>
  registeredTool.definition.renderCall!(args, options, theme as Theme);
```

**Theme sits in position 2 under Pi and position 3 under OMP.**

## What pi-link does today

Two tools define a custom call renderer, both with Pi's order:

| tool | site | signature | uses |
| --- | --- | --- | --- |
| `link_send` | `index.ts:1492` | `renderCall(args, theme)` | `theme.fg(...)`, `theme.bold(...)` |
| `link_compact` | `index.ts:1605` | `renderCall(args, theme)` | `theme.fg(...)`, `theme.bold(...)` |

`link_list` defines **no** `renderCall`, so it is unaffected.

Under OMP the local `theme` parameter receives OMP's options object
(`{ expanded, isPartial, spinnerFrame }`). The first `theme.fg(...)` call would then
throw. **Predicted error: `theme.fg is not a function`.**

## Scope of impact

- **TUI call rendering only.** This code decides how a tool call is drawn.
- **OMP already contains the blast radius.** It catches renderer failures, logs
  `Tool renderer failed` with the tool name, and falls back to generic display —
  `packages/coding-agent/src/modes/components/tool-execution.ts:191` and four further
  sites (`:1151`, `:1190`, `:1251`, `:1307`).
- **Nothing functional is affected.** Tool execution, argument parsing, message
  routing, delivery, wire protocol and result values do not pass through a renderer.
  The predicted symptom is cosmetic: a plainer row in the TUI plus a log warning.

## `renderResult` is a separate case and is **not** implicated

pi-link's three `renderResult` handlers take `(result, options, theme)` —
`index.ts:1505`, `:1613`, `:1657`. Both hosts agree on those first three positions:

- Pi: `(result, options, theme, context)` — `types.d.ts:376`
- OMP: `(result, options, theme, args?)` — `extensions/types.ts:662-667`, forwarded at
  `wrapper.ts:58-63`

The hosts differ only in the **fourth** argument, which pi-link never declares and
therefore ignores. **No current `renderResult` defect is established.** Do not change
`renderResult` on the strength of this report.

## Evidence calibration

**Source-verified** (read directly in this environment):

- both `renderCall` signatures, in Pi's shipped typings and OMP's source;
- OMP's adapter forwarding order;
- OMP's renderer failure catch, log string and generic fallback;
- pi-link's two `renderCall` handlers, their argument order and their `theme.fg` use;
- that `link_list` has no `renderCall`;
- that `renderResult`'s first three positions agree across both hosts.

**Predicted, not observed:** that a real OMP session running pi-link shows the
generic fallback and a `Tool renderer failed` warning. This has **not** been
reproduced live. The conclusion follows from the signatures, but no one has watched
it happen.

**Not reported by anyone:** the GitHub reporter, who ran pi-link under OMP in a
four-terminal deployment, described tools being unreachable and did **not** mention
rendering trouble. Treat this as a source-derived prediction, not a live incident,
and do not cite it as an observed failure.

**Version note — the minimum and current installed Pi versions were inspected.** Pi
**0.84.2** was the installed version when this review began and was read directly;
the global install was then updated and Pi **0.84.3** was read as well. **Both**
declare `renderCall(args, theme, context)`, and **neither** `ToolDefinition` carries
a `loadMode` field. This is verified at pi-link's declared floor, 0.84.2, and at the
then-current installed 0.84.3; later Pi versions must be rechecked when this work is
retaken.

## Investigation gate, after the release

Reproduce before writing any code:

1. Run a current OMP interactive session with pi-link's tools directly callable.
2. Invoke `link_send` and `link_compact`.
3. Inspect the TUI and the logs for a generic fallback row and a
   `Tool renderer failed` warning naming those tools.
4. Independently confirm that execution, results and routing remain correct — the
   claim that this is cosmetic is itself a prediction until checked.

**If no symptom reproduces, close this report with no code change.**

## Candidate direction — only if reproduced

- A narrow call-render adapter that picks whichever argument is theme-shaped: use the
  second when it exposes an `fg` function, otherwise the third. Test it against both
  hosts' invocation orders.
- Or delete the two custom call renderers, if a one-line preview does not justify
  carrying host-compatibility code. Weigh this honestly; it may be the better answer.
- Do not touch `renderResult` without new evidence.

## Non-goals

No `loadMode` change, no OMP support promise, no renderer implementation now, and no
protocol, workflow, skill, release or version change.
