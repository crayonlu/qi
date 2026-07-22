import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { workflowController } from "../controller.ts";
import { type McpConnectionStatus, type McpServerState, setMcpEnabled, upsertMcpServer } from "../domain/index.ts";

export interface McpServerConfig {
	name: string;
	transport: "stdio" | "sse" | "http" | "unknown";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	sourcePath: string;
}

interface LiveMcp {
	child: ChildProcess;
	tools: string[];
	buffer: string;
	pending: Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (err: Error) => void;
		}
	>;
	nextId: number;
}

const MCP_PROTOCOL_VERSION = "2024-11-05";

function configCandidates(cwd: string): string[] {
	return [
		join(cwd, ".mcp.json"),
		join(cwd, ".pi", "mcp.json"),
		join(homedir(), ".pi", "agent", "mcp.json"),
		join(homedir(), ".config", "mcp", "mcp.json"),
	];
}

function parseServers(path: string): McpServerConfig[] {
	if (!existsSync(path)) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	if (!raw || typeof raw !== "object") return [];
	const root = raw as Record<string, unknown>;
	const servers = (root.mcpServers ?? root.servers) as Record<string, unknown> | undefined;
	if (!servers || typeof servers !== "object") return [];

	const out: McpServerConfig[] = [];
	for (const [name, value] of Object.entries(servers)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		const command = typeof entry.command === "string" ? entry.command : undefined;
		const url =
			typeof entry.url === "string" ? entry.url : typeof entry.serverUrl === "string" ? entry.serverUrl : undefined;
		const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : undefined;
		const env =
			entry.env && typeof entry.env === "object"
				? Object.fromEntries(
						Object.entries(entry.env as Record<string, unknown>).filter(
							(pair): pair is [string, string] => typeof pair[1] === "string",
						),
					)
				: undefined;

		let transport: McpServerConfig["transport"] = "unknown";
		if (command) transport = "stdio";
		else if (url) {
			const type =
				typeof entry.type === "string" ? entry.type : typeof entry.transport === "string" ? entry.transport : "";
			transport = type === "sse" ? "sse" : "http";
		}

		out.push({ name, transport, command, args, env, url, sourcePath: path });
	}
	return out;
}

/**
 * Discover MCP configs from known paths. Does not modify config files.
 * Later paths do not override earlier names (cwd wins over home).
 */
export function discoverMcpConfigs(cwd: string = process.cwd()): McpServerConfig[] {
	const seen = new Set<string>();
	const out: McpServerConfig[] = [];
	for (const path of configCandidates(cwd)) {
		for (const server of parseServers(path)) {
			if (seen.has(server.name)) continue;
			seen.add(server.name);
			out.push(server);
		}
	}
	return out;
}

export class McpManager {
	private readonly configs = new Map<string, McpServerConfig>();
	private readonly live = new Map<string, LiveMcp>();

	/** Load configs into domain as disconnected servers. */
	discover(cwd: string = process.cwd()): McpServerState[] {
		const discovered = discoverMcpConfigs(cwd);
		const results: McpServerState[] = [];
		for (const config of discovered) {
			this.configs.set(config.name, config);
			const result = workflowController.apply((state) =>
				upsertMcpServer(state, {
					name: config.name,
					status: "disconnected",
					transport: config.transport,
					sourcePath: config.sourcePath,
					toolCount: 0,
					enabled: true,
				}),
			);
			if (result.ok) results.push(result.value);
		}
		return results;
	}

	enable(name: string): McpServerState {
		const result = workflowController.apply((state) => setMcpEnabled(state, name, true));
		if (!result.ok) throw new Error(result.error);
		return result.value;
	}

	disable(name: string): McpServerState {
		this.disconnect(name);
		const result = workflowController.apply((state) => setMcpEnabled(state, name, false));
		if (!result.ok) throw new Error(result.error);
		return result.value;
	}

	async reconnect(name: string, cwd: string = process.cwd()): Promise<McpServerState> {
		const config = this.configs.get(name) ?? discoverMcpConfigs(cwd).find((item) => item.name === name);
		if (!config) throw new Error(`MCP server config not found: ${name}`);
		this.configs.set(config.name, config);

		const enabled = workflowController.getState().mcpServers.find((s) => s.name === name)?.enabled !== false;
		if (!enabled) throw new Error(`MCP server disabled: ${name}`);

		this.disconnect(name);

		workflowController.apply((state) =>
			upsertMcpServer(state, {
				name,
				status: "connecting",
				transport: config.transport,
				sourcePath: config.sourcePath,
			}),
		);

		if (config.transport !== "stdio" || !config.command) {
			const error =
				config.transport === "stdio"
					? "stdio server missing command"
					: `Transport ${config.transport} reconnect not implemented (stdio only)`;
			const failed = workflowController.apply((state) =>
				upsertMcpServer(state, { name, status: "error", error, transport: config.transport }),
			);
			if (!failed.ok) throw new Error(failed.error);
			return failed.value;
		}

		try {
			const tools = await this.connectStdio(config, cwd);
			const connected = workflowController.apply((state) =>
				upsertMcpServer(state, {
					name,
					status: "connected",
					transport: "stdio",
					sourcePath: config.sourcePath,
					toolCount: tools.length,
					error: undefined,
					enabled: true,
				}),
			);
			if (!connected.ok) throw new Error(connected.error);
			return connected.value;
		} catch (err) {
			this.disconnect(name);
			const error = err instanceof Error ? err.message : String(err);
			const failed = workflowController.apply((state) =>
				upsertMcpServer(state, { name, status: "error", error, transport: config.transport }),
			);
			if (!failed.ok) throw new Error(failed.error);
			return failed.value;
		}
	}

