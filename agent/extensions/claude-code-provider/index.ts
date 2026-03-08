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

// NOTE: Claude Code can emit internal tool_use events during a single assistant stream.
// Rendering those as Pi `toolCall` blocks causes UI ordering issues in interactive mode:
// tool cards are appended as pending tool execution components at the bottom instead of
// behaving like chronological chat content. To keep ordering stable, this provider emits
// tool-use as plain assistant text trace lines and streams content in strict arrival order.
// Partial assistant snapshots are consumed only as monotonic suffix fallback when canonical
// `stream_event` text deltas are not the active prose source.

// ---------------------------------------------------------------------------
// Simple file logger — writes newline-delimited JSON to ~/.pi/agent/debug.log
// Watch live:  tail -f ~/.pi/agent/debug.log
// Pretty-read: cat ~/.pi/agent/debug.log | jq .
// ---------------------------------------------------------------------------
const DEBUG_LOG_FILE = path.join(os.homedir(), ".pi", "agent", "debug.log");

function debugLog(event: string, data?: unknown): void {
  try {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      data: data ?? null,
    });
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

type RateLimitInfoLike = {
  status?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
  resetsAt?: number;
  overageResetsAt?: number;
  rateLimitType?: string;
};

type RunMetadataLike = {
  durationMs?: number;
  numTurns?: number;
};

type SystemInitInfoLike = {
  sessionId?: string;
  model?: string;
  claudeCodeVersion?: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  capturedAtMs: number;
};

type InitState = {
  latest?: SystemInitInfoLike;
};

const REASONING_TO_EFFORT: Partial<
  Record<NonNullable<SimpleStreamOptions["reasoning"]>, CliEffort>
> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

function mapReasoningToCliEffort(
  reasoning?: SimpleStreamOptions["reasoning"],
): CliEffort | undefined {
  return reasoning ? REASONING_TO_EFFORT[reasoning] : undefined;
}

const DEFAULT_CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || "claude";
const DEFAULT_TIMEOUT_SECONDS = Number(
  process.env.CLAUDE_CLI_TIMEOUT_SECONDS || "240",
);

const DEFAULT_ALLOWED_TOOLS =
  process.env.CLAUDE_CLI_ALLOWED_TOOLS || "Read,Edit,Write,Bash,Grep,Glob";

const SONNET46_CLI_MODEL =
  process.env.CLAUDE_CLI_MODEL_SONNET_46 ||
  process.env.CLAUDE_CLI_MODEL_SONNET ||
  "claude-sonnet-4-6";
const OPUS46_CLI_MODEL =
  process.env.CLAUDE_CLI_MODEL_OPUS_46 ||
  process.env.CLAUDE_CLI_MODEL_OPUS ||
  "claude-opus-4-6";
const HAIKU45_CLI_MODEL =
  process.env.CLAUDE_CLI_MODEL_HAIKU_45 ||
  process.env.CLAUDE_CLI_MODEL_HAIKU ||
  "claude-haiku-4-5";

const GLOBAL_APPEND_SYSTEM_PROMPT = process.env.CLAUDE_CLI_APPEND_SYSTEM_PROMPT;

const PENDING_BOOTSTRAP_CUSTOM_TYPE = "claude-code-provider/pending-bootstrap";
const PENDING_BOOTSTRAP_CONSUMED_CUSTOM_TYPE =
  "claude-code-provider/pending-bootstrap-consumed";

type PendingBootstrapEntryData = {
  version: 1;
  streamKey: string;
  compactionEntryId: string;
  summary: string;
  createdAt: string;
};

type PendingBootstrapConsumedEntryData = {
  version: 1;
  streamKey: string;
  compactionEntryId: string;
  consumedAt: string;
};

type PendingBootstrapState = PendingBootstrapEntryData;

type EntryAppender = {
  appendEntry<T = unknown>(customType: string, data?: T): void;
};

type SessionBranchReader = {
  getBranch(fromId?: string): Array<any>;
};

function getClaudeSessionStreamKey(
  modelId: string,
  options?: SimpleStreamOptions,
): string {
  return `${options?.sessionId || "default"}:${modelId}`;
}

function isPendingBootstrapEntryData(
  value: unknown,
): value is PendingBootstrapEntryData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    typeof data.streamKey === "string" &&
    typeof data.compactionEntryId === "string" &&
    typeof data.summary === "string" &&
    typeof data.createdAt === "string"
  );
}

function isPendingBootstrapConsumedEntryData(
  value: unknown,
): value is PendingBootstrapConsumedEntryData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    typeof data.streamKey === "string" &&
    typeof data.compactionEntryId === "string" &&
    typeof data.consumedAt === "string"
  );
}

function appendPendingBootstrapEntry(
  pi: EntryAppender,
  streamKey: string,
  compactionEntryId: string,
  summary: string,
): PendingBootstrapEntryData {
  const data: PendingBootstrapEntryData = {
    version: 1,
    streamKey,
    compactionEntryId,
    summary,
    createdAt: new Date().toISOString(),
  };
  pi.appendEntry(PENDING_BOOTSTRAP_CUSTOM_TYPE, data);
  return data;
}

function appendPendingBootstrapConsumedEntry(
  pi: EntryAppender,
  streamKey: string,
  compactionEntryId: string,
): PendingBootstrapConsumedEntryData {
  const data: PendingBootstrapConsumedEntryData = {
    version: 1,
    streamKey,
    compactionEntryId,
    consumedAt: new Date().toISOString(),
  };
  pi.appendEntry(PENDING_BOOTSTRAP_CONSUMED_CUSTOM_TYPE, data);
  return data;
}

