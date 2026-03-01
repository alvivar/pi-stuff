import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Simple file logger — writes newline-delimited JSON to ~/.pi/agent/debug.log
// Watch live:  tail -f ~/.pi/agent/debug.log
// Pretty-read: cat ~/.pi/agent/debug.log | jq .
// ---------------------------------------------------------------------------
const DEBUG_LOG_FILE = path.join(os.homedir(), ".pi", "agent", "debug.log");

function debugLog(event: string, data?: unknown): void {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, data: data ?? null });
    fs.appendFileSync(DEBUG_LOG_FILE, entry + "\n", "utf8");
  } catch {
    // Never crash the extension because of a logging failure
  }
}

type CliEffort = "low" | "medium" | "high";

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  costTotal?: number;
};

const REASONING_TO_EFFORT: Partial<Record<NonNullable<SimpleStreamOptions["reasoning"]>, CliEffort>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

function mapReasoningToCliEffort(reasoning?: SimpleStreamOptions["reasoning"]): CliEffort | undefined {
  return reasoning ? REASONING_TO_EFFORT[reasoning] : undefined;
}

const DEFAULT_CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || "claude";
const DEFAULT_TIMEOUT_SECONDS = Number(process.env.CLAUDE_CLI_TIMEOUT_SECONDS || "240");

const DEFAULT_ALLOWED_TOOLS =
  process.env.CLAUDE_CLI_ALLOWED_TOOLS ||
  "Read,Edit,Write,Bash,Grep,Glob";

const SONNET46_CLI_MODEL =
  process.env.CLAUDE_CLI_MODEL_SONNET_46 || process.env.CLAUDE_CLI_MODEL_SONNET || "claude-sonnet-4-6";
const OPUS46_CLI_MODEL =
  process.env.CLAUDE_CLI_MODEL_OPUS_46 || process.env.CLAUDE_CLI_MODEL_OPUS || "claude-opus-4-6";
const HAIKU45_CLI_MODEL =
  process.env.CLAUDE_CLI_MODEL_HAIKU_45 || process.env.CLAUDE_CLI_MODEL_HAIKU || "claude-haiku-4-5";

const GLOBAL_APPEND_SYSTEM_PROMPT = process.env.CLAUDE_CLI_APPEND_SYSTEM_PROMPT;

