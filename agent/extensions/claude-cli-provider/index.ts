import { spawn } from "node:child_process";
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

type CliEffort = "low" | "medium" | "high";

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costTotal?: number;
};

function mapReasoningToCliEffort(reasoning?: SimpleStreamOptions["reasoning"]): CliEffort | undefined {
	switch (reasoning) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
		case "xhigh":
			return "high";
		default:
			return undefined;
	}
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
	const candidates = [
		event.session_id,
		event.sessionId,
		event.result?.session_id,
		event.result?.sessionId,
		event.metadata?.session_id,
		event.metadata?.sessionId,
		event.event?.session_id,
		event.event?.sessionId,
	];
	for (const value of candidates) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function extractTextDelta(event: any): string | undefined {
	if (!event || typeof event !== "object") return undefined;

	// Claude CLI stream-json format
	if (event.type === "stream_event") {
		const delta = event.event?.delta;
		if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text;

		// Fallbacks for potential event shapes
		if (typeof event.event?.text === "string") return event.event.text;
	}

	// Generic fallback if the CLI format shifts
	if (event.event?.delta?.type === "text_delta" && typeof event.event?.delta?.text === "string") {
		return event.event.delta.text;
	}

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

function getLastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role !== "user") continue;

		if (typeof msg.content === "string") return msg.content.trim() || "Continue.";

		const textParts = msg.content.filter((c) => c.type === "text").map((c) => c.text);
		const imageCount = msg.content.filter((c) => c.type === "image").length;
		let text = textParts.join("\n\n").trim();
		if (!text) text = "Continue.";
		if (imageCount > 0) {
			text += `\n\n[Note: ${imageCount} image attachment(s) were provided in Pi but are not forwarded by claude-cli-provider v1.]`;
		}
		return text;
	}
	return "Continue.";
}

function modelCliConfig(modelId: string): { cliModel: string; allowedTools: string } {
	if (modelId.startsWith("claude-cli-sonnet-4-6")) {
		return { cliModel: SONNET46_CLI_MODEL, allowedTools: DEFAULT_ALLOWED_TOOLS };
	}
	if (modelId.startsWith("claude-cli-opus-4-6")) {
		return { cliModel: OPUS46_CLI_MODEL, allowedTools: DEFAULT_ALLOWED_TOOLS };
	}
	if (modelId.startsWith("claude-cli-haiku-4-5")) {
		return { cliModel: HAIKU45_CLI_MODEL, allowedTools: DEFAULT_ALLOWED_TOOLS };
	}

	// Fallback to Sonnet 4.6
	return { cliModel: SONNET46_CLI_MODEL, allowedTools: DEFAULT_ALLOWED_TOOLS };
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
		let latestSessionId: string | undefined;
		let fallbackResultText = "";
		let stderr = "";
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

		const { cliModel, allowedTools } = modelCliConfig(model.id);
		const prompt = getLastUserText(context);
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
			allowedTools,
		];

		if (effort) {
			args.push("--effort", effort);
		}

		if (GLOBAL_APPEND_SYSTEM_PROMPT) {
			args.push("--append-system-prompt", GLOBAL_APPEND_SYSTEM_PROMPT);
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
					if (options?.signal) options.signal.removeEventListener("abort", abortHandler);
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

				const abortHandler = () => killProc();

				if (timeoutMs > 0) {
					timeoutId = setTimeout(killProc, timeoutMs);
				}
				if (options?.signal) {
					if (options.signal.aborted) killProc();
					options.signal.addEventListener("abort", abortHandler);
				}

				try {
					proc.stdin?.end(prompt);
				} catch {
					// ignore stdin write errors; process error/exit handlers cover failures
				}

				const processLine = (line: string) => {
					const parsed = parseJsonLine(line);
					if (!parsed) return;

					const sid = extractSessionId(parsed);
					if (sid) latestSessionId = sid;

					const usage = extractUsage(parsed);
					applyUsage(output, usage, model);

					const delta = extractTextDelta(parsed);
					if (delta) {
						appendText(delta);
						return;
					}

					const resultText = extractResultText(parsed);
					if (resultText) fallbackResultText = resultText;
				};

				proc.stdout.on("data", (chunk) => {
					const text = chunk.toString();
					lineBuffer += text;
					const lines = lineBuffer.split(/\r?\n/);
					lineBuffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});

				proc.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});

				proc.on("error", (err) => {
					stderr += `${err.message}\n`;
					resolveOnce(1);
				});

				proc.on("close", (code) => {
					if (lineBuffer.trim()) {
						const parsed = parseJsonLine(lineBuffer);
						if (parsed) {
							const sid = extractSessionId(parsed);
							if (sid) latestSessionId = sid;
							const usage = extractUsage(parsed);
							applyUsage(output, usage, model);
							const resultText = extractResultText(parsed);
							if (resultText) fallbackResultText = resultText;
						}
					}
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
				const trimmedStderr = stderr.trim();
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
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
		} catch (error) {
			if (timeoutId) clearTimeout(timeoutId);
			endTextIfNeeded();
			output.stopReason = options?.signal?.aborted || gotAbort ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	const sessionMap = new Map<string, string>();

	pi.registerProvider("claude-cli", {
		baseUrl: "claude://local-cli",
		apiKey: "claude-cli-local",
		api: "claude-cli-api",

		models: [
			{
				id: "claude-cli-sonnet-4-6",
				name: "Claude CLI Sonnet 4.6",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
			{
				id: "claude-cli-opus-4-6",
				name: "Claude CLI Opus 4.6",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
			{
				id: "claude-cli-haiku-4-5",
				name: "Claude CLI Haiku 4.5",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 32000,
			},
		],

		streamSimple: (model, context, options) => streamClaudeCli(sessionMap, model, context, options),
	});

	pi.registerCommand("claude-cli-reset", {
		description: "Reset claude-cli provider resume/session cache",
		handler: async (_args, ctx) => {
			sessionMap.clear();
			ctx.ui.notify("claude-cli session map cleared", "info");
		},
	});
}
