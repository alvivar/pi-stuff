/**
 * uppercase-pi — last-mile finalizer that rewrites standalone "pi" (any case)
 * → "PI" in the system instructions of the outbound provider payload.
 *
 * Runs in `before_provider_request`, which fires after the provider-specific
 * payload has been built and right before it is sent. This is the latest
 * point at which an extension can influence the system prompt that actually
 * reaches the model, regardless of:
 *   - the built-in system prompt,
 *   - SYSTEM.md and AGENTS.md injections,
 *   - --append-system-prompt flags,
 *   - any `before_agent_start` handlers from other extensions,
 *   - and the provider-specific serialization step itself.
 *
 * Scope is strictly limited to the system-instruction fields of the known
 * provider payload shapes. User/assistant/tool messages, tool descriptions,
 * parameters, and any other payload field are left untouched.
 *
 * Preserves markdown code spans and skips identifier-like contexts
 * (`pi-coding-agent`, `.pi/x`, `pi.on`, `api`, `_pi`), so examples like
 * `pi install` in system instructions stay intact.
 *
 * The transform is idempotent: `/\bpi\b/gi` matches `PI` too, and the
 * replacement is `"PI"`, so running it twice is indistinguishable from
 * running it once. Safe against accidental double-registration or an
 * upstream producer that already uppercased.
 *
 * Caveat: extensions with a later `before_provider_request` handler could
 * rewrite system instructions after this one runs. In practice no shipped
 * PI extension does payload-level system-instruction rewriting — if you
 * install one that does, resolve it via load ordering, not by re-layering
 * this finalizer.
 *
 * Trade-off vs. the previous `before_agent_start` implementation:
 * `ctx.getSystemPrompt()` no longer reflects the transform, because it
 * reports PI's internal system-prompt string rather than the final
 * serialized provider payload. Outbound correctness is preserved; internal
 * prompt introspection sees the pre-uppercase string. This is the
 * documented behavior of the hook, not a bug of this extension.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Standalone "pi" (any case), but not inside identifier-like contexts:
//   - preceded by `-`, `/`, `\`, or `.`  (path segments, package names,
//     dotted filenames like `foo.pi`)
//   - followed by `-`, `/`, or `\`       (package names, path segments)
//   - followed by `.\w`                  (member access like `pi.on`)
// The `.\w` variant matters: the previous rule `(?![-/\\.])` also skipped
// `pi.` at end of a sentence, which is a common shape in system prompts
// ("You operate inside pi.") and is exactly what we want to uppercase.
const PI_WORD = /(?<![-/\\.])\bpi\b(?![-/\\])(?!\.\w)/gi;

// Markdown code spans to preserve verbatim. Order matters: longer fences
// before shorter ones in the alternation.
const CODE_SPAN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|``[^`\n]*``|`[^`\n]*`)/;

// Transform plain text: uppercase standalone "pi" outside code spans.
// Returns the input reference unchanged when nothing matched, so callers
// can cheaply test `next === text` to skip allocating wrappers.
function transform(text: string): string {
  if (text.length === 0) return text;
  const parts = text.split(CODE_SPAN);
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    const replaced = parts[i].replace(PI_WORD, "PI");
    if (replaced !== parts[i]) {
      parts[i] = replaced;
      changed = true;
    }
  }
  return changed ? parts.join("") : text;
}

// Rewrite a chat-message `content` field. Accepts the two shapes used by
// OpenAI Completions / Mistral system messages: a plain string, or an array
// of content parts `{ type: "text", text: string }`. Returns the original
// reference when nothing changed.
function transformContent(content: unknown): unknown {
  if (typeof content === "string") return transform(content);
  if (Array.isArray(content)) {
    let touched = false;
    const next = content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        const text = (part as { text: string }).text;
        const replaced = transform(text);
        if (replaced !== text) {
          touched = true;
          return { ...(part as object), text: replaced };
        }
      }
      return part;
    });
    return touched ? next : content;
  }
  return content;
}

// Walk every known provider system-instruction field and return a payload
// with those fields rewritten. If nothing changed, returns the original
// payload reference so the handler can signal "no change" to the runner.
function rewriteSystemInstructions(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...p };
  let touched = false;

  // 1. Anthropic / Amazon Bedrock: `system` is an array of text blocks.
  //    Each block: { type?: "text", text: string, cache_control?: ... }.
  //    We copy every block, only swapping `text` on the ones we rewrote,
  //    so `cache_control` and any other fields are preserved verbatim.
  if (Array.isArray(p.system)) {
    let sysTouched = false;
    const nextSystem = (p.system as unknown[]).map((block) => {
      if (block && typeof block === "object") {
        const b = block as { text?: unknown };
        if (typeof b.text === "string") {
          const replaced = transform(b.text);
          if (replaced !== b.text) {
            sysTouched = true;
            return { ...(block as object), text: replaced };
          }
        }
      }
      return block;
    });
    if (sysTouched) {
      out.system = nextSystem;
      touched = true;
    }
  } else if (typeof p.system === "string") {
    // Defensive: not emitted by any built-in provider today, but some
    // custom providers may use a plain string here.
    const replaced = transform(p.system);
    if (replaced !== p.system) {
      out.system = replaced;
      touched = true;
    }
  }

  // 2. OpenAI Codex Responses: `instructions` is a plain string. Standard
  //    OpenAI Responses and Azure OpenAI Responses do NOT use this field —
  //    they embed system as the first entry of `payload.input[]`, handled
  //    below together with chat-style `messages[]` via the role-filtered walk.
  if (typeof p.instructions === "string") {
    const replaced = transform(p.instructions);
    if (replaced !== p.instructions) {
      out.instructions = replaced;
      touched = true;
    }
  }

  // 3. Google / Vertex / Gemini CLI: `systemInstruction` is a plain string
  //    in PI's current provider code, but the native Gemini API also
  //    accepts `{ parts: [{ text: string }, ...] }` — handle both.
  if (typeof p.systemInstruction === "string") {
    const replaced = transform(p.systemInstruction);
    if (replaced !== p.systemInstruction) {
      out.systemInstruction = replaced;
      touched = true;
    }
  } else if (p.systemInstruction && typeof p.systemInstruction === "object") {
    const si = p.systemInstruction as { parts?: unknown };
    if (Array.isArray(si.parts)) {
      let siTouched = false;
      const nextParts = (si.parts as unknown[]).map((part) => {
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          const text = (part as { text: string }).text;
          const replaced = transform(text);
          if (replaced !== text) {
            siTouched = true;
            return { ...(part as object), text: replaced };
          }
        }
        return part;
      });
      if (siTouched) {
        out.systemInstruction = { ...(si as object), parts: nextParts };
        touched = true;
      }
    }
  }

  // 4. Role-filtered arrays. Covers:
  //      - OpenAI Completions / Mistral: `payload.messages[]`
  //      - OpenAI Responses / Azure OpenAI Responses:
  //          `payload.input[]` where the first entry is a system/developer
  //          item. Later entries are user/assistant/tool items and are
  //          correctly skipped by the role filter.
  //    Each matching entry has `content` that is either a string or an
  //    array of `{ type: "text", text }` parts. Items in the array that
  //    don't match the role filter are left untouched.
  for (const key of ["messages", "input"] as const) {
    const arr = p[key];
    if (!Array.isArray(arr)) continue;
    let arrTouched = false;
    const next = (arr as unknown[]).map((msg) => {
      if (msg && typeof msg === "object") {
        const m = msg as { role?: unknown; content?: unknown };
        if (m.role === "system" || m.role === "developer") {
          const nextContent = transformContent(m.content);
          if (nextContent !== m.content) {
            arrTouched = true;
            return { ...(msg as object), content: nextContent };
          }
        }
      }
      return msg;
    });
    if (arrTouched) {
      out[key] = next;
      touched = true;
    }
  }

  return touched ? out : payload;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    const next = rewriteSystemInstructions(event.payload);
    // Return undefined when nothing changed so the runner doesn't
    // unnecessarily replace the payload object for later handlers.
    return next === event.payload ? undefined : next;
  });
}
