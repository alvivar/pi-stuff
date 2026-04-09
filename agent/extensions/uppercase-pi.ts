/**
 * uppercase-pi — rewrites standalone "pi" (any case) → "PI" in the effective
 * system prompt before each agent turn, so the harness is referred to in all
 * caps.
 *
 * Implemented as a before_agent_start transform (rather than SYSTEM.md) so
 * the built-in prompt is preserved as-is, including dynamic tool snippets
 * and guidelines from other extensions, with no upstream drift.
 *
 * Skips identifier-like contexts (`pi-coding-agent`, `.pi/x`, `pi.on`, `api`,
 * `_pi`) and the contents of markdown code spans, so examples like
 * `pi install` in an AGENTS.md or skill doc stay intact.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Standalone "pi" (any case), but not when adjacent to - / \ . — those would
// indicate a path segment, package name, or member access expression.
const PI_WORD = /(?<![-/\\.])\bpi\b(?![-/\\.])/gi;

// Markdown code spans to preserve verbatim. Order matters: longer fences
// must come before shorter ones in the alternation.
const CODE_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|``[^`\n]*``|`[^`\n]*`)/;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    // split() with a capturing regex keeps matches at odd indices, so even
    // indices are the prose between code spans.
    const parts = event.systemPrompt.split(CODE_SPAN);
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i].replace(PI_WORD, "PI");
    }
    return { systemPrompt: parts.join("") };
  });
}
