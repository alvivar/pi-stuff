/**
 * agy-acp — bridges Google Antigravity CLI (`agy acp`) into Pi as a model provider.
 * agy runs its own tools internally (with `--dangerously-skip-permissions` to match Pi);
 * Pi owns the conversation tree and syncs turns via `context-sync.ts`.
 * Env: AGY_BIN (optional path to the `agy` binary).
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type ThinkingLevel,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderChatModelConfig } from "@earendil-works/pi-coding-agent";
import { AcpClient, resolveAgyBinary } from "./acp-client.ts";
import {
	type AgySyncState,
	type AgyToolRecord,
	buildNextSyncState,
	buildPromptPlan,
	formatToolSummaryForTranscript,
} from "./context-sync.ts";

const PROVIDER_NAME = "agy";
const API_NAME = "agy-acp";
const SYNC_ENTRY_TYPE = "agy-acp-sync";
const WIDGET_KEY = "agy-acp-live";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Prefix of Pi's SUMMARIZATION_SYSTEM_PROMPT used by /compact and /tree branch summarization.
const PI_SUMMARY_PROMPT_PREFIX = "You are a context summarization assistant.";

type AcpThoughtLevel = "low" | "medium" | "high" | "xhigh";

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
	availableModels: { modelId: string; name: string }[];
}

interface ActiveTurn {
	sessionId: string;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	openBlock: { index: number; type: "text" | "thinking" } | null;
	tools: AgyToolRecord[];
	plan: { content: string; status: string }[];
	contextUsed?: number;
	signal?: AbortSignal;
	onWidgetUpdate: () => void;
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

function toProviderModel(entry: ModelCatalogEntry): ProviderChatModelConfig {
	return {
		type: "chat",
		id: entry.id,
		name: entry.name,
		api: API_NAME,
		reasoning: entry.thoughtLevels.length > 0,
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

	const levelSuffixes: AcpThoughtLevel[] = ["low", "medium", "high", "xhigh"];
	const entries: ModelCatalogEntry[] = modelOpt.options.map((opt: any) => {
		const id = String(opt.value);
		const levels = levelSuffixes.filter((lvl) => availableModels.some((m) => m.modelId === `${id}-${lvl}`));
		return { id, name: String(opt.name ?? id), ...guessWindow(id), thoughtLevels: levels };
	});
	return entries.length > 0 ? entries : DEFAULT_CATALOG;
}

function resolveThoughtLevel(requested: ThinkingLevel | undefined, available: AcpThoughtLevel[]): AcpThoughtLevel | undefined {
	if (available.length === 0 || !requested) return undefined;
	const desired: AcpThoughtLevel = requested === "minimal" ? "low" : (requested as AcpThoughtLevel);
	if (available.includes(desired)) return desired;
	const order: AcpThoughtLevel[] = ["low", "medium", "high", "xhigh"];
	for (let i = order.indexOf(desired) - 1; i >= 0; i--) {
		if (available.includes(order[i]!)) return order[i]!;
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

	const clearWidget = () => {
		if (activeCtx?.hasUI) activeCtx.ui.setWidget(WIDGET_KEY, undefined);
	};

	const shutdown = () => {
		clearWidget();
		client?.kill();
		client = undefined;
		starting = undefined;
		sessionConfigs.clear();
	};

	const reconstruct = (ctx: ExtensionContext) => {
		activeCtx = ctx;
		syncState = undefined;
		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			if (entry.type === "custom" && entry.customType === SYNC_ENTRY_TYPE && entry.data?.sessionId) {
				syncState = entry.data as AgySyncState;
			}
		}
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));
	pi.on("before_agent_start", async (_e, ctx) => {
		activeCtx = ctx;
	});
	pi.on("session_shutdown", async () => {
		shutdown();
	});

	function updateSessionConfig(sessionId: string, configOptions?: any[], availableModels?: { modelId: string; name: string }[]): SessionConfig {
		let cfg = sessionConfigs.get(sessionId);
		if (!cfg) {
			cfg = { thoughtOptions: [], availableModels: [] };
			sessionConfigs.set(sessionId, cfg);
		}
		if (availableModels) cfg.availableModels = availableModels;
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
		if (!turn.openBlock) return;
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
		if (!delta) return;
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
				closeOpenBlock(turn);
				const id = String(u.toolCallId ?? "");
				const existing = turn.tools.find((t) => t.id === id);
				if (existing) {
					if (u.title) existing.title = String(u.title);
					if (u.kind) existing.kind = String(u.kind);
					if (u.status) existing.status = String(u.status);
				} else {
					turn.tools.push({
						id,
						title: String(u.title ?? u.name ?? "tool"),
						kind: u.kind ? String(u.kind) : undefined,
						status: u.status ? String(u.status) : "in_progress",
					});
				}
				turn.onWidgetUpdate();
				break;
			}
			case "plan":
				turn.plan = (u.entries ?? []).map((e: any) => ({
					content: String(e.content ?? ""),
					status: String(e.status ?? "pending"),
				}));
				turn.onWidgetUpdate();
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
		shutdown();
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
	): Promise<{ sessionId: string; resumed: boolean }> {
		if (mode === "continue" && syncState?.sessionId && syncState.cwd === cwd) {
			if (sessionConfigs.has(syncState.sessionId)) {
				return { sessionId: syncState.sessionId, resumed: true };
			}
			const caps = c.initializeResult?.agentCapabilities ?? {};
			const attempts: [string, any][] = [];
			if (caps.sessionCapabilities?.resume) {
				attempts.push(["session/resume", { sessionId: syncState.sessionId, cwd, mcpServers: [] }]);
			}
			if (caps.loadSession) {
				attempts.push(["session/load", { sessionId: syncState.sessionId, cwd, mcpServers: [] }]);
			}
			for (const [method, params] of attempts) {
				try {
					replaying = true;
					const res: any = await c.request(method, params);
					updateSessionConfig(syncState.sessionId, res?.configOptions, res?.models?.availableModels);
					return { sessionId: syncState.sessionId, resumed: true };
				} catch {
					// try next method or fall through to a fresh session
				} finally {
					replaying = false;
				}
			}
		}

		const res: any = await c.request("session/new", { cwd, mcpServers: [] });
		const sessionId = String(res.sessionId);
		updateSessionConfig(sessionId, res?.configOptions, res?.models?.availableModels);
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
			try {
				const res: any = await c.request("session/set_config_option", {
					sessionId,
					configId: "model",
					value: modelId,
				});
				cfg = updateSessionConfig(sessionId, res?.configOptions);
				cfg.model = modelId;
			} catch (err: any) {
				if (err?.code !== -32601) throw err;
				const fallbackLevel = resolveThoughtLevel(reasoning, ["low", "medium", "high", "xhigh"]);
				const candidate = fallbackLevel ? `${modelId}-${fallbackLevel}` : modelId;
				const exact = cfg.availableModels.find((m) => m.modelId === candidate || m.modelId === modelId);
				await c.request("session/set_model", { sessionId, modelId: exact?.modelId ?? modelId });
				cfg.model = modelId;
				return;
			}
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

	function renderLiveWidget(turn: ActiveTurn): void {
		if (!activeCtx?.hasUI) return;
		const lines: string[] = [];
		const shownTools = turn.tools.slice(-6);
		if (turn.tools.length > shownTools.length) {
			lines.push(`  … ${turn.tools.length - shownTools.length} earlier agy actions`);
		}
		for (const t of shownTools) {
			const icon = t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : "…";
			const kind = t.kind ? `[${t.kind}] ` : "";
			lines.push(`  ${icon} ${kind}${t.title}`);
		}
		if (turn.plan.length > 0) {
			const done = turn.plan.filter((p) => p.status === "completed").length;
			const active = turn.plan.find((p) => p.status === "in_progress");
			lines.push(`  plan ${done}/${turn.plan.length}${active ? ` · ${active.content}` : ""}`);
		}
		activeCtx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
	}

	function streamAgy(
		model: Model<Api>,
		context: TranscriptContext,
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
				stopReason: "pending",
				timestamp: Date.now(),
			};

			const cwd = activeCtx?.cwd ?? process.cwd();
			const systemPrompt = getCurrentSystemPrompt(context.messages);
			// Compaction and /tree branch summaries are one-off auxiliary calls, not chat turns.
			const isSummaryCall = systemPrompt?.startsWith(PI_SUMMARY_PROMPT_PREFIX) ?? false;
			let widgetTimer: ReturnType<typeof setTimeout> | undefined;
			let sessionId: string | undefined;

			const onAbort = () => {
				if (sessionId && client?.isAlive) {
					client.notify("session/cancel", { sessionId });
				}
			};

			try {
				if (options?.signal?.aborted) throw new Error("Request was aborted");

				let plan = buildPromptPlan(context.messages, isSummaryCall ? undefined : syncState, cwd);
				const c = await getClient(cwd);
				const session = await ensureAcpSession(c, cwd, isSummaryCall ? "fresh" : plan.mode);
				sessionId = session.sessionId;
				// If resume/load fell back to a new session, send full history instead of only the delta.
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

				const turn: ActiveTurn = {
					sessionId,
					output,
					stream,
					openBlock: null,
					tools: [],
					plan: [],
					signal: options?.signal,
					onWidgetUpdate: () => {
						if (isSummaryCall || widgetTimer) return;
						widgetTimer = setTimeout(() => {
							widgetTimer = undefined;
							if (activeTurn === turn) renderLiveWidget(turn);
						}, 100);
					},
				};
				activeTurn = turn;
				options?.signal?.addEventListener("abort", onAbort, { once: true });

				stream.push({ type: "start", partial: output });

				const res: any = await c.request("session/prompt", payload);

				if (!isSummaryCall && turn.tools.length > 0) {
					appendBlock(turn, "text", formatToolSummaryForTranscript(turn.tools));
				}
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

				output.usage = {
					input: inputTokens,
					output: outputTokens,
					cacheRead,
					cacheWrite,
					totalTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};

				const stopReason = options?.signal?.aborted ? "aborted" : mapStopReason(res?.stopReason);
				output.stopReason = stopReason;

				if (stopReason === "aborted") {
					output.errorMessage = "Request was aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
					stream.end();
					return;
				}

				if (!isSummaryCall) {
					syncState = buildNextSyncState(context.messages, output, sessionId, cwd);
					pi.appendEntry(SYNC_ENTRY_TYPE, syncState);
				}

				stream.push({ type: "done", reason: stopReason, message: output });
				stream.end();
			} catch (err: any) {
				if (activeTurn) closeOpenBlock(activeTurn);
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = err instanceof Error ? err.message : String(err);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end();
			} finally {
				options?.signal?.removeEventListener("abort", onAbort);
				if (widgetTimer) clearTimeout(widgetTimer);
				clearWidget();
				if (activeTurn?.output === output) activeTurn = undefined;
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