function restorePendingBootstrapStateForStreamKey(
  sessionManager: SessionBranchReader,
  streamKey: string,
): PendingBootstrapState | undefined {
  let pending: PendingBootstrapState | undefined;

  for (const entry of sessionManager.getBranch()) {
    if (!entry || typeof entry !== "object" || entry.type !== "custom") {
      continue;
    }

    if (
      entry.customType === PENDING_BOOTSTRAP_CUSTOM_TYPE &&
      isPendingBootstrapEntryData(entry.data) &&
      entry.data.streamKey === streamKey
    ) {
      pending = entry.data;
      continue;
    }

    if (
      entry.customType === PENDING_BOOTSTRAP_CONSUMED_CUSTOM_TYPE &&
      isPendingBootstrapConsumedEntryData(entry.data) &&
      entry.data.streamKey === streamKey &&
      pending?.compactionEntryId === entry.data.compactionEntryId
    ) {
      pending = undefined;
    }
  }

  return pending;
}

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
  return (
    sid(event) ?? sid(event.result) ?? sid(event.metadata) ?? sid(event.event)
  );
}

function extractResultText(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  if (event.type !== "result") return undefined;

  const candidates = [
    event.result,
    event.output,
    event.text,
    event.message?.text,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return undefined;
}

function extractAssistantSnapshotText(
  event: any,
): { messageId: string; text: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  if (event.type !== "assistant") return undefined;
  const message = event.message;
  if (!message || typeof message !== "object") return undefined;
  if (typeof message.id !== "string" || message.id.length === 0)
    return undefined;
  if (!Array.isArray(message.content)) return undefined;

  const text = message.content
    .filter(
      (block: any) => block?.type === "text" && typeof block.text === "string",
    )
    .map((block: any) => block.text)
    .join("");

  if (!text) return undefined;
  return { messageId: message.id, text };
}

function extractAssistantSnapshotToolUses(
  event: any,
): { id: string; name: string; input?: unknown }[] {
  if (!event || typeof event !== "object") return [];
  if (event.type !== "assistant") return [];
  const message = event.message;
  if (!message || typeof message !== "object") return [];
  if (!Array.isArray(message.content)) return [];

  return message.content
    .filter(
      (block: any) =>
        block?.type === "tool_use" && typeof block.id === "string",
    )
    .map((block: any) => ({
      id: block.id,
      name: typeof block.name === "string" ? block.name : "unknown",
      input: block.input,
    }));
}

function extractUserToolResultIds(event: any): string[] {
  if (!event || typeof event !== "object") return [];
  if (event.type !== "user") return [];
  const message = event.message;
  if (!message || typeof message !== "object") return [];
  if (!Array.isArray(message.content)) return [];

  return message.content
    .filter(
      (block: any) =>
        block?.type === "tool_result" && typeof block.tool_use_id === "string",
    )
    .map((block: any) => block.tool_use_id);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

// Claude Code headless / `claude -p` gives us authoritative token buckets and a final
// total cost (`total_cost_usd`), but not an authoritative per-bucket USD breakdown.
// Be faithful to what the CLI actually reports: ingest token counts and the reported
// total, but do not invent input/output/cache cost components from external pricing.
function extractUsage(event: any): UsageLike | undefined {
  if (!event || typeof event !== "object") return undefined;

  const usage = event.usage ?? event.metadata?.usage ?? event.result?.usage;
  if (!usage || typeof usage !== "object") return undefined;

  const input = asNumber(usage.input ?? usage.input_tokens);
  const output = asNumber(usage.output ?? usage.output_tokens);
  const cacheRead = asNumber(
    usage.cacheRead ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens,
  );
  const cacheWrite = asNumber(
    usage.cacheWrite ??
      usage.cache_write_tokens ??
      usage.cache_creation_input_tokens,
  );
  const totalTokens = asNumber(
    usage.totalTokens ??
      usage.total_tokens ??
      (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
  );
  const costTotal = asNumber(
    usage.cost?.total ??
      usage.total_cost ??
      usage.total_cost_usd ??
      event.total_cost_usd,
  );

  return { input, output, cacheRead, cacheWrite, totalTokens, costTotal };
}

function applyUsage(
  output: AssistantMessage,
  usage?: UsageLike,
  model?: Model<Api>,
) {
  if (!usage) return;

  // Token buckets are mapped directly from Claude CLI fields.
  // Monetary fidelity rule for this provider:
  // - if Claude reports `total_cost_usd`, trust it as `usage.cost.total`
  // - do not infer per-bucket USD components from model pricing
  // Registered model pricing is intentionally zeroed below so any fallback cost
  // calculation preserves zero component costs rather than inventing them.
  output.usage.input = usage.input ?? output.usage.input;
  output.usage.output = usage.output ?? output.usage.output;
  output.usage.cacheRead = usage.cacheRead ?? output.usage.cacheRead;
  output.usage.cacheWrite = usage.cacheWrite ?? output.usage.cacheWrite;
  output.usage.totalTokens =
    usage.totalTokens ??
    output.usage.input +
      output.usage.output +
      output.usage.cacheRead +
      output.usage.cacheWrite;

  if (typeof usage.costTotal === "number") {
    output.usage.cost.total = usage.costTotal;
  } else if (model) {
    calculateCost(model, output.usage);
  }
}

function extractRateLimitInfo(event: any): RateLimitInfoLike | undefined {
  if (!event || typeof event !== "object") return undefined;
  if (event.type !== "rate_limit_event") return undefined;
  const info = event.rate_limit_info;
  if (!info || typeof info !== "object") return undefined;
  return {
    status: typeof info.status === "string" ? info.status : undefined,
    overageStatus:
      typeof info.overageStatus === "string" ? info.overageStatus : undefined,
    isUsingOverage:
      typeof info.isUsingOverage === "boolean"
        ? info.isUsingOverage
        : undefined,
    resetsAt: asNumber(info.resetsAt),
    overageResetsAt: asNumber(info.overageResetsAt),
    rateLimitType:
      typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
  };
}

function extractRunMetadata(event: any): RunMetadataLike | undefined {
  if (!event || typeof event !== "object") return undefined;
  const source = event.type === "result" ? event : event.result;
  if (!source || typeof source !== "object") return undefined;

  const durationMs = asNumber(source.duration_ms ?? source.durationMs);
  const numTurns = asNumber(source.num_turns ?? source.numTurns);
  if (durationMs === undefined && numTurns === undefined) return undefined;
  return { durationMs, numTurns };
}

function isRateLimitNotable(info?: RateLimitInfoLike): boolean {
  if (!info) return false;
  if (info.status && info.status !== "allowed") return true;
  if (info.overageStatus && info.overageStatus !== "allowed") return true;
  return info.isUsingOverage === true;
}

function formatRateLimitNotice(info?: RateLimitInfoLike): string | undefined {
  if (!isRateLimitNotable(info)) return undefined;
  const parts: string[] = [];
  if (info?.status) parts.push(`status=${info.status}`);
  if (info?.rateLimitType) parts.push(`type=${info.rateLimitType}`);
  if (info?.isUsingOverage) parts.push("using overage");
  if (info?.overageStatus && info.overageStatus !== "allowed")
    parts.push(`overage=${info.overageStatus}`);
  if (typeof info?.resetsAt === "number")
    parts.push(`resets=${new Date(info.resetsAt * 1000).toISOString()}`);
  if (typeof info?.overageResetsAt === "number") {
    parts.push(
      `overageResets=${new Date(info.overageResetsAt * 1000).toISOString()}`,
    );
  }
  return `[claude-code rate-limit: ${parts.join(", ")}]`;
}

function formatRunMetadata(
  durationMs?: number,
  numTurns?: number,
): string | undefined {
  if (durationMs === undefined && numTurns === undefined) return undefined;
  const parts: string[] = [];
  if (durationMs !== undefined)
    parts.push(`duration=${(durationMs / 1000).toFixed(1)}s`);
  if (numTurns !== undefined) parts.push(`turns=${numTurns}`);
  return `[claude-code: ${parts.join(", ")}]`;
}

function extractSystemInitInfo(event: any): SystemInitInfoLike | undefined {
  if (!event || typeof event !== "object") return undefined;
  if (event.type !== "system" || event.subtype !== "init") return undefined;

  const tools = Array.isArray(event.tools)
    ? event.tools.filter(
        (tool: unknown): tool is string => typeof tool === "string",
      )
    : [];
  const mcpServers = Array.isArray(event.mcp_servers)
    ? event.mcp_servers.map((server: any) => ({
        name: typeof server?.name === "string" ? server.name : "unknown",
        status: typeof server?.status === "string" ? server.status : "unknown",
      }))
    : [];

  return {
    sessionId: extractSessionId(event),
    model: typeof event.model === "string" ? event.model : undefined,
    claudeCodeVersion:
      typeof event.claude_code_version === "string"
        ? event.claude_code_version
        : undefined,
    tools,
    mcpServers,
    capturedAtMs: Date.now(),
  };
}

function parseJsonObject(value: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeTraceToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  switch (normalized) {
    case "read":
    case "edit":
    case "write":
    case "bash":
    case "grep":
    case "find":
    case "ls":
      return normalized;
    default:
      return name;
  }
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}…`;
}

function previewPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = compactWhitespace(value);
  if (!compact) return undefined;
  const normalized = compact.replace(/\\/g, "/");
  const base = path.basename(normalized);
  if (!base || base === normalized) return truncate(normalized, 72);
  const parent = path.basename(path.dirname(normalized));
  const short = parent && parent !== "." ? `${parent}/${base}` : base;
  return truncate(short, 72);
}

function formatGenericToolArgsPreview(
  input: unknown,
  maxLen = 220,
): string | undefined {
  if (input === undefined || input === null) return undefined;

  if (typeof input === "string") {
    const compact = compactWhitespace(input);
    return compact ? truncate(compact, maxLen) : undefined;
  }

  if (Array.isArray(input)) {
    return `items=${input.length}`;
  }

  if (typeof input !== "object") {
    return String(input);
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return undefined;

  const parts: string[] = [];
  for (const [key, value] of entries.slice(0, 5)) {
    if (value === undefined || value === null) continue;

    if (key.includes("path")) {
      const pathPreview = previewPath(value);
      if (pathPreview) {
        parts.push(`${key}=${pathPreview}`);
        continue;
      }
    }

    if (typeof value === "string") {
      const compact = compactWhitespace(value);
      if (compact) parts.push(`${key}=${truncate(compact, 56)}`);
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
      continue;
    }

    if (Array.isArray(value)) {
      parts.push(`${key}[${value.length}]`);
      continue;
    }

    if (typeof value === "object") {
      parts.push(`${key}={…}`);
    }
  }

  if (entries.length > 5) parts.push(`+${entries.length - 5} keys`);
  const text = parts.join(" ").trim();
  return text ? truncate(text, maxLen) : undefined;
}

function formatToolArgsPreview(
  toolName: string,
  input: unknown,
): string | undefined {
  const normalizedTool = toolName.trim().toLowerCase();
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;

  if (normalizedTool === "todowrite" && obj) {
    const todos = Array.isArray(obj.todos) ? obj.todos : [];
    if (todos.length > 0) {
      let completed = 0;
      let inProgress = 0;
      let pending = 0;
      for (const todo of todos) {
        const status =
          typeof (todo as any)?.status === "string" ? (todo as any).status : "";
        if (status === "completed") completed += 1;
        else if (status === "in_progress") inProgress += 1;
        else pending += 1;
      }
      return `todos=${todos.length} done=${completed} doing=${inProgress} pending=${pending}`;
    }
  }

  if (normalizedTool === "edit" && obj) {
    const parts: string[] = [];
    const filePreview = previewPath(obj.file_path);
    if (filePreview) parts.push(`file=${filePreview}`);
    if (typeof obj.replace_all === "boolean")
      parts.push(`replace_all=${obj.replace_all}`);
    if (typeof obj.old_string === "string")
      parts.push(`old=${obj.old_string.length}c`);
    if (typeof obj.new_string === "string")
      parts.push(`new=${obj.new_string.length}c`);
    const text = parts.join(" ");
    if (text) return text;
  }

  if (normalizedTool === "read" && obj) {
    const parts: string[] = [];
    const filePreview = previewPath(obj.file_path);
    if (filePreview) parts.push(`file=${filePreview}`);
    if (typeof obj.offset === "number") parts.push(`offset=${obj.offset}`);
    if (typeof obj.limit === "number") parts.push(`limit=${obj.limit}`);
    const text = parts.join(" ");
    if (text) return text;
  }

  if (normalizedTool === "write" && obj) {
    const parts: string[] = [];
    const filePreview = previewPath(obj.file_path);
    if (filePreview) parts.push(`file=${filePreview}`);
    if (typeof obj.content === "string")
      parts.push(`content=${obj.content.length}c`);
    const text = parts.join(" ");
    if (text) return text;
  }

  if (normalizedTool === "bash" && obj) {
    const parts: string[] = [];
    if (typeof obj.command === "string")
      parts.push(`cmd=${truncate(compactWhitespace(obj.command), 100)}`);
    if (typeof obj.timeout === "number") parts.push(`timeout=${obj.timeout}`);
    const text = parts.join(" ");
    if (text) return text;
  }

  return formatGenericToolArgsPreview(input);
}

type ToolTraceLogSource = "stream_event" | "assistant_snapshot";

type ToolTraceLogPayload = {
  source: ToolTraceLogSource;
  toolName: string;
  preview?: string;
  blockIndex?: number;
  toolId?: string;
  sequence?: number;
  initialInput?: unknown;
  finalInput?: unknown;
  rawDeltaJson?: string;
};

function debugToolTraceStart(payload: ToolTraceLogPayload): void {
  debugLog("tool_trace_start", {
    ...payload,
    normalizedToolName: normalizeTraceToolName(payload.toolName),
  });
}

function debugToolTraceEnd(payload: ToolTraceLogPayload): void {
  debugLog("tool_trace_end", {
    ...payload,
    normalizedToolName: normalizeTraceToolName(payload.toolName),
  });
}

function formatToolTraceLine(toolName: string, input: unknown): string {
  const normalizedToolName = normalizeTraceToolName(toolName);
  const preview = formatToolArgsPreview(normalizedToolName, input);
  return `↳ ${normalizedToolName}${preview ? ` — ${preview}` : ""}`;
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

  const messages = Array.isArray((context as any).messages)
    ? (context as any).messages
    : [];
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
  const textParts = msg.content
    .filter((c) => c.type === "text")
    .map((c) => c.text);
  const imageCount = msg.content.filter((c) => c.type === "image").length;
  let text = textParts.join("\n\n").trim() || "Continue.";
  if (imageCount > 0) {
    text += `\n\n[Note: ${imageCount} image attachment(s) were provided in Pi but are not forwarded by claude-code-provider v1.]`;
  }
  return text;
}

function cliModelFor(modelId: string): string {
  if (modelId.startsWith("claude-code-opus-4-6")) return OPUS46_CLI_MODEL;
  if (modelId.startsWith("claude-code-haiku-4-5")) return HAIKU45_CLI_MODEL;
  return SONNET46_CLI_MODEL; // default: Sonnet 4.6
}

function buildCompactSummaryPrompt(customInstructions?: string): string {
  const basePrompt = `Summarize the active work in this Claude Code session so a fresh Claude Code session can continue it seamlessly after compaction/rebase.

This is a carry-forward checkpoint, not a user-facing response. Do not continue the task. Do not ask follow-up questions. Do not use tools. Output only the structured summary below.

Use this exact format:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [User requirements, preferences, constraints]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blocking issues, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Most likely next action]
2. [Next action]
3. [Next action]

## Critical Context
- [Exact file paths, function/class names, errors, assumptions, unresolved questions, important modified/read files, or other details needed to continue]

Requirements:
- Preserve exact file paths, function names, error messages, and pending work when important.
- Include modified files and especially relevant/read files when helpful.
- Preserve unresolved questions, assumptions, and next steps.
- Keep the summary concise but continuation-ready.
- Output only the summary in the format above.`;

  const extra = customInstructions?.trim();
  if (!extra) return basePrompt;
  return `${basePrompt}\n\nAdditional compaction instructions:\n${extra}`;
}

function buildBootstrapUserPrompt(
  summary: string,
  currentUserRequest: string,
): string {
  return `Use the following carry-forward context from a previous Claude Code session as background context for this conversation. It is a checkpoint summary, not a separate task. Do not respond to or restate the summary unless the current request requires it.

<context-summary>
${summary.trim()}
</context-summary>

Focus on the current user request below.

<current-user-request>
${currentUserRequest.trim()}
</current-user-request>`;
}

function extractCompactSummaryText(response: any): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const candidates = [response.result, response.output, response.text];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

async function requestCompactSummaryFromClaudeSession(
  model: Model<Api>,
  rememberedSessionId: string,
  customInstructions?: string,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<string> {
  const cli = DEFAULT_CLAUDE_CLI;
  const timeoutMs =
    Number.isFinite(DEFAULT_TIMEOUT_SECONDS) && DEFAULT_TIMEOUT_SECONDS > 0
      ? Math.floor(DEFAULT_TIMEOUT_SECONDS * 1000)
      : 240_000;
  const cliModel = cliModelFor(model.id);
  const prompt = buildCompactSummaryPrompt(customInstructions);
  const args = [
    "-p",
    "--input-format",
    "text",
    "--output-format",
    "json",
    "--model",
    cliModel,
    "--resume",
    rememberedSessionId,
  ];

  debugLog("compact_cli_start", {
    cli,
    args,
    model: model.id,
    cliModel,
    resumeSessionId: rememberedSessionId,
  });

  let timeoutId: NodeJS.Timeout | undefined;
  let proc: ReturnType<typeof spawn> | undefined;
  let gotAbort = false;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const exitCode = await new Promise<number>((resolve) => {
    proc = spawn(cli, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let resolved = false;
    const resolveOnce = (code: number) => {
      if (resolved) return;
      resolved = true;
      if (signal) signal.removeEventListener("abort", killProc);
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
    if (signal) {
      if (signal.aborted) killProc();
      signal.addEventListener("abort", killProc);
    }

    try {
      proc.stdin?.end(prompt);
    } catch {
      // ignore stdin write errors; process error/exit handlers cover failures
    }

    proc.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk.toString("utf8"));
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      debugLog("compact_stderr", { text: text.trim() });
    });

    proc.on("error", (err) => {
      stderrChunks.push(`${err.message}\n`);
      resolveOnce(1);
    });

    proc.on("close", (code) => {
      resolveOnce(code ?? 0);
    });
  });

  if (timeoutId) clearTimeout(timeoutId);

  if (exitCode !== 0) {
    const trimmedStderr = stderrChunks.join("").trim();
    throw new Error(
      trimmedStderr ||
        (gotAbort || signal?.aborted
          ? "Claude CLI compact-summary request aborted"
          : `Claude CLI compact-summary request exited with code ${exitCode}`),
    );
  }

  const rawStdout = stdoutChunks.join("").trim();
  if (!rawStdout) {
    throw new Error("Claude CLI compact-summary request returned empty output");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    throw new Error("Claude CLI compact-summary request returned invalid JSON");
  }

  const summary = extractCompactSummaryText(parsed);
  if (!summary) {
    throw new Error(
      "Claude CLI compact-summary request did not return a usable summary",
    );
  }

  debugLog("compact_cli_done", {
    resumeSessionId: rememberedSessionId,
    summaryLength: summary.length,
  });

  return summary;
}

function streamClaudeCli(
  sessionMap: Map<string, string>,
  pendingBootstrapStateByStreamKey: Map<string, PendingBootstrapState>,
  initState: InitState,
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

    const FALLBACK_TEXT_BLOCK_KEY = -1;
    const textIndexByBlock = new Map<number, number>();
    const thinkingIndexByBlock = new Map<number, number>();
    const toolTraceNameByBlock = new Map<number, string>();
    const toolTraceSequenceByBlock = new Map<number, number>();
    const toolTraceInitialInputByBlock = new Map<number, unknown>();
    const toolTraceDeltaJsonByBlock = new Map<number, string>();
    let pendingTraceJoinContentIndex: number | undefined;
    let latestSessionId: string | undefined;
    let fallbackResultText = "";
    let latestRateLimitInfo: RateLimitInfoLike | undefined;
    let runDurationMs: number | undefined;
    let runNumTurns: number | undefined;
    const stderrChunks: string[] = [];
    let lineBuffer = "";
    let timeoutId: NodeJS.Timeout | undefined;
    let proc: ReturnType<typeof spawn> | undefined;
    let gotAbort = false;
    let acceptParsedLines = true;
    let sawResultEvent = false;
    let sawProseContent = false;
    let renderSource: "stream_event" | "assistant_snapshot" | undefined;
    let activeSnapshotMessageId: string | undefined;
    let activeSnapshotMessageText = "";
    let nextToolTraceSequence = 1;
    const snapshotToolById = new Map<
      string,
      { name: string; input?: unknown }
    >();
    const snapshotToolSequenceById = new Map<string, number>();

    const streamKey = getClaudeSessionStreamKey(model.id, options);
    const rememberedSessionId = sessionMap.get(streamKey);
    const pendingBootstrap = pendingBootstrapStateByStreamKey.get(streamKey);

    const cli = DEFAULT_CLAUDE_CLI;
    const timeoutMs =
      Number.isFinite(DEFAULT_TIMEOUT_SECONDS) && DEFAULT_TIMEOUT_SECONDS > 0
        ? Math.floor(DEFAULT_TIMEOUT_SECONDS * 1000)
        : 240_000;

    const cliModel = cliModelFor(model.id);
    const userPrompt = getLastUserText(context);
    const prompt =
      pendingBootstrap && !rememberedSessionId
        ? buildBootstrapUserPrompt(pendingBootstrap.summary, userPrompt)
        : userPrompt;
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
      const parts = [piSystemPrompt, globalPrompt].filter((p): p is string =>
        Boolean(p),
      );
      args.push("--system-prompt", parts.join("\n\n"));
    } else if (globalPrompt) {
      args.push("--append-system-prompt", globalPrompt);
    }

    if (rememberedSessionId) {
      args.push("--resume", rememberedSessionId);
    }

    const closeTextContentIndex = (contentIndex: number) => {
      const block = output.content[contentIndex] as {
        type: "text";
        text: string;
      };
      stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: output,
      });
    };

    const flushPendingTraceJoin = () => {
      if (pendingTraceJoinContentIndex === undefined) return;
      closeTextContentIndex(pendingTraceJoinContentIndex);
      pendingTraceJoinContentIndex = undefined;
    };

    const beginTextForBlock = (blockKey: number): number => {
      const existingContentIndex = textIndexByBlock.get(blockKey);
      if (existingContentIndex !== undefined) return existingContentIndex;

      if (pendingTraceJoinContentIndex !== undefined) {
        const contentIndex = pendingTraceJoinContentIndex;
        pendingTraceJoinContentIndex = undefined;
        textIndexByBlock.set(blockKey, contentIndex);
        return contentIndex;
      }

      output.content.push({ type: "text", text: "" });
      const contentIndex = output.content.length - 1;
      textIndexByBlock.set(blockKey, contentIndex);
      stream.push({ type: "text_start", contentIndex, partial: output });
      return contentIndex;
    };

    const appendTextByContentIndex = (contentIndex: number, delta: string) => {
      if (!delta) return;
      const block = output.content[contentIndex] as {
        type: "text";
        text: string;
      };
      block.text += delta;
      stream.push({ type: "text_delta", contentIndex, delta, partial: output });
    };

    const appendCategorizedText = (
      category: "prose" | "trace",
      text: string,
      blockKey = FALLBACK_TEXT_BLOCK_KEY,
    ) => {
      if (!text) return;
      const contentIndex = beginTextForBlock(blockKey);
      appendTextByContentIndex(contentIndex, text);
      if (category === "prose") sawProseContent = true;
    };

    const appendProseDelta = (
      delta: string,
      blockKey = FALLBACK_TEXT_BLOCK_KEY,
    ) => {
      appendCategorizedText("prose", delta, blockKey);
    };

    const appendTraceLine = (
      line: string,
      blockKey = FALLBACK_TEXT_BLOCK_KEY,
    ) => {
      appendCategorizedText("trace", `${line}\n`, blockKey);
    };

    const useRenderSource = (
      source: "stream_event" | "assistant_snapshot",
    ): boolean => {
      if (!renderSource) {
        renderSource = source;
      }
      return renderSource === source;
    };

    const endTextBlock = (blockKey: number) => {
      const contentIndex = textIndexByBlock.get(blockKey);
      if (contentIndex === undefined) return;
      closeTextContentIndex(contentIndex);
      textIndexByBlock.delete(blockKey);
    };

    const endAllTextBlocks = () => {
      flushPendingTraceJoin();
      for (const blockKey of Array.from(textIndexByBlock.keys())) {
        endTextBlock(blockKey);
      }
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
      const block = output.content[contentIndex] as {
        type: "thinking";
        thinking: string;
      };
      block.thinking += delta;
      stream.push({
        type: "thinking_delta",
        contentIndex,
        delta,
        partial: output,
      });
    };

    const endThinking = (blockIndex: number) => {
      const contentIndex = thinkingIndexByBlock.get(blockIndex);
      if (contentIndex === undefined) return;
      const block = output.content[contentIndex] as {
        type: "thinking";
        thinking: string;
      };
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: output,
      });
      thinkingIndexByBlock.delete(blockIndex);
    };

    const beginToolTrace = (
      blockIndex: number,
      toolName: string,
      initialInput?: unknown,
    ) => {
      const sequence = nextToolTraceSequence++;
      toolTraceNameByBlock.set(blockIndex, toolName);
      toolTraceSequenceByBlock.set(blockIndex, sequence);
      toolTraceInitialInputByBlock.set(blockIndex, initialInput);
      toolTraceDeltaJsonByBlock.set(blockIndex, "");
      const initialPreview = formatToolArgsPreview(toolName, initialInput);
      debugToolTraceStart({
        source: "stream_event",
        toolName,
        preview: initialPreview,
        blockIndex,
        sequence,
        initialInput,
      });
    };

    const appendToolTraceDelta = (blockIndex: number, delta: string) => {
      if (!delta) return;
      if (!toolTraceNameByBlock.has(blockIndex)) return;
      const existing = toolTraceDeltaJsonByBlock.get(blockIndex) || "";
      toolTraceDeltaJsonByBlock.set(blockIndex, existing + delta);
    };

    const endToolTrace = (blockIndex: number) => {
      const toolName = toolTraceNameByBlock.get(blockIndex);
      if (!toolName) return;
      const sequence = toolTraceSequenceByBlock.get(blockIndex);
      const initialInput = toolTraceInitialInputByBlock.get(blockIndex);
      const deltaJson = toolTraceDeltaJsonByBlock.get(blockIndex) || "";
      const parsedArgs = parseJsonObject(deltaJson);
      const finalArgs =
        parsedArgs ?? (deltaJson.trim().length > 0 ? deltaJson : initialInput);
      const preview = formatToolArgsPreview(toolName, finalArgs);
      debugToolTraceEnd({
        source: "stream_event",
        toolName,
        preview,
        blockIndex,
        sequence,
        initialInput,
        finalInput: finalArgs,
        rawDeltaJson: deltaJson || undefined,
      });
      appendTraceLine(formatToolTraceLine(toolName, finalArgs), blockIndex);
      toolTraceNameByBlock.delete(blockIndex);
      toolTraceSequenceByBlock.delete(blockIndex);
      toolTraceInitialInputByBlock.delete(blockIndex);
      toolTraceDeltaJsonByBlock.delete(blockIndex);
    };

    const beginSnapshotToolTrace = (
      id: string,
      name: string,
      input?: unknown,
    ) => {
      if (snapshotToolById.has(id)) return;
      const sequence = nextToolTraceSequence++;
      snapshotToolById.set(id, { name, input });
      snapshotToolSequenceById.set(id, sequence);
      const preview = formatToolArgsPreview(name, input);
      debugToolTraceStart({
        source: "assistant_snapshot",
        toolName: name,
        preview,
        toolId: id,
        sequence,
        initialInput: input,
      });
    };

    const endSnapshotToolTrace = (id: string) => {
      const snapshot = snapshotToolById.get(id);
      if (!snapshot) return;
      const sequence = snapshotToolSequenceById.get(id);
      const preview = formatToolArgsPreview(snapshot.name, snapshot.input);
      debugToolTraceEnd({
        source: "assistant_snapshot",
        toolName: snapshot.name,
        preview,
        toolId: id,
        sequence,
        finalInput: snapshot.input,
      });
      appendTraceLine(formatToolTraceLine(snapshot.name, snapshot.input));
      snapshotToolById.delete(id);
      snapshotToolSequenceById.delete(id);
    };

    debugLog("cli_start", {
      cli,
      args,
      model: model.id,
      cliModel,
      effort,
      resumeSessionId: rememberedSessionId,
      streamKey,
      usedPendingBootstrap: Boolean(pendingBootstrap && !rememberedSessionId),
      pendingBootstrapCompactionEntryId:
        pendingBootstrap && !rememberedSessionId
          ? pendingBootstrap.compactionEntryId
          : undefined,
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
          if (options?.signal)
            options.signal.removeEventListener("abort", killProc);
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
          if (!acceptParsedLines) return;
          const parsed = parseJsonLine(line);
          if (!parsed) return;
          if (sawResultEvent) return;

          debugLog("stdout_line", parsed);

          const sid = extractSessionId(parsed);
          if (sid) {
            latestSessionId = sid;
            debugLog("session_id", { sid, streamKey });
          }

          const usage = extractUsage(parsed);
          if (usage) debugLog("usage", usage);
          applyUsage(output, usage, model);

          const rateLimitInfo = extractRateLimitInfo(parsed);
          if (rateLimitInfo) {
            latestRateLimitInfo = rateLimitInfo;
            debugLog("rate_limit", rateLimitInfo);
          }

          const runMetadata = extractRunMetadata(parsed);
          if (runMetadata) {
            runDurationMs = runMetadata.durationMs ?? runDurationMs;
            runNumTurns = runMetadata.numTurns ?? runNumTurns;
            debugLog("run_metadata", runMetadata);
          }

          const systemInitInfo = extractSystemInitInfo(parsed);
          if (systemInitInfo) {
            initState.latest = systemInitInfo;
            debugLog("system_init", systemInitInfo);
          }

          const streamEvent =
            parsed.type === "stream_event" ? parsed.event : undefined;
          if (
            streamEvent?.type === "content_block_start" &&
            typeof streamEvent.index === "number"
          ) {
            if (streamEvent.content_block?.type === "thinking") {
              flushPendingTraceJoin();
              beginThinking(streamEvent.index);
              return;
            }

            if (
              streamEvent.content_block?.type === "text" &&
              useRenderSource("stream_event")
            ) {
              beginTextForBlock(streamEvent.index);
              return;
            }

            if (
              streamEvent.content_block?.type === "tool_use" &&
              useRenderSource("stream_event")
            ) {
              flushPendingTraceJoin();
              const rawToolName =
                typeof streamEvent.content_block.name === "string"
                  ? streamEvent.content_block.name
                  : "unknown";
              const toolName = normalizeTraceToolName(rawToolName);
              const initialArgs =
                streamEvent.content_block.input &&
                typeof streamEvent.content_block.input === "object" &&
                !Array.isArray(streamEvent.content_block.input)
                  ? streamEvent.content_block.input
                  : undefined;
              beginToolTrace(streamEvent.index, toolName, initialArgs);
              return;
            }
          }

          if (
            streamEvent?.type === "content_block_delta" &&
            typeof streamEvent.index === "number"
          ) {
            if (
              streamEvent.delta?.type === "thinking_delta" &&
              typeof streamEvent.delta.thinking === "string"
            ) {
              appendThinking(streamEvent.index, streamEvent.delta.thinking);
              return;
            }

            if (
              streamEvent.delta?.type === "text_delta" &&
              typeof streamEvent.delta.text === "string" &&
              useRenderSource("stream_event")
            ) {
              appendProseDelta(streamEvent.delta.text, streamEvent.index);
              return;
            }

            if (
              renderSource === "stream_event" &&
              streamEvent.delta?.type === "input_json_delta" &&
              typeof streamEvent.delta.partial_json === "string" &&
              streamEvent.delta.partial_json.length > 0 &&
              toolTraceNameByBlock.has(streamEvent.index)
            ) {
              appendToolTraceDelta(
                streamEvent.index,
                streamEvent.delta.partial_json,
              );
              return;
            }
          }

          if (
            streamEvent?.type === "content_block_stop" &&
            typeof streamEvent.index === "number"
          ) {
            if (thinkingIndexByBlock.has(streamEvent.index)) {
              endThinking(streamEvent.index);
              return;
            }

            if (
              renderSource === "stream_event" &&
              toolTraceNameByBlock.has(streamEvent.index)
            ) {
              endToolTrace(streamEvent.index);
              const contentIndex = textIndexByBlock.get(streamEvent.index);
              if (contentIndex !== undefined) {
                textIndexByBlock.delete(streamEvent.index);
                pendingTraceJoinContentIndex = contentIndex;
              }
              return;
            }

            if (
              renderSource === "stream_event" &&
              textIndexByBlock.has(streamEvent.index)
            ) {
              endTextBlock(streamEvent.index);
              return;
            }
          }

          const isTopLevelSnapshot = parsed.parent_tool_use_id == null;

          const snapshotText = isTopLevelSnapshot
            ? extractAssistantSnapshotText(parsed)
            : undefined;
          if (snapshotText && useRenderSource("assistant_snapshot")) {
            if (!activeSnapshotMessageId) {
              activeSnapshotMessageId = snapshotText.messageId;
            }

            if (snapshotText.messageId !== activeSnapshotMessageId) {
              debugLog("assistant_snapshot_ignored_message", {
                activeMessageId: activeSnapshotMessageId,
                incomingMessageId: snapshotText.messageId,
                incomingLength: snapshotText.text.length,
              });
            } else {
              const previous = activeSnapshotMessageText;
              if (snapshotText.text.startsWith(previous)) {
                const suffix = snapshotText.text.slice(previous.length);
                if (suffix) appendProseDelta(suffix);
              } else {
                debugLog("assistant_snapshot_rewrite", {
                  messageId: snapshotText.messageId,
                  previousLength: previous.length,
                  nextLength: snapshotText.text.length,
                });
              }
              activeSnapshotMessageText = snapshotText.text;
            }
          }

          const snapshotToolUses = isTopLevelSnapshot
            ? extractAssistantSnapshotToolUses(parsed)
            : [];
          if (
            snapshotToolUses.length > 0 &&
            useRenderSource("assistant_snapshot")
          ) {
            for (const toolUse of snapshotToolUses) {
              beginSnapshotToolTrace(
                toolUse.id,
                normalizeTraceToolName(toolUse.name),
                toolUse.input,
              );
            }
          }

          if (isTopLevelSnapshot && renderSource === "assistant_snapshot") {
            const toolResultIds = extractUserToolResultIds(parsed);
            for (const toolResultId of toolResultIds) {
              endSnapshotToolTrace(toolResultId);
            }
          }

          const resultText = extractResultText(parsed);
          if (resultText) fallbackResultText = resultText;
          if (parsed.type === "result") sawResultEvent = true;
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
          acceptParsedLines = false;
          resolveOnce(1);
        });

        proc.on("close", (code) => {
          if (lineBuffer.trim()) processLine(lineBuffer);
          acceptParsedLines = false;
          resolveOnce(code ?? 0);
        });
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (latestSessionId) {
        sessionMap.set(streamKey, latestSessionId);
      }

      if (!sawProseContent && fallbackResultText.trim()) {
        appendProseDelta(fallbackResultText);
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

      for (const blockIndex of Array.from(toolTraceNameByBlock.keys())) {
        endToolTrace(blockIndex);
      }
      for (const toolId of Array.from(snapshotToolById.keys())) {
        endSnapshotToolTrace(toolId);
      }

      const rateLimitNotice = formatRateLimitNotice(latestRateLimitInfo);
      if (rateLimitNotice) {
        debugLog("rate_limit_notice", { notice: rateLimitNotice });
      }

      const runMetaNotice = formatRunMetadata(runDurationMs, runNumTurns);
      if (runMetaNotice) {
        debugLog("run_metadata_notice", { notice: runMetaNotice });
      }

      endAllTextBlocks();
      output.stopReason = "stop";
      if (!output.usage.totalTokens) {
        output.usage.totalTokens =
          output.usage.input +
          output.usage.output +
          output.usage.cacheRead +
          output.usage.cacheWrite;
      }
      if (!output.usage.cost.total) {
        // Fallback stays zero because this provider does not infer cost components
        // beyond what Claude Code headless mode reports directly.
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
      endAllTextBlocks();
      output.stopReason =
        options?.signal?.aborted || gotAbort ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      debugLog("error", {
        message: output.errorMessage,
        stopReason: output.stopReason,
        stderr: stderrChunks.join(""),
      });
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export default function (pi: ExtensionAPI) {
  const sessionMap = new Map<string, string>();
  const initState: InitState = {};
  const pendingBootstrapStateByStreamKey = new Map<
    string,
    PendingBootstrapState
  >();
  const pendingBootstrapAwaitingCompactionBySession = new Map<
    string,
    { streamKey: string; summary: string }
  >();

  pi.registerProvider("claude-code", {
    baseUrl: "claude://local-cli",
    apiKey: "claude-code-local",
    api: "claude-code-api",

    models: [
      // Keep pricing components at zero on purpose.
      // Claude Code headless mode gives us real token buckets plus an authoritative
      // final `total_cost_usd`, but it does not expose an authoritative input/output/
      // cache USD breakdown. Leaving these at zero prevents Pi from synthesizing a
      // made-up component breakdown from external/public pricing tables.
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

    streamSimple: streamClaudeCli.bind(
      null,
      sessionMap,
      pendingBootstrapStateByStreamKey,
      initState,
    ),
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "claude-code") return;

    const streamKey = getClaudeSessionStreamKey(ctx.model.id);
    if (pendingBootstrapStateByStreamKey.has(streamKey)) return;

    const restored = restorePendingBootstrapStateForStreamKey(
      ctx.sessionManager,
      streamKey,
    );
    if (!restored) return;

    pendingBootstrapStateByStreamKey.set(streamKey, restored);
    debugLog("bootstrap_state_restored", {
      streamKey,
      compactionEntryId: restored.compactionEntryId,
      summaryLength: restored.summary.length,
    });
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== "claude-code") return undefined;

    const streamKey = getClaudeSessionStreamKey(ctx.model.id);
    const rememberedSessionId = sessionMap.get(streamKey);

    if (!rememberedSessionId) {
      ctx.ui.notify("No active Claude Code session to compact yet.", "info");
      return { cancel: true };
    }

    const sessionPersistenceKey =
      ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId();

    try {
      debugLog("compact_start", {
        streamKey,
        sessionPersistenceKey,
        rememberedSessionId,
      });

      const summary = await requestCompactSummaryFromClaudeSession(
        ctx.model,
        rememberedSessionId,
        event.customInstructions,
        event.signal,
        ctx.cwd,
      );

      pendingBootstrapAwaitingCompactionBySession.set(sessionPersistenceKey, {
        streamKey,
        summary,
      });

      debugLog("compact_summary_ready", {
        streamKey,
        sessionPersistenceKey,
        summaryLength: summary.length,
      });

      const { preparation } = event;
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pendingBootstrapAwaitingCompactionBySession.delete(sessionPersistenceKey);
      debugLog("compact_error", {
        streamKey,
        sessionPersistenceKey,
        message,
      });
      ctx.ui.notify(`Claude Code compact failed: ${message}`, "error");
      return { cancel: true };
    }
  });

  pi.on("session_compact", (event, ctx) => {
    if (ctx.model?.provider !== "claude-code") return;
    if (!event.fromExtension) return;

    const sessionPersistenceKey =
      ctx.sessionManager.getSessionFile() || ctx.sessionManager.getSessionId();
    const pending = pendingBootstrapAwaitingCompactionBySession.get(
      sessionPersistenceKey,
    );
    if (!pending) return;

    pendingBootstrapAwaitingCompactionBySession.delete(sessionPersistenceKey);
    sessionMap.delete(pending.streamKey);

    const persisted = appendPendingBootstrapEntry(
      pi,
      pending.streamKey,
      event.compactionEntry.id,
      pending.summary,
    );
    pendingBootstrapStateByStreamKey.set(pending.streamKey, persisted);

    debugLog("compact_checkpointed", {
      streamKey: pending.streamKey,
      sessionPersistenceKey,
      compactionEntryId: event.compactionEntry.id,
      summaryLength: pending.summary.length,
    });

    ctx.ui.notify(
      "Claude session checkpointed. Your next message will start a fresh Claude session from the compacted context.",
      "info",
    );
  });

  pi.registerCommand("claude-code-info", {
    description:
      "Show latest Claude Code init metadata (version/tools/MCP status)",
    handler: async (_args, ctx) => {
      const info = initState.latest;
      if (!info) {
        ctx.ui.notify(
          "No Claude Code init metadata captured yet. Run a Claude Code prompt first.",
          "warning",
        );
        return;
      }

      const toolsSummary =
        info.tools.length > 0
          ? `${info.tools.length} tools (${info.tools.slice(0, 8).join(", ")}${info.tools.length > 8 ? ", ..." : ""})`
          : "0 tools";
      const mcpSummary =
        info.mcpServers.length > 0
          ? info.mcpServers
              .map((server) => `${server.name}:${server.status}`)
              .join(", ")
          : "none";
      const capturedAt = new Date(info.capturedAtMs).toISOString();

      ctx.ui.notify(
        `claude-code info | version=${info.claudeCodeVersion || "unknown"} | model=${info.model || "unknown"} | ${toolsSummary} | mcp=${mcpSummary} | captured=${capturedAt}`,
        "info",
      );
    },
  });

  pi.registerCommand("claude-code-new-session", {
    description: "Clear stored Claude CLI session IDs to start a fresh session",
    handler: async (_args, ctx) => {
      sessionMap.clear();
      pendingBootstrapStateByStreamKey.clear();
      pendingBootstrapAwaitingCompactionBySession.clear();
      initState.latest = undefined;
      ctx.ui.notify("claude-code session map cleared", "info");
    },
  });
}
