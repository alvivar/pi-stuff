/**
 * Ephemeral localhost Streamable HTTP MCP server that exposes Pi extension tools to `agy acp`.
 * Runs in-process with Pi (loopback-only, random bearer token) and delegates each `tools/call`
 * to a callback so `index.ts` can bounce the call through Pi's native `toolUse` loop.
 */
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { Tool } from "@earendil-works/pi-ai";

export const MCP_SERVER_NAME = "pi";

export interface McpToolResult {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
	isError?: boolean;
}

export type McpCallHandler = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;

const AGY_NATIVE_TOOLS = new Set(["read", "write", "edit", "bash"]);

export function selectBridgedTools(tools: Tool[]): Tool[] {
	return tools.filter((t) => !AGY_NATIVE_TOOLS.has(t.name));
}

export function toolSetKey(tools: Tool[]): string {
	return tools
		.map((t) => t.name)
		.sort()
		.join(",");
}

function toInputSchema(parameters: unknown): Record<string, unknown> {
	if (parameters && typeof parameters === "object") {
		const schema = parameters as Record<string, unknown>;
		return {
			type: "object",
			...schema,
			properties: (schema.properties as Record<string, unknown> | undefined) ?? {},
		};
	}
	return { type: "object", properties: {} };
}

function sanitizeArgs(tool: Tool, rawArgs: unknown): Record<string, unknown> {
	if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return {};
	const args = { ...(rawArgs as Record<string, unknown>) };
	// agy injects `toolSummary` on MCP tool calls; strip it unless the Pi tool schema declares it.
	const props = (tool.parameters as Record<string, any> | undefined)?.properties;
	if ("toolSummary" in args && (!props || !("toolSummary" in props))) {
		delete args.toolSummary;
	}
	return args;
}

export class McpBridge {
	private server: http.Server | undefined;
	private listening: Promise<void> | undefined;
	private port = 0;
	private readonly token = randomBytes(24).toString("hex");
	private tools: Tool[] = [];
	private readonly onToolCall: McpCallHandler;

	constructor(onToolCall: McpCallHandler) {
		this.onToolCall = onToolCall;
	}

	setTools(tools: Tool[]): void {
		this.tools = tools;
	}

	async getServerConfig(): Promise<{
		name: string;
		type: "http";
		url: string;
		headers: { name: string; value: string }[];
	}> {
		await this.ensureListening();
		return {
			name: MCP_SERVER_NAME,
			type: "http",
			url: `http://127.0.0.1:${this.port}/mcp`,
			headers: [{ name: "Authorization", value: `Bearer ${this.token}` }],
		};
	}

	close(): void {
		this.listening = undefined;
		if (!this.server) return;
		try {
			this.server.closeAllConnections();
			this.server.close();
		} catch {}
		this.server = undefined;
		this.port = 0;
	}

	private async ensureListening(): Promise<void> {
		if (this.server) return;
		if (this.listening) return this.listening;
		const server = http.createServer((req, res) => {
			void this.handleHttp(req, res);
		});
		const startPromise = new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		}).then(
			() => {
				if (this.listening !== startPromise) {
					server.close();
					throw new Error("MCP bridge closed during startup");
				}
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					server.close();
					this.listening = undefined;
					throw new Error("Failed to bind local MCP bridge port");
				}
				this.server = server;
				this.port = addr.port;
				this.listening = undefined;
			},
			(err) => {
				if (this.listening === startPromise) this.listening = undefined;
				throw err;
			},
		);
		this.listening = startPromise;
		return startPromise;
	}

	private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (req.headers.authorization !== `Bearer ${this.token}`) {
			res.writeHead(401).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}

		let body = "";
		for await (const chunk of req) body += chunk;

		let msg: any;
		try {
			msg = JSON.parse(body);
		} catch {
			res.writeHead(400).end();
			return;
		}

		// JSON-RPC notifications (no id) get 202 Accepted with empty body.
		if (msg.id === undefined) {
			res.writeHead(202).end();
			return;
		}

		try {
			const result = await this.handleRpc(msg.method, msg.params);
			if (res.writableEnded || res.destroyed) return;
			res.writeHead(200, { "Content-Type": "application/json" }).end(
				JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }),
			);
		} catch (err: any) {
			if (res.writableEnded || res.destroyed) return;
			res.writeHead(200, { "Content-Type": "application/json" }).end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: typeof err?.code === "number" ? err.code : -32603, message: String(err?.message ?? err) },
				}),
			);
		}
	}

	private async handleRpc(method: string, params: any): Promise<any> {
		switch (method) {
			case "initialize":
				return {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "pi-agy-mcp-bridge", version: "0.1.0" },
				};
			case "ping":
				return {};
			case "tools/list":
				return {
					tools: this.tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: toInputSchema(t.parameters),
					})),
				};
			case "tools/call": {
				const name = String(params?.name ?? "");
				const tool = this.tools.find((t) => t.name === name);
				if (!tool) {
					return { content: [{ type: "text", text: `Unknown Pi tool: ${name}` }], isError: true };
				}
				return this.onToolCall(name, sanitizeArgs(tool, params?.arguments));
			}
			default:
				throw Object.assign(new Error(`Method not supported: ${method}`), { code: -32601 });
		}
	}
}