	inspect(name: string): { server: McpServerState; tools: string[] } | undefined {
		const server = workflowController
			.getState()
			.mcpServers.find((item) => item.name === name || item.id.endsWith(name));
		if (!server) return undefined;
		const live = this.live.get(server.name);
		return { server, tools: live?.tools.slice() ?? [] };
	}

	list(): McpServerState[] {
		return workflowController.getState().mcpServers.slice();
	}

	disconnect(name: string): void {
		const live = this.live.get(name);
		if (!live) return;
		for (const pending of live.pending.values()) {
			pending.reject(new Error("MCP disconnected"));
		}
		live.pending.clear();
		try {
			live.child.kill("SIGTERM");
		} catch {
			// ignore
		}
		setTimeout(() => {
			try {
				live.child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}, 2000);
		this.live.delete(name);
		const current = workflowController.getState().mcpServers.find((s) => s.name === name);
		const nextStatus: McpConnectionStatus = current?.enabled === false ? "disabled" : "disconnected";
		workflowController.apply((state) =>
			upsertMcpServer(state, {
				name,
				status: nextStatus,
				toolCount: 0,
			}),
		);
	}

	private async connectStdio(config: McpServerConfig, cwd: string): Promise<string[]> {
		const child = spawn(config.command!, config.args ?? [], {
			cwd,
			env: { ...process.env, ...config.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const live: LiveMcp = {
			child,
			tools: [],
			buffer: "",
			pending: new Map(),
			nextId: 1,
		};
		this.live.set(config.name, live);

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			live.buffer += chunk;
			for (;;) {
				const idx = live.buffer.indexOf("\n");
				if (idx < 0) break;
				const line = live.buffer.slice(0, idx).trim();
				live.buffer = live.buffer.slice(idx + 1);
				if (!line) continue;
				this.handleLine(live, line);
			}
		});

		child.on("error", (err) => {
			for (const pending of live.pending.values()) {
				pending.reject(err);
			}
			live.pending.clear();
		});

		child.on("close", () => {
			for (const pending of live.pending.values()) {
				pending.reject(new Error("MCP process exited"));
			}
			live.pending.clear();
			this.live.delete(config.name);
		});

		await this.request(live, "initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "qi-workflow", version: "0.0.0" },
		});
		this.notify(live, "notifications/initialized", {});

		const listed = (await this.request(live, "tools/list", {})) as {
			tools?: Array<{ name?: string }>;
		};
		const tools = (listed.tools ?? [])
			.map((tool) => tool.name)
			.filter((name): name is string => typeof name === "string" && name.length > 0);
		live.tools = tools;
		return tools;
	}

	private handleLine(live: LiveMcp, line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!message || typeof message !== "object") return;
		const msg = message as { id?: number; result?: unknown; error?: { message?: string } };
		if (typeof msg.id !== "number") return;
		const pending = live.pending.get(msg.id);
		if (!pending) return;
		live.pending.delete(msg.id);
		if (msg.error) {
			pending.reject(new Error(msg.error.message ?? "MCP error"));
			return;
		}
		pending.resolve(msg.result);
	}

	private request(live: LiveMcp, method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = live.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			live.pending.set(id, { resolve, reject });
			if (!live.child.stdin || live.child.stdin.destroyed) {
				live.pending.delete(id);
				reject(new Error("MCP stdin closed"));
				return;
			}
			live.child.stdin.write(`${payload}\n`, (err) => {
				if (err) {
					live.pending.delete(id);
					reject(err);
				}
			});
			setTimeout(() => {
				if (!live.pending.has(id)) return;
				live.pending.delete(id);
				reject(new Error(`MCP request timed out: ${method}`));
			}, 15_000);
		});
	}

	private notify(live: LiveMcp, method: string, params: Record<string, unknown>): void {
		const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
		live.child.stdin?.write(`${payload}\n`);
	}
}

export const mcpManager = new McpManager();
