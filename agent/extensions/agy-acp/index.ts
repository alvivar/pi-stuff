/**
 * agy-acp — bridges Google Antigravity CLI (`agy acp`) into Pi as a model provider.
 * agy runs its own coding tools internally (`--dangerously-skip-permissions` to match Pi),
 * while Pi extension tools (e.g. pi-link) are bridged via a local MCP server into Pi's native tool loop.
 * Env: AGY_BIN (optional path to the `agy` binary).
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ThinkingLevel,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderChatModelConfig } from "@earendil-works/pi-coding-agent";
import { AcpClient, resolveAgyBinary } from "./acp-client.ts";
import {
	type AgyActionsEntryData,
	type AgySyncState,
	type AgyToolRecord,
	buildNextSyncState,
	buildPromptPlan,
	collectBranchAgyActions,
	injectAgyActionsForHandoff,
	resolveBranchSyncState,
} from "./context-sync.ts";
import { MCP_SERVER_NAME, McpBridge, type McpToolResult, selectBridgedTools, toolSetKey } from "./mcp-bridge.ts";
import {
	type AgyPlanEntry,
	createLiveToolWidget,
	type LiveToolWidgetComponent,
	MAX_STORED_TOOLS,
	renderAgyActionsEntry,
	upsertAcpToolRecord,
} from "./tool-ui.ts";

const PROVIDER_NAME = "agy";
const API_NAME = "agy-acp";
const SYNC_ENTRY_TYPE = "agy-acp-sync";
const ACTIONS_ENTRY_TYPE = "agy-acp-actions";
const WIDGET_KEY = "agy-acp-live";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Prefix of Pi's SUMMARIZATION_SYSTEM_PROMPT used by /compact and /tree branch summarization.
const PI_SUMMARY_PROMPT_PREFIX = "You are a context summarization assistant.";
const MCP_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;

type AcpThoughtLevel = "low" | "medium" | "high" | "xhigh";

const THOUGHT_LEVEL_ORDER: AcpThoughtLevel[] = ["low", "medium", "high", "xhigh"];

interface ModelCatalogEntry {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	thoughtLevels: AcpThoughtLevel[];
}

interface SessionConfig {
	model?: string;
	thought?: string;
	thoughtOptions: AcpThoughtLevel[];
	mcpKey: string;
}

interface PendingMcpCall {
	callId: string;
	name: string;
	args: Record<string, unknown>;
	resolve: (result: McpToolResult) => void;
	reject: (err: Error) => void;
}

interface ActiveTurn {
	sessionId: string;
	cwd: string;
	startedAt: number;
	isSummaryCall: boolean;
	contextMessages: Message[];
	output: AssistantMessage;
	stream: AssistantMessageEventStream | null;
	openBlock: { index: number; type: "text" | "thinking" } | null;
	tools: AgyToolRecord[];
	toolStartTimes: Map<string, number>;
	ignoredToolCallIds: Set<string>;
	plan: AgyPlanEntry[];
	liveWidget?: LiveToolWidgetComponent;
	widgetMounted: boolean;
	contextUsed?: number;
	signal?: AbortSignal;
	detachAbort?: () => void;
	// MCP calls waiting to be emitted as Pi toolCalls on the next stream boundary.
	queuedMcpCalls: PendingMcpCall[];
	flushMcpTimer?: ReturnType<typeof setTimeout>;
	// MCP calls already emitted to Pi, awaiting matching ToolResultMessages in the next streamSimple call.
	awaitingResults: Map<string, PendingMcpCall>;
}

const DEFAULT_CATALOG: ModelCatalogEntry[] = [
	{ id: "gemini-4-neon", name: "Gemini 4 Neon", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: ["low", "medium", "high", "xhigh"] },
	{ id: "gemini-4-carbon", name: "Gemini 4 Carbon", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: ["low", "medium", "high"] },
	{ id: "gemini-4-argon", name: "Gemini 4 Argon", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: ["low", "medium", "high"] },
	{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: ["low", "medium", "high", "xhigh"] },
	{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: ["low", "medium", "high"] },
	{ id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: [] },
	{ id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: [] },
	{ id: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)", contextWindow: 1_048_576, maxTokens: 65_536, thoughtLevels: [] },
	{ id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 200_000, maxTokens: 64_000, thoughtLevels: ["low", "medium", "high"] },
	{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextWindow: 200_000, maxTokens: 64_000, thoughtLevels: ["low", "medium", "high"] },
	{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", contextWindow: 128_000, maxTokens: 32_768, thoughtLevels: [] },
];

function guessWindow(modelId: string): { contextWindow: number; maxTokens: number } {
	if (modelId.startsWith("claude-")) return { contextWindow: 200_000, maxTokens: 64_000 };
	if (modelId.startsWith("gpt-")) return { contextWindow: 128_000, maxTokens: 32_768 };
	return { contextWindow: 1_048_576, maxTokens: 65_536 };
}

function buildThinkingLevelMap(levels: AcpThoughtLevel[]): ProviderChatModelConfig["thinkingLevelMap"] {
	if (levels.length === 0) return undefined;
	return {
		off: null,
		minimal: null,
		low: levels.includes("low") ? "low" : null,
		medium: levels.includes("medium") ? "medium" : null,
		high: levels.includes("high") ? "high" : null,
		...(levels.includes("xhigh") ? { xhigh: "xhigh" } : {}),
	};
}

function toProviderModel(entry: ModelCatalogEntry): ProviderChatModelConfig {
	const thinkingLevelMap = buildThinkingLevelMap(entry.thoughtLevels);
	return {
		type: "chat",
		id: entry.id,
		name: entry.name,
		api: API_NAME,
		reasoning: entry.thoughtLevels.length > 0,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
	};
}

function parseCatalogFromSessionResult(res: any): ModelCatalogEntry[] {
	const configOptions: any[] = res?.configOptions ?? [];
	const modelOpt = configOptions.find((o) => o.id === "model" || o.category === "model");
	const availableModels: { modelId: string; name: string }[] = res?.models?.availableModels ?? [];
	if (!modelOpt?.options?.length) return DEFAULT_CATALOG;

	return modelOpt.options.map((opt: any) => {
		const id = String(opt.value);
		const levels = THOUGHT_LEVEL_ORDER.filter((lvl) => availableModels.some((m) => m.modelId === `${id}-${lvl}`));
		return { id, name: String(opt.name ?? id), ...guessWindow(id), thoughtLevels: levels };
	});
}

export function resolveThoughtLevel(
	requested: ThinkingLevel | undefined,
	available: AcpThoughtLevel[],
): AcpThoughtLevel | undefined {
	if (available.length === 0 || !requested) return undefined;
	const desired: AcpThoughtLevel = requested === "minimal" ? "low" : requested === "max" ? "xhigh" : requested;
	if (available.includes(desired)) return desired;
	for (let i = THOUGHT_LEVEL_ORDER.indexOf(desired) - 1; i >= 0; i--) {
		if (available.includes(THOUGHT_LEVEL_ORDER[i]!)) return THOUGHT_LEVEL_ORDER[i]!;
	}
	return available[0];
}

function mapStopReason(reason?: string): StopReason {
	switch (reason) {
		case "max_tokens":
			return "length";
		case "cancelled":
			return "aborted";
		default:
			return "stop";
	}
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function toolResultToMcp(msg: ToolResultMessage): McpToolResult {
	const content: McpToolResult["content"] = [];
	for (const part of msg.content) {
		if (part.type === "text") content.push({ type: "text", text: part.text });
		else if (part.type === "image") content.push({ type: "image", data: part.data, mimeType: part.mimeType });
	}
	if (content.length === 0) content.push({ type: "text", text: "" });
	return { content, isError: msg.isError };
}

function findContinuationResults(
	messages: Message[],
	awaitingIds: ReadonlySet<string>,
): { results: ToolResultMessage[]; steeredTexts: string[] } {
	// Walk back to the last assistant message so steered user messages (e.g. incoming pi-link chats)
	// appended after a toolResult do not break continuation matching.
	const results: ToolResultMessage[] = [];
	const steeredTexts: string[] = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant") break;
		if (m.role === "toolResult" && awaitingIds.has(m.toolCallId)) {
			results.unshift(m);
		} else if (m.role === "user") {
			const text =
				typeof m.content === "string"
					? m.content.trim()
					: m.content
							.filter((p) => p.type === "text")
							.map((p) => p.text)
							.join("\n")
							.trim();
			if (text) steeredTexts.unshift(text);
		}
	}
	return { results, steeredTexts };
}

export default function (pi: ExtensionAPI) {
	let client: AcpClient | undefined;
	let clientCwd: string | undefined;
	let starting: Promise<AcpClient> | undefined;
	const sessionConfigs = new Map<string, SessionConfig>();
	let syncState: AgySyncState | undefined;
	let activeCtx: ExtensionContext | undefined;
	let activeTurn: ActiveTurn | undefined;
	// Suppresses historical session/update notifications replayed during session/resume or session/load.
	let replaying = false;
	let nextMcpCallSeq = 1;

	const mcpBridge = new McpBridge((name, args) => handleBridgedToolCall(name, args));

	const clearWidget = () => {
		if (activeTurn) {
			activeTurn.liveWidget?.dispose();
			activeTurn.liveWidget = undefined;
			activeTurn.widgetMounted = false;
		}
		if (activeCtx?.hasUI) activeCtx.ui.setWidget(WIDGET_KEY, undefined);
	};

	const rejectPendingMcpCalls = (turn: ActiveTurn, reason: string) => {
		if (turn.flushMcpTimer) {
			clearTimeout(turn.flushMcpTimer);
			turn.flushMcpTimer = undefined;
		}
		const err = new Error(reason);
		for (const call of turn.queuedMcpCalls.splice(0)) call.reject(err);
		for (const call of turn.awaitingResults.values()) call.reject(err);
		turn.awaitingResults.clear();
	};

	const cancelActiveTurn = (reason = "Request was aborted") => {
		const turn = activeTurn;
		if (!turn) return;
		rejectPendingMcpCalls(turn, reason);
		if (client?.isAlive) {
			client.notify("session/cancel", { sessionId: turn.sessionId });
		}
	};

	const resetClient = () => {
		cancelActiveTurn("ACP client reset");
		clearWidget();
		client?.kill();
		client = undefined;
		starting = undefined;
		sessionConfigs.clear();
	};

	const shutdown = () => {
		resetClient();
		mcpBridge.close();
	};

	const reconstruct = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		syncState = resolveBranchSyncState(
			ctx.sessionManager.getBranch(),
			ctx.sessionManager.getEntries(),
			SYNC_ENTRY_TYPE,
			ctx.sessionManager.getSessionId(),
		);
	};

	pi.registerEntryRenderer<AgyActionsEntryData>(ACTIONS_ENTRY_TYPE, (entry, options, theme) =>
		renderAgyActionsEntry(entry.data, options, theme),
	);

	pi.on("context", async (event, ctx) => {
		if (ctx.model?.provider === PROVIDER_NAME) return;
		const actions = collectBranchAgyActions(ctx.sessionManager.getBranch(), ACTIONS_ENTRY_TYPE);
		const next = injectAgyActionsForHandoff(event.messages, actions, PROVIDER_NAME);
		return next ? { messages: next } : undefined;
	});

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));
	pi.on("before_agent_start", async (_e, ctx) => {
		activeCtx = ctx;
	});
	pi.on("agent_end", async () => {
		// If Pi ended the run while agy was paused awaiting a Pi toolResult (e.g. Esc during tool execution), abort agy.
		if (activeTurn && !activeTurn.stream) {
			cancelActiveTurn("Agent run ended before Pi tool result arrived");
		}
	});
	pi.on("session_shutdown", async () => {
		shutdown();
	});

	function updateSessionConfig(sessionId: string, configOptions?: any[], mcpKey?: string): SessionConfig {
		let cfg = sessionConfigs.get(sessionId);
		if (!cfg) {
			cfg = { thoughtOptions: [], mcpKey: mcpKey ?? "" };
			sessionConfigs.set(sessionId, cfg);
		}
		if (mcpKey !== undefined) cfg.mcpKey = mcpKey;
		if (Array.isArray(configOptions)) {
			for (const opt of configOptions) {
				if (opt.id === "model" && typeof opt.currentValue === "string") {
					cfg.model = opt.currentValue;
				} else if (opt.id === "thought_level") {
					if (typeof opt.currentValue === "string") cfg.thought = opt.currentValue;
					if (Array.isArray(opt.options)) {
						cfg.thoughtOptions = opt.options.map((o: any) => String(o.value) as AcpThoughtLevel);
					}
				}
			}
		}
		return cfg;
	}

	function closeOpenBlock(turn: ActiveTurn): void {
		if (!turn.openBlock || !turn.stream) return;
		const { index, type } = turn.openBlock;
		const block = turn.output.content[index];
		turn.openBlock = null;
		if (type === "text" && block?.type === "text") {
			turn.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: turn.output });
		} else if (type === "thinking" && block?.type === "thinking") {
			turn.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: turn.output });
		}
	}

	function appendBlock(turn: ActiveTurn, type: "text" | "thinking", delta: string): void {
		if (!delta || !turn.stream) return;
		if (turn.openBlock && turn.openBlock.type !== type) closeOpenBlock(turn);
		if (!turn.openBlock) {
			const index = turn.output.content.length;
			turn.output.content.push(type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			turn.openBlock = { index, type };
			turn.stream.push({ type: `${type}_start`, contentIndex: index, partial: turn.output });
		}
		const { index } = turn.openBlock;
		const block = turn.output.content[index]!;
		if (block.type === "text") {
			block.text += delta;
			turn.stream.push({ type: "text_delta", contentIndex: index, delta, partial: turn.output });
		} else if (block.type === "thinking") {
			block.thinking += delta;
			turn.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: turn.output });
		}
	}

	function flushQueuedMcpCalls(turn: ActiveTurn): void {
		if (!turn.stream || turn.queuedMcpCalls.length === 0) return;
		const batch = turn.queuedMcpCalls.splice(0);
		closeOpenBlock(turn);
		for (const call of batch) {
			const index = turn.output.content.length;
			const block = { type: "toolCall" as const, id: call.callId, name: call.name, arguments: call.args };
			turn.output.content.push(block);
			turn.stream.push({ type: "toolcall_start", contentIndex: index, partial: turn.output });
			turn.stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: JSON.stringify(call.args),
				partial: turn.output,
			});
			turn.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: turn.output });
			turn.awaitingResults.set(call.callId, call);
		}
		turn.output.stopReason = "toolUse";
		const finishedStream = turn.stream;
		turn.stream = null;
		turn.detachAbort?.();
		turn.detachAbort = undefined;
		clearWidget();
		finishedStream.push({ type: "done", reason: "toolUse", message: turn.output });
		finishedStream.end();
	}

	function scheduleMcpFlush(turn: ActiveTurn): void {
		// Brief tick batches parallel MCP calls from the same agy turn into one Pi toolUse message.
		if (!turn.stream || turn.queuedMcpCalls.length === 0 || turn.flushMcpTimer) return;
		turn.flushMcpTimer = setTimeout(() => {
			turn.flushMcpTimer = undefined;
			flushQueuedMcpCalls(turn);
		}, 10);
	}

	function handleBridgedToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		const turn = activeTurn;
		if (!turn || turn.isSummaryCall) {
			return Promise.resolve({
				content: [{ type: "text", text: "Pi tool bridge is unavailable during this turn." }],
				isError: true,
			});
		}
		return new Promise<McpToolResult>((resolve, reject) => {
			const callId = `pi_mcp_${nextMcpCallSeq++}`;
			turn.queuedMcpCalls.push({ callId, name, args, resolve, reject });
			scheduleMcpFlush(turn);
		});
	}

	function handleNotification(method: string, params: any): void {
		if (method !== "session/update") return;
		const sessionId = params?.sessionId;
		const u = params?.update ?? {};
		// Only update tracked sessions so throwaway sessions (e.g. refreshModels) never pollute cache.
		if (u.sessionUpdate === "config_option_update" && typeof sessionId === "string" && sessionConfigs.has(sessionId)) {
			updateSessionConfig(sessionId, u.configOptions);
		}
		if (replaying || !activeTurn || sessionId !== activeTurn.sessionId) return;

		const turn = activeTurn;
		switch (u.sessionUpdate) {
			case "agent_thought_chunk":
				if (u.content?.type === "text") appendBlock(turn, "thinking", String(u.content.text ?? ""));
				break;
			case "agent_message_chunk":
				if (u.content?.type === "text") appendBlock(turn, "text", String(u.content.text ?? ""));
				break;
			case "tool_call":
			case "tool_call_update": {
				// Bridged Pi tools render natively in Pi's transcript; track their ids so updates stay hidden too.
				const id = String(u.toolCallId ?? "");
				const rawName = String(u.name ?? "");
				const rawTitle = String(u.title ?? "");
				if (turn.ignoredToolCallIds.has(id) || rawName.startsWith(MCP_TOOL_PREFIX) || rawTitle.includes(MCP_TOOL_PREFIX)) {
					if (id) turn.ignoredToolCallIds.add(id);
					break;
				}

				closeOpenBlock(turn);
				upsertAcpToolRecord(turn.tools, u, turn.cwd, turn.toolStartTimes);
				updateLiveWidget(turn);
				break;
			}
			case "plan":
				turn.plan = (u.entries ?? []).map((e: any) => ({
					content: String(e.content ?? ""),
					status: String(e.status ?? "pending"),
				}));
				updateLiveWidget(turn);
				break;
			case "usage_update":
				if (typeof u.used === "number") turn.contextUsed = u.used;
				break;
		}
	}

	async function handleRequest(method: string, params: any): Promise<any> {
		if (method !== "session/request_permission") {
			throw Object.assign(new Error(`Method not supported: ${method}`), { code: -32601 });
		}
		const turn = activeTurn;
		if (!turn || turn.sessionId !== params?.sessionId || turn.signal?.aborted) {
			return { outcome: { outcome: "cancelled" } };
		}
		const allow = (params?.options ?? []).find((o: any) => String(o.kind).startsWith("allow"));
		return allow
			? { outcome: { outcome: "selected", optionId: allow.optionId } }
			: { outcome: { outcome: "cancelled" } };
	}

	async function getClient(cwd: string): Promise<AcpClient> {
		if (client?.isAlive && clientCwd === cwd) return client;
		if (starting && clientCwd === cwd) return starting;
		resetClient();
		clientCwd = cwd;
		const c = new AcpClient(resolveAgyBinary(), ["acp", "--dangerously-skip-permissions"], cwd);
		c.onNotification = handleNotification;
		c.onRequest = handleRequest;
		c.onExit = () => {
			if (client === c) {
				client = undefined;
				sessionConfigs.clear();
			}
		};
		starting = c.start().then(
			() => {
				client = c;
				starting = undefined;
				return c;
			},
			(err) => {
				starting = undefined;
				c.kill();
				throw err;
			},
		);
		return starting;
	}

	async function ensureAcpSession(
		c: AcpClient,
		cwd: string,
		mode: "continue" | "fresh",
		mcpServers: any[],
		mcpKey: string,
	): Promise<{ sessionId: string; resumed: boolean }> {
		if (mode === "continue" && syncState?.sessionId && syncState.cwd === cwd) {
			const existing = sessionConfigs.get(syncState.sessionId);
			if (existing) {
				// If Pi's active extension tools changed (e.g. /link-connect), close the old session and start fresh.
				if (existing.mcpKey === mcpKey) {
					return { sessionId: syncState.sessionId, resumed: true };
				}
				sessionConfigs.delete(syncState.sessionId);
				void c.request("session/close", { sessionId: syncState.sessionId }).catch(() => {});
			} else {
				const caps = c.initializeResult?.agentCapabilities ?? {};
				const attempts: [string, any][] = [];
				if (caps.sessionCapabilities?.resume) {
					attempts.push(["session/resume", { sessionId: syncState.sessionId, cwd, mcpServers }]);
				}
				if (caps.loadSession) {
					attempts.push(["session/load", { sessionId: syncState.sessionId, cwd, mcpServers }]);
				}
				for (const [method, params] of attempts) {
					try {
						replaying = true;
						const res: any = await c.request(method, params);
						updateSessionConfig(syncState.sessionId, res?.configOptions, mcpKey);
						return { sessionId: syncState.sessionId, resumed: true };
					} catch {
						// try next method or fall through to a fresh session
					} finally {
						replaying = false;
					}
				}
			}
		}

		const res: any = await c.request("session/new", { cwd, mcpServers });
		const sessionId = String(res.sessionId);
		updateSessionConfig(sessionId, res?.configOptions, mcpKey);
		return { sessionId, resumed: false };
	}

	async function applyModelAndThinking(
		c: AcpClient,
		sessionId: string,
		modelId: string,
		reasoning: ThinkingLevel | undefined,
	): Promise<void> {
		let cfg = sessionConfigs.get(sessionId) ?? updateSessionConfig(sessionId);

		if (cfg.model !== modelId) {
			const res: any = await c.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: modelId,
			});
			cfg = updateSessionConfig(sessionId, res?.configOptions);
			cfg.model = modelId;
		}

		const targetThought = resolveThoughtLevel(reasoning, cfg.thoughtOptions);
		if (targetThought && cfg.thought !== targetThought) {
			const res: any = await c.request("session/set_config_option", {
				sessionId,
				configId: "thought_level",
				value: targetThought,
			});
			cfg = updateSessionConfig(sessionId, res?.configOptions);
			cfg.thought = targetThought;
		}
	}

	function updateLiveWidget(turn: ActiveTurn): void {
		if (turn.isSummaryCall || !activeCtx?.hasUI || !turn.stream) return;
		if (turn.tools.length === 0 && turn.plan.length === 0) return;
		if (turn.liveWidget) {
			turn.liveWidget.update();
			return;
		}
		if (turn.widgetMounted) return;
		turn.widgetMounted = true;
		activeCtx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			const widget = createLiveToolWidget(tui, theme, turn);
			turn.liveWidget = widget;
			return widget;
		});
	}

	function attachAbort(turn: ActiveTurn, signal: AbortSignal | undefined): void {
		turn.detachAbort?.();
		turn.signal = signal;
		if (!signal) {
			turn.detachAbort = undefined;
			return;
		}
		const onAbort = () => cancelActiveTurn("Request was aborted");
		signal.addEventListener("abort", onAbort, { once: true });
		turn.detachAbort = () => signal.removeEventListener("abort", onAbort);
	}

	function resumePausedTurn(
		turn: ActiveTurn,
		model: Model<Api>,
		context: TranscriptContext,
		results: ToolResultMessage[],
		steeredTexts: string[],
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const output = createEmptyAssistantMessage(model);

		turn.contextMessages = context.messages;
		turn.output = output;
		turn.stream = stream;
		turn.openBlock = null;
		attachAbort(turn, options?.signal);

		stream.push({ type: "start", partial: output });

		if (options?.signal?.aborted) {
			turn.stream = null;
			output.stopReason = "aborted";
			output.errorMessage = "Request was aborted";
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			cancelActiveTurn("Request was aborted");
			return stream;
		}

		results.forEach((tr, idx) => {
			const pending = turn.awaitingResults.get(tr.toolCallId);
			if (!pending) return;
			turn.awaitingResults.delete(tr.toolCallId);
			const mcpResult = toolResultToMcp(tr);
			if (idx === results.length - 1 && steeredTexts.length > 0) {
				mcpResult.content.push({
					type: "text",
					text: `\n\n[Incoming message received in Pi while this tool ran:]\n${steeredTexts.join("\n\n")}`,
				});
			}
			pending.resolve(mcpResult);
		});

		// Never leave an unmatched parallel MCP call hanging if Pi skipped or aborted one of the batch.
		for (const orphaned of turn.awaitingResults.values()) {
			orphaned.resolve({
				content: [{ type: "text", text: "Tool call was skipped or produced no result in Pi." }],
				isError: true,
			});
		}
		turn.awaitingResults.clear();

		// If another MCP call arrived while Pi was busy running the previous batch, emit it now.
		scheduleMcpFlush(turn);

		return stream;
	}

	function streamAgy(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const systemPrompt = getCurrentSystemPrompt(context.messages);
		// Compaction and /tree branch summaries are one-off auxiliary calls, not chat turns.
		const isSummaryCall = systemPrompt?.startsWith(PI_SUMMARY_PROMPT_PREFIX) ?? false;

		// If agy is paused awaiting Pi toolResult(s) from our MCP bridge, resume that in-flight turn.
		if (!isSummaryCall && activeTurn && activeTurn.awaitingResults.size > 0) {
			const awaitingIds = new Set(activeTurn.awaitingResults.keys());
			const { results, steeredTexts } = findContinuationResults(context.messages, awaitingIds);
			if (results.length > 0) {
				return resumePausedTurn(activeTurn, model, context, results, steeredTexts, options);
			}
			cancelActiveTurn("Conversation diverged while awaiting Pi tool result");
		}

		const stream = createAssistantMessageEventStream();

		(async () => {
			const output = createEmptyAssistantMessage(model);
			const cwd = activeCtx?.cwd ?? process.cwd();
			let sessionId: string | undefined;
			let turn: ActiveTurn | undefined;

			try {
				if (options?.signal?.aborted) throw new Error("Request was aborted");

				let plan = buildPromptPlan(context.messages, isSummaryCall ? undefined : syncState, cwd);
				const c = await getClient(cwd);

				let mcpKey = "";
				let mcpServers: any[] = [];
				if (!isSummaryCall) {
					const bridged = selectBridgedTools(getCurrentTools(context.messages));
					mcpBridge.setTools(bridged);
					mcpKey = toolSetKey(bridged);
					if (bridged.length > 0) mcpServers = [await mcpBridge.getServerConfig()];
				}

				const session = await ensureAcpSession(c, cwd, isSummaryCall ? "fresh" : plan.mode, mcpServers, mcpKey);
				sessionId = session.sessionId;
				// If resume/load fell back to a new session (or tools changed), send full history instead of only the delta.
				if (!isSummaryCall && plan.mode === "continue" && !session.resumed) {
					plan = buildPromptPlan(context.messages, undefined, cwd);
				}

				await applyModelAndThinking(c, sessionId, model.id, options?.reasoning);

				const promptBlocks = isSummaryCall
					? [
							{
								type: "text" as const,
								text: `${systemPrompt}\n\nDo NOT use any tools, read files, or run commands. Only output the requested summary text.`,
							},
							...plan.prompt,
						]
					: plan.prompt;

				let payload: any = { sessionId, prompt: promptBlocks };
				if (options?.onPayload) {
					const replaced = await options.onPayload(payload, model);
					if (replaced && typeof replaced === "object") payload = replaced;
				}
				if (options?.signal?.aborted) throw new Error("Request was aborted");

				turn = {
					sessionId,
					cwd,
					startedAt: Date.now(),
					isSummaryCall,
					contextMessages: context.messages,
					output,
					stream,
					openBlock: null,
					tools: [],
					toolStartTimes: new Map(),
					ignoredToolCallIds: new Set(),
					plan: [],
					widgetMounted: false,
					queuedMcpCalls: [],
					awaitingResults: new Map(),
				};
				activeTurn = turn;
				attachAbort(turn, options?.signal);

				stream.push({ type: "start", partial: output });

				if (!isSummaryCall) {
					// Persist a WAL marker before mutating an existing ACP session so abort/crash+restart never reuses it.
					if (session.resumed) pi.appendEntry(SYNC_ENTRY_TYPE, { sessionId, pending: true });
					syncState = undefined;
				}
				const res: any = await c.request("session/prompt", payload);

				const finalStream = turn.stream;
				const finalOutput = turn.output;
				if (!finalStream) return;

				closeOpenBlock(turn);

				const u = res?.usage ?? {};
				const inputTokens = Number(u.inputTokens ?? 0);
				const outputTokens = Number(u.outputTokens ?? 0) + Number(u.thoughtTokens ?? 0);
				const cacheRead = Number(u.cachedReadTokens ?? 0);
				const cacheWrite = Number(u.cachedWriteTokens ?? 0);
				// Pi's context meter reads usage.totalTokens; usage_update.used is agy's real window occupancy
				// (res.usage.inputTokens can be cumulative across internal tool rounds).
				const totalTokens =
					typeof turn.contextUsed === "number" && turn.contextUsed > 0
						? turn.contextUsed
						: Number(u.totalTokens ?? inputTokens + outputTokens + cacheRead + cacheWrite);

				finalOutput.usage = {
					input: inputTokens,
					output: outputTokens,
					cacheRead,
					cacheWrite,
					totalTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};

				const aborted = turn.signal?.aborted ?? false;
				const stopReason = aborted ? "aborted" : mapStopReason(res?.stopReason);
				finalOutput.stopReason = stopReason;

				if (stopReason === "aborted") {
					finalOutput.errorMessage = "Request was aborted";
					finalStream.push({ type: "error", reason: "aborted", error: finalOutput });
					finalStream.end();
					return;
				}

				clearWidget();
				if (!isSummaryCall && turn.tools.length > 0) {
					pi.appendEntry<AgyActionsEntryData>(ACTIONS_ENTRY_TYPE, {
						assistantTimestamp: finalOutput.timestamp,
						tools: turn.tools.slice(0, MAX_STORED_TOOLS),
						totalCount: turn.tools.length,
						durationMs: Math.max(0, Date.now() - turn.startedAt),
					});
				}

				const piSessionId = activeCtx?.sessionManager.getSessionId();
				if (!isSummaryCall && piSessionId) {
					syncState = buildNextSyncState(turn.contextMessages, finalOutput, sessionId, cwd, piSessionId);
					pi.appendEntry(SYNC_ENTRY_TYPE, syncState);
				}

				finalStream.push({ type: "done", reason: stopReason, message: finalOutput });
				finalStream.end();
			} catch (err: any) {
				const errTurn = turn;
				const errStream = errTurn ? errTurn.stream : stream;
				const errOutput = errTurn ? errTurn.output : output;
				if (errTurn) {
					rejectPendingMcpCalls(errTurn, "agy turn failed");
					closeOpenBlock(errTurn);
				}
				if (errStream) {
					const aborted = (errTurn?.signal ?? options?.signal)?.aborted ?? false;
					errOutput.stopReason = aborted ? "aborted" : "error";
					errOutput.errorMessage = err instanceof Error ? err.message : String(err);
					errStream.push({ type: "error", reason: errOutput.stopReason, error: errOutput });
					errStream.end();
				}
			} finally {
				turn?.detachAbort?.();
				if (turn) rejectPendingMcpCalls(turn, "agy turn ended");
				clearWidget();
				if (activeTurn === turn) activeTurn = undefined;
				if (isSummaryCall && sessionId && client?.isAlive) {
					sessionConfigs.delete(sessionId);
					void client.request("session/close", { sessionId }).catch(() => {});
				}
			}
		})();

		return stream;
	}

	pi.registerProvider(PROVIDER_NAME, {
		name: "Antigravity (agy ACP)",
		baseUrl: "acp://agy",
		// Non-empty sentinel so Pi marks auth configured; agy handles Google authentication itself.
		apiKey: "agy-acp",
		api: API_NAME,
		models: DEFAULT_CATALOG.map(toProviderModel),
		async refreshModels() {
			// ACP has no standalone models/list endpoint; models are returned by session/new.
			const cwd = activeCtx?.cwd ?? process.cwd();
			const c = await getClient(cwd);
			const res: any = await c.request("session/new", { cwd, mcpServers: [] });
			const catalog = parseCatalogFromSessionResult(res);
			try {
				await c.request("session/close", { sessionId: res.sessionId });
			} catch {}
			return catalog.map(toProviderModel);
		},
		streamSimple: streamAgy,
	});
}