function parseJsonLine(line: string): any | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractSessionId(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const sid = (o: any): string | undefined => {
    const v = o?.session_id ?? o?.sessionId;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  return sid(event) ?? sid(event.result) ?? sid(event.metadata) ?? sid(event.event);
}

function extractTextDelta(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const delta = event.event?.delta;
  if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text;
  if (event.type === "stream_event" && typeof event.event?.text === "string") return event.event.text;
  return undefined;
}

function extractResultText(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;

  const candidates = [event.result, event.output, event.text, event.message?.text];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function extractUsage(event: any): UsageLike | undefined {
  if (!event || typeof event !== "object") return undefined;

  const usage = event.usage ?? event.metadata?.usage ?? event.result?.usage;
  if (!usage || typeof usage !== "object") return undefined;

  const input = asNumber(usage.input ?? usage.input_tokens);
  const output = asNumber(usage.output ?? usage.output_tokens);
  const cacheRead = asNumber(usage.cacheRead ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cacheWrite ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens);
  const totalTokens = asNumber(
    usage.totalTokens ?? usage.total_tokens ?? ((input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)),
  );
  const costTotal = asNumber(usage.cost?.total ?? usage.total_cost ?? usage.total_cost_usd ?? event.total_cost_usd);

  return { input, output, cacheRead, cacheWrite, totalTokens, costTotal };
}

function applyUsage(output: AssistantMessage, usage?: UsageLike, model?: Model<Api>) {
  if (!usage) return;
  output.usage.input = usage.input ?? output.usage.input;
  output.usage.output = usage.output ?? output.usage.output;
  output.usage.cacheRead = usage.cacheRead ?? output.usage.cacheRead;
  output.usage.cacheWrite = usage.cacheWrite ?? output.usage.cacheWrite;
  output.usage.totalTokens =
    usage.totalTokens ?? output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;

  if (typeof usage.costTotal === "number") {
    output.usage.cost.total = usage.costTotal;
  } else if (model) {
    calculateCost(model, output.usage);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n\n")
    .trim();
}

function getPiSystemPrompt(context: Context): string | undefined {
  const directSystemPrompt = contentToText((context as any).systemPrompt);
  if (directSystemPrompt) return directSystemPrompt;

  const messages = Array.isArray((context as any).messages) ? (context as any).messages : [];
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg?.role !== "system") continue;
    const text = contentToText(msg.content);
    if (text) parts.push(text);
  }
  const merged = parts.join("\n\n").trim();
  return merged || undefined;
}

function getLastUserText(context: Context): string {
  const msg = context.messages.findLast((m) => m.role === "user");
  if (!msg) return "Continue.";
  if (typeof msg.content === "string") return msg.content.trim() || "Continue.";
  const textParts = msg.content.filter((c) => c.type === "text").map((c) => c.text);
  const imageCount = msg.content.filter((c) => c.type === "image").length;
  let text = textParts.join("\n\n").trim() || "Continue.";
  if (imageCount > 0) {
    text += `\n\n[Note: ${imageCount} image attachment(s) were provided in Pi but are not forwarded by claude-code-provider v1.]`;
  }
  return text;
}

function cliModelFor(modelId: string): string {
  if (modelId.startsWith("claude-code-opus-4-6"))  return OPUS46_CLI_MODEL;
  if (modelId.startsWith("claude-code-haiku-4-5")) return HAIKU45_CLI_MODEL;
  return SONNET46_CLI_MODEL; // default: Sonnet 4.6
}

function streamClaudeCli(
  sessionMap: Map<string, string>,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let textIndex: number | undefined;
    const thinkingIndexByBlock = new Map<number, number>();
    let latestSessionId: string | undefined;
    let fallbackResultText = "";
    const stderrChunks: string[] = [];
    let lineBuffer = "";
    let timeoutId: NodeJS.Timeout | undefined;
    let proc: ReturnType<typeof spawn> | undefined;
    let gotAbort = false;

    const streamKey = `${options?.sessionId || "default"}:${model.id}`;
    const rememberedSessionId = sessionMap.get(streamKey);

    const cli = DEFAULT_CLAUDE_CLI;
    const timeoutMs = Number.isFinite(DEFAULT_TIMEOUT_SECONDS) && DEFAULT_TIMEOUT_SECONDS > 0
      ? Math.floor(DEFAULT_TIMEOUT_SECONDS * 1000)
      : 240_000;

    const cliModel = cliModelFor(model.id);
    const prompt = getLastUserText(context);
    const piSystemPrompt = getPiSystemPrompt(context);
    const effort = mapReasoningToCliEffort(options?.reasoning);

    const args = [
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      cliModel,
      "--allowedTools",
      DEFAULT_ALLOWED_TOOLS,
    ];

    if (effort) {
      args.push("--effort", effort);
    }

    const globalPrompt = GLOBAL_APPEND_SYSTEM_PROMPT?.trim();
    if (piSystemPrompt) {
      const parts = [piSystemPrompt, globalPrompt].filter((p): p is string => Boolean(p));
      args.push("--system-prompt", parts.join("\n\n"));
    } else if (globalPrompt) {
      args.push("--append-system-prompt", globalPrompt);
    }

    if (rememberedSessionId) {
      args.push("--resume", rememberedSessionId);
    }

    const beginText = () => {
      if (textIndex !== undefined) return;
      output.content.push({ type: "text", text: "" });
      textIndex = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
    };

    const appendText = (delta: string) => {
      if (!delta) return;
      beginText();
      const block = output.content[textIndex!] as { type: "text"; text: string };
      block.text += delta;
      stream.push({ type: "text_delta", contentIndex: textIndex!, delta, partial: output });
    };

    const endTextIfNeeded = () => {
      if (textIndex === undefined) return;
      const block = output.content[textIndex] as { type: "text"; text: string };
      stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
    };

    const beginThinking = (blockIndex: number) => {
      output.content.push({ type: "thinking", thinking: "" });
      const contentIndex = output.content.length - 1;
      thinkingIndexByBlock.set(blockIndex, contentIndex);
      stream.push({ type: "thinking_start", contentIndex, partial: output });
    };

    const appendThinking = (blockIndex: number, delta: string) => {
      if (!delta) return;
      const contentIndex = thinkingIndexByBlock.get(blockIndex);
      if (contentIndex === undefined) return;
      const block = output.content[contentIndex] as { type: "thinking"; thinking: string };
      block.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
    };

    const endThinking = (blockIndex: number) => {
      const contentIndex = thinkingIndexByBlock.get(blockIndex);
      if (contentIndex === undefined) return;
      const block = output.content[contentIndex] as { type: "thinking"; thinking: string };
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
      thinkingIndexByBlock.delete(blockIndex);
    };

    debugLog("cli_start", {
      cli,
      args,
      model: model.id,
      cliModel,
      effort,
      resumeSessionId: rememberedSessionId,
      streamKey,
    });

    stream.push({ type: "start", partial: output });

    try {
      const exitCode = await new Promise<number>((resolve) => {
        proc = spawn(cli, args, {
          cwd: process.cwd(),
          env: process.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let resolved = false;
        const resolveOnce = (code: number) => {
          if (resolved) return;
          resolved = true;
          if (options?.signal) options.signal.removeEventListener("abort", killProc);
          resolve(code);
        };

        const killProc = () => {
          if (!proc) return;
          gotAbort = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
          setTimeout(() => {
            if (!proc || proc.killed) return;
            try {
              proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, 3000);
        };

        if (timeoutMs > 0) {
          timeoutId = setTimeout(killProc, timeoutMs);
        }
        if (options?.signal) {
          if (options.signal.aborted) killProc();
          options.signal.addEventListener("abort", killProc);
        }

        try {
          proc.stdin?.end(prompt);
        } catch {
          // ignore stdin write errors; process error/exit handlers cover failures
        }

        const processLine = (line: string) => {
          const parsed = parseJsonLine(line);
          if (!parsed) return;

          debugLog("stdout_line", parsed);

          const sid = extractSessionId(parsed);
          if (sid) {
            latestSessionId = sid;
            debugLog("session_id", { sid, streamKey });
          }

          const usage = extractUsage(parsed);
          if (usage) debugLog("usage", usage);
          applyUsage(output, usage, model);

          const streamEvent = parsed.type === "stream_event" ? parsed.event : undefined;
          if (streamEvent?.type === "content_block_start") {
            if (streamEvent.content_block?.type === "thinking" && typeof streamEvent.index === "number") {
              beginThinking(streamEvent.index);
              return;
            }
          }

          if (streamEvent?.type === "content_block_delta") {
            if (
              streamEvent.delta?.type === "thinking_delta" &&
              typeof streamEvent.delta.thinking === "string" &&
              typeof streamEvent.index === "number"
            ) {
              appendThinking(streamEvent.index, streamEvent.delta.thinking);
              return;
            }
          }

          if (streamEvent?.type === "content_block_stop") {
            if (typeof streamEvent.index === "number") {
              endThinking(streamEvent.index);
              return;
            }
          }

          const delta = extractTextDelta(parsed);
          if (delta) {
            appendText(delta);
            return;
          }

          const resultText = extractResultText(parsed);
          if (resultText) fallbackResultText = resultText;
        };

        proc.stdout.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          lineBuffer += text;
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() || "";
          for (const line of lines) processLine(line);
        });

        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8");
          stderrChunks.push(text);
          debugLog("stderr", { text: text.trim() });
        });

        proc.on("error", (err) => {
          stderrChunks.push(`${err.message}\n`);
          resolveOnce(1);
        });

        proc.on("close", (code) => {
          if (lineBuffer.trim()) processLine(lineBuffer);
          resolveOnce(code ?? 0);
        });
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (latestSessionId) {
        sessionMap.set(streamKey, latestSessionId);
      }

      if (textIndex === undefined && fallbackResultText.trim()) {
        appendText(fallbackResultText);
      }

      if (exitCode !== 0) {
        const trimmedStderr = stderrChunks.join("").trim();
        const effortUnsupported =
          Boolean(effort) &&
          trimmedStderr.includes("--effort") &&
          /unknown|invalid|unexpected/i.test(trimmedStderr);
        if (effortUnsupported) {
          throw new Error(
            `Claude CLI does not support --effort (${effort}). Update Claude CLI or use thinking off for this provider.\n${trimmedStderr}`,
          );
        }

        throw new Error(
          trimmedStderr ||
          (gotAbort || options?.signal?.aborted
            ? "Claude CLI request aborted"
            : `Claude CLI exited with code ${exitCode}`),
        );
      }

      endTextIfNeeded();
      output.stopReason = "stop";
      if (!output.usage.totalTokens) {
        output.usage.totalTokens =
          output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      }
      if (!output.usage.cost.total) {
        calculateCost(model, output.usage);
      }
      debugLog("done", {
        sessionId: latestSessionId,
        streamKey,
        usage: output.usage,
        contentLength: output.content.length,
      });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      endTextIfNeeded();
      output.stopReason = options?.signal?.aborted || gotAbort ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      debugLog("error", { message: output.errorMessage, stopReason: output.stopReason, stderr: stderrChunks.join("") });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  const sessionMap = new Map<string, string>();

  pi.registerProvider("claude-code", {
    baseUrl: "claude://local-cli",
    apiKey: "claude-code-local",
    api: "claude-code-api",

    models: [
      {
        id: "claude-code-sonnet-4-6",
        name: "Claude Code Sonnet 4.6",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-code-opus-4-6",
        name: "Claude Code Opus 4.6",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-code-haiku-4-5",
        name: "Claude Code Haiku 4.5",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
    ],

    streamSimple: streamClaudeCli.bind(null, sessionMap),
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Only intercept when the active model belongs to this provider.
    // Other providers (Anthropic, OpenAI, etc.) should compact normally.
    if (ctx.model?.provider !== "claude-code") return undefined;

    // Pi's conversation history is display-only when using the Claude Code provider.
    // Real memory (file context, tool history, prompt caching) lives in the Claude
    // Code CLI session via --resume. Invoking Claude Code just to compact Pi's
    // display log would be wasteful — return a cheap stub summary instead.
    const { preparation } = event;
    return {
      compaction: {
        summary: [
          "## Goal",
          "Ongoing conversation via Claude Code provider.",
          "",
          "## Critical Context",
          "- Conversation memory is managed by the Claude Code CLI session (--resume).",
          "- Pi conversation history is display-only; the provider only sends the last user message.",
          "- Switching to another provider will expose the full Pi Q&A history naturally.",
        ].join("\n"),
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
      },
    };
  });

  pi.registerCommand("claude-code-new-session", {
    description: "Clear stored Claude CLI session IDs to start a fresh session",
    handler: async (_args, ctx) => {
      sessionMap.clear();
      ctx.ui.notify("claude-code session map cleared", "info");
    },
  });
}
