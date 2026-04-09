/**
 * uppercase-pi
 *
 * Rewrites standalone "pi" → "PI" in the effective system prompt before each
 * agent turn, so the harness is referred to in all caps.
 *
 * Why a transform (not SYSTEM.md)?
 *   A full SYSTEM.md override takes the `customPrompt` branch in
 *   buildSystemPrompt(), which skips the dynamic tool snippets and prompt
 *   guidelines contributed by built-in tools and other extensions (context
 *   files, skills, date and cwd are still appended). It also drifts from
 *   upstream on every pi release. A before_agent_start transform preserves
 *   the built-in prompt as-is and only rewrites the product name in prose.
 *
 * Scope:
 *   The regex runs over the effective system prompt (base template, any
 *   tool snippets / guidelines contributed by extensions, APPEND_SYSTEM.md,
 *   context files, skills), but only **outside** markdown code spans and
 *   fenced code blocks, so command examples like `pi install` in an
 *   AGENTS.md or skill doc stay intact. It is also conservative about
 *   adjacent punctuation to avoid touching identifier-like contexts:
 *     - paths:       pi-coding-agent, .pi/extensions/, node_modules\pi-…
 *     - code refs:   pi.on(…), pi.registerTool(…)
 *     - compounds:   api, _pi, pistachio            (handled by \b)
 *
 *   If upstream later renames the product or changes casing to mixed usage,
 *   this extension silently becomes a no-op on those strings — no crash.
 *
 *   Idempotent: the regex is case-insensitive and "PI" replaced with "PI"
 *   is a no-op, so running the transform twice yields the same result.
 *
 * Cost: two regex passes over a few KB per user turn. Negligible.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Standalone "pi" as a word (any case: pi, Pi, PI, pI), but not when
// adjacent to - / \ . which would indicate a path segment, package name,
// or member access expression.
const PI_WORD = /(?<![-/\\.])\bpi\b(?![-/\\.])/gi;

// Markdown code spans to preserve verbatim. Order matters: more specific
// patterns come first so regex alternation picks them before the shorter
// forms (e.g. `` `` `` must win over `` ` ``). Supports:
//   - ``` ```fenced``` ```
//   - ~~~fenced~~~
//   - ``double-backtick inline``
//   - `single-backtick inline`
// The outer capture group makes String.prototype.split keep matches in
// the result array at odd indices.
const CODE_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|``[^`\n]*``|`[^`\n]*`)/g;

function uppercaseOutsideCode(text: string): string {
  const parts = text.split(CODE_SPAN);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(PI_WORD, "PI");
  }
  return parts.join("");
}

export default function uppercasePiExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const rewritten = uppercaseOutsideCode(event.systemPrompt);
    if (rewritten === event.systemPrompt) return undefined;
    return { systemPrompt: rewritten };
  });
}
