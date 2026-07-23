/**
 * Qi MCP manager — wraps vendor McpServerManager (stdio/HTTP/SSE + OAuth + lifecycle).
 * Syncs connection status into qi-workflow domain mcpServers.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import { workflowController } from "../controller.ts";
import { type McpConnectionStatus, type McpServerState, setMcpEnabled, upsertMcpServer } from "../domain/index.ts";
import { loadMcpConfig } from "../vendor/mcp/config.ts";
import { McpLifecycleManager } from "../vendor/mcp/lifecycle.ts";
import { clearAllCredentials } from "../vendor/mcp/mcp-auth.ts";
import { authenticate, supportsOAuth } from "../vendor/mcp/mcp-auth-flow.ts";
import { McpServerManager } from "../vendor/mcp/server-manager.ts";
import type { ServerDefinition } from "../vendor/mcp/types.ts";

export interface McpServerConfig {
	name: string;
	transport: "stdio" | "sse" | "http" | "unknown";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	sourcePath: string;
	definition: ServerDefinition;
}

function transportOf(entry: ServerDefinition): McpServerConfig["transport"] {
	if (entry.command) return "stdio";
	if (entry.url) return "http";
	return "unknown";
}

function mapStatus(
	connectionStatus: "connected" | "closed" | "needs-auth" | undefined,
	enabled: boolean,
): McpConnectionStatus {
	if (!enabled) return "disabled";
	if (connectionStatus === "connected") return "connected";
	if (connectionStatus === "needs-auth") return "error";
	return "disconnected";
}

function textResult(text: string, details?: unknown) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

export class McpManager {
	private readonly configs = new Map<string, McpServerConfig>();
	private manager = new McpServerManager();
	private lifecycle = new McpLifecycleManager(this.manager);
	private cwd = process.cwd();
	private proxyRegistered = false;
	private interactiveConfigured = false;

	private ensure(cwd: string): void {
		this.cwd = cwd;
		this.manager = this.manager ?? new McpServerManager(cwd);
	}

	/**
	 * Wire retained sampling/elicitation handlers before connect (pi-mcp-adapter init parity).
	 * Headless: sampling only when samplingAutoApprove; elicitation requires UI.
	 */
	configureInteractive(ctx: ExtensionContext): void {
		const config = loadMcpConfig(undefined, ctx.cwd);
		const samplingAutoApprove = config.settings?.samplingAutoApprove === true;
		if (config.settings?.sampling !== false && (ctx.hasUI || samplingAutoApprove)) {
			this.manager.setSamplingConfig({
				autoApprove: samplingAutoApprove,
				ui: ctx.hasUI ? ctx.ui : undefined,
				modelRegistry: ctx.modelRegistry,
				getCurrentModel: () => ctx.model,
				getSignal: () => ctx.signal,
			});
		} else {
			this.manager.setSamplingConfig(undefined);
		}
		const elicitationEnabled = config.settings?.elicitation !== false && ctx.hasUI;
		if (elicitationEnabled) {
			this.manager.setElicitationConfig({
				ui: ctx.ui,
				allowUrl: ctx.hasUI && ctx.mode === "tui",
			});
		} else {
			this.manager.setElicitationConfig(undefined);
		}
		this.interactiveConfigured = true;
	}

	hasInteractiveCapabilitiesConfigured(): boolean {
		return this.interactiveConfigured;
	}

	discover(cwd: string = process.cwd()): McpServerState[] {
		this.cwd = cwd;
		const config = loadMcpConfig(undefined, cwd);
		this.manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
		this.lifecycle.setGlobalIdleTimeout(config.settings?.idleTimeout ?? 10);
		this.lifecycle.startHealthChecks();

		const results: McpServerState[] = [];
		for (const [name, entry] of Object.entries(config.mcpServers)) {
			const transport = transportOf(entry);
			const sourcePath = "(mcp config)";
			this.configs.set(name, {
				name,
				transport,
				command: entry.command,
				args: entry.args,
				env: entry.env,
				url: entry.url,
				sourcePath,
				definition: entry,
			});
			this.lifecycle.registerServer(name, entry, { idleTimeout: entry.idleTimeout });
			const existing = workflowController.getState().mcpServers.find((s) => s.name === name);
			const enabled = existing?.enabled !== false;
			if (entry.lifecycle === "keep-alive") {
				if (enabled) {
					this.lifecycle.markKeepAlive(name, entry);
				} else {
					this.lifecycle.unmarkKeepAlive(name);
				}
				if (enabled && !this.manager.getConnection(name)) {
					void this.manager
						.connect(name, entry)
						.then((connection) => {
							workflowController.apply((s) =>
								upsertMcpServer(s, {
									name,
									status: "connected",
									transport,
									sourcePath,
									toolCount: connection.tools.length,
									enabled: true,
									error: undefined,
								}),
							);
						})
						.catch((err) => {
							const message = err instanceof Error ? err.message : String(err);
							workflowController.apply((s) =>
								upsertMcpServer(s, {
									name,
									status: "error",
									transport,
									sourcePath,
									error: message,
									enabled: true,
								}),
							);
						});
				}
			}

			const connection = this.manager.getConnection(name);
			const result = workflowController.apply((s) =>
				upsertMcpServer(s, {
					name,
					status: mapStatus(connection?.status, enabled),
					transport,
					sourcePath,
					toolCount: connection?.tools.length ?? existing?.toolCount ?? 0,
					enabled,
					error: connection?.status === "needs-auth" ? "needs OAuth auth" : undefined,
				}),
			);
			if (result.ok) results.push(result.value);
		}
		return results;
	}

	enable(name: string): McpServerState {
		const config = this.configs.get(name);
		const result = workflowController.apply((state) => setMcpEnabled(state, name, true));
		if (!result.ok) throw new Error(result.error);
		if (config?.definition.lifecycle === "keep-alive") {
			this.lifecycle.markKeepAlive(name, config.definition);
		}
		return result.value;
	}

	disable(name: string): McpServerState {
		this.lifecycle.unmarkKeepAlive(name);
		void this.manager.close(name);
		const result = workflowController.apply((state) => setMcpEnabled(state, name, false));
		if (!result.ok) throw new Error(result.error);
		return result.value;
	}

	/** Whether keep-alive reconnect is armed (for Qi /mcp enable|disable tests). */
	isKeepAliveMarked(name: string): boolean {
		return this.lifecycle.isKeepAlive(name);
	}

	hasHealthCheckInterval(): boolean {
		return this.lifecycle.hasHealthCheckInterval();
	}

	async reconnect(name: string, cwd: string = process.cwd()): Promise<McpServerState> {
		this.discover(cwd);
		const config = this.configs.get(name);
		if (!config) throw new Error(`MCP server config not found: ${name}`);

		const enabled = workflowController.getState().mcpServers.find((s) => s.name === name)?.enabled !== false;
		if (!enabled) throw new Error(`MCP server disabled: ${name}`);

		workflowController.apply((state) =>
			upsertMcpServer(state, {
				name,
				status: "connecting",
				transport: config.transport,
				sourcePath: config.sourcePath,
			}),
		);

		try {
			await this.manager.close(name);
			const connection = await this.manager.connect(name, config.definition);
			const tools = connection.tools.map((t) => t.name);
			const connected = workflowController.apply((state) =>
				upsertMcpServer(state, {
					name,
					status: "connected",
					transport: config.transport,
					sourcePath: config.sourcePath,
					toolCount: tools.length,
					error: undefined,
					enabled: true,
				}),
			);
			if (!connected.ok) throw new Error(connected.error);
			return connected.value;
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			const needsAuth = /unauthoriz|auth|oauth/i.test(error);
			const failed = workflowController.apply((state) =>
				upsertMcpServer(state, {
					name,
					status: "error",
					error: needsAuth ? `needs auth: ${error}` : error,
					transport: config.transport,
				}),
			);
			if (!failed.ok) throw new Error(failed.error);
			return failed.value;
		}
	}

	async auth(name: string, cwd: string = process.cwd()): Promise<{ ok: boolean; message: string }> {
		this.discover(cwd);
		const config = this.configs.get(name);
		if (!config) return { ok: false, message: `MCP server config not found: ${name}` };
		if (!config.url || !supportsOAuth(config.definition)) {
			return { ok: false, message: `${name} does not support OAuth authentication` };
		}
		try {
			await authenticate(name, config.url, config.definition);
			return { ok: true, message: `OAuth finished for ${name}. Run /mcp reconnect ${name} if needed.` };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Revoke stored OAuth credentials for a server (Qi equivalent of upstream logout). */
	logout(name: string): { ok: boolean; message: string } {
		const config = this.configs.get(name) ?? this.listConfigs().find((c) => c.name === name);
		if (!config && !this.list().some((s) => s.name === name)) {
			return { ok: false, message: `MCP server not found: ${name}` };
		}
		clearAllCredentials(name);
		void this.manager.close(name);
		const current = workflowController.getState().mcpServers.find((s) => s.name === name);
		if (current) {
			workflowController.apply((state) =>
				upsertMcpServer(state, {
					name,
					status: current.enabled === false ? "disabled" : "disconnected",
					toolCount: 0,
					error: undefined,
				}),
			);
		}
		return {
			ok: true,
			message: `Cleared stored auth for ${name}. Re-run /mcp auth ${name} when you need credentials again.`,
		};
	}

	inspect(name: string): { server: McpServerState; tools: string[] } | undefined {
		const server = workflowController
			.getState()
			.mcpServers.find((item) => item.name === name || item.id.endsWith(name));
		if (!server) return undefined;
		const connection = this.manager.getConnection(server.name);
		const tools = connection?.tools.map((t) => t.name) ?? [];
		return { server, tools };
	}

	list(): McpServerState[] {
		return workflowController.getState().mcpServers.slice();
	}

	listConfigs(): McpServerConfig[] {
		return [...this.configs.values()];
	}

	disconnect(name: string): void {
		void this.manager.close(name);
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

	/** Proxy tool for list/connect/call/auth against the vendor McpServerManager. */
	registerProxyTool(pi: ExtensionAPI, cwd: string = process.cwd()): void {
		if (this.proxyRegistered) return;
		this.proxyRegistered = true;
		this.ensure(cwd);
		const self = this;

		pi.registerTool({
			name: "mcp",
			label: "MCP",
			description: "MCP proxy: status, list, connect, call, auth, logout, resources, read_resource.",
			parameters: Type.Object({
				action: Type.Optional(Type.String()),
				server: Type.Optional(Type.String()),
				tool: Type.Optional(Type.String()),
				args: Type.Optional(Type.String()),
				connect: Type.Optional(Type.String()),
				uri: Type.Optional(Type.String()),
			}),
			async execute(_toolCallId, params, signal) {
				self.discover(cwd);
				const action = (params.connect ? "connect" : (params.action ?? "status")).toLowerCase();
				const serverName = params.connect ?? params.server;

				if (action === "status" || action === "list") {
					const lines = self.list().map((s) => `${s.name}: ${s.status} (${s.transport})`);
					return textResult(lines.join("\n") || "No MCP servers configured.", { action, servers: self.list() });
				}

				if (action === "connect" || action === "reconnect") {
					if (!serverName) return textResult("Error: server required", { error: "missing_server" });
					const server = await self.reconnect(serverName, cwd);
					return textResult(`${server.name}: ${server.status}`, { action, server });
				}

				if (action === "auth" || action === "auth-start") {
					if (!serverName) return textResult("Error: server required", { error: "missing_server" });
					const result = await self.auth(serverName, cwd);
					return textResult(result.message, { action, ok: result.ok });
				}

				if (action === "logout" || action === "revoke" || action === "auth-logout") {
					if (!serverName) return textResult("Error: server required", { error: "missing_server" });
					const result = self.logout(serverName);
					return textResult(result.message, { action: "logout", ok: result.ok });
				}

				if (action === "resources" || action === "list_resources") {
					if (!serverName) return textResult("Error: server required", { error: "missing_server" });
					const config = self.configs.get(serverName);
					if (!config) return textResult(`Error: server not found: ${serverName}`, { error: "not_found" });
					if (!self.manager.getConnection(serverName)) {
						await self.manager.connect(serverName, config.definition);
					}
					const connection = self.manager.getConnection(serverName);
					const resources = connection?.resources ?? [];
					const lines = resources.map((r) => `${r.uri}${r.name ? ` (${r.name})` : ""}`);
					return textResult(lines.join("\n") || "(no resources)", {
						action: "resources",
						server: serverName,
						resources,
					});
				}

				if (action === "read_resource") {
					if (!serverName || !params.uri) {
						return textResult("Error: server and uri required", { error: "missing_args" });
					}
					const config = self.configs.get(serverName);
					if (!config) return textResult(`Error: server not found: ${serverName}`, { error: "not_found" });
					if (!self.manager.getConnection(serverName)) {
						await self.manager.connect(serverName, config.definition);
					}
					const result = await self.manager.readResource(serverName, params.uri, signal);
					return textResult(JSON.stringify(result, null, 2), {
						action: "read_resource",
						server: serverName,
						uri: params.uri,
					});
				}

				if (action === "call") {
					if (!serverName || !params.tool) {
						return textResult("Error: server and tool required", { error: "missing_args" });
					}
					let toolArgs: Record<string, unknown> = {};
					if (params.args) {
						try {
							toolArgs = JSON.parse(params.args) as Record<string, unknown>;
						} catch {
							return textResult("Error: args must be JSON", { error: "invalid_json" });
						}
					}
					const config = self.configs.get(serverName);
					if (!config) return textResult(`Error: server not found: ${serverName}`, { error: "not_found" });
					if (!self.manager.getConnection(serverName)) {
						await self.manager.connect(serverName, config.definition);
					}
					const connection = self.manager.getConnection(serverName);
					if (!connection || connection.status !== "connected") {
						return textResult(`Error: server not connected: ${serverName}`, { error: "not_connected" });
					}
					const result = await connection.client.callTool(
						{ name: params.tool, arguments: toolArgs },
						undefined,
						self.manager.getRequestOptions(serverName, signal),
					);
					const text =
						Array.isArray(result.content) && result.content.length > 0
							? result.content
									.map((block: unknown) =>
										block && typeof block === "object" && "text" in block
											? String((block as { text: unknown }).text)
											: JSON.stringify(block),
									)
									.join("\n")
							: JSON.stringify(result);
					return textResult(text, {
						action: "call",
						server: serverName,
						tool: params.tool,
						isError: result.isError,
					});
				}

				return textResult(`Error: unknown action ${action}`, { error: "unknown_action" });
			},
		});
	}

	shutdown(): void {
		void this.lifecycle.gracefulShutdown().catch(() => {});
	}
}

export const mcpManager = new McpManager();

export function discoverMcpConfigs(cwd: string = process.cwd()): McpServerConfig[] {
	mcpManager.discover(cwd);
	return mcpManager.listConfigs();
}
