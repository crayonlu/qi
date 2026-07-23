import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import type { McpServerState } from "../domain/index.ts";
import { setMcpEnabled } from "../domain/index.ts";
import { renderBoxPanel } from "./chrome.ts";
import { BOTTOM_OVERLAY, panelMaxHeight, termCols, tuiRows } from "./layout.ts";
import { colorStatus } from "./status-color.ts";
import { ICONS } from "./status-icons.ts";

export interface McpPanelApi {
	enable(name: string): Promise<void>;
	disable(name: string): Promise<void>;
	reconnect(name: string): Promise<void>;
	auth?(name: string): Promise<{ ok: boolean; message: string }>;
	logout?(name: string): Promise<{ ok: boolean; message: string }>;
	/** Return inspect text (tools, source, errors). */
	inspect(name: string): Promise<string>;
}

const CONFIG_HINT = [
	"No MCP servers configured.",
	"Add servers in one of:",
	"  .mcp.json",
	"  .pi/mcp.json",
	"  ~/.pi/agent/mcp.json",
];

function mcpGlyph(theme: Theme, status: string, enabled: boolean): string {
	if (!enabled) return theme.fg("warning", "⊘");
	switch (status) {
		case "connected":
			return theme.fg("success", ICONS.mcpOk);
		case "connecting":
			return theme.fg("accent", ICONS.mcpConn);
		case "error":
			return theme.fg("error", ICONS.mcpErr);
		case "disconnected":
			return theme.fg("muted", "○");
		default:
			return colorStatus(theme, status, ICONS.mcpOk);
	}
}

function statusLabel(server: McpServerState): string {
	if (!server.enabled) return "disabled";
	if (server.status === "connected") return "connected";
	if (server.status === "connecting") return "connecting";
	if (server.status === "error") return "failed";
	return server.status;
}

class McpPanel implements Component {
	private tui: TUI;
	private theme: Theme;
	private controller: WorkflowController;
	private mcpApi: McpPanelApi;
	private done: () => void;
	private index = 0;
	private detailMode = false;
	private inspectText = "";
	private message = "";
	private filter = "";
	private filterMode = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private unsubscribe: (() => void) | undefined;

	constructor(tui: TUI, theme: Theme, controller: WorkflowController, mcpApi: McpPanelApi, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.mcpApi = mcpApi;
		this.done = done;
		this.unsubscribe = controller.subscribe(() => {
			this.invalidate();
			this.tui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	private servers(): McpServerState[] {
		const all = this.controller.getState().mcpServers;
		const q = this.filter.trim().toLowerCase();
		if (!q) return all;
		return all.filter(
			(s) =>
				s.name.toLowerCase().includes(q) ||
				s.status.toLowerCase().includes(q) ||
				(s.error?.toLowerCase().includes(q) ?? false),
		);
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private async runAction(action: "enable" | "disable" | "reconnect" | "inspect" | "auth" | "logout"): Promise<void> {
		const server = this.servers()[this.index];
		if (!server) return;
		try {
			if (action === "enable") {
				this.controller.apply((s) => setMcpEnabled(s, server.name, true));
				await this.mcpApi.enable(server.name);
				this.message = `Enabled ${server.name}`;
			} else if (action === "disable") {
				this.controller.apply((s) => setMcpEnabled(s, server.name, false));
				await this.mcpApi.disable(server.name);
				this.message = `Disabled ${server.name}`;
			} else if (action === "reconnect") {
				await this.mcpApi.reconnect(server.name);
				this.message = `Reconnecting ${server.name}…`;
			} else if (action === "auth") {
				if (!this.mcpApi.auth) {
					this.message = "Auth not available";
				} else {
					const result = await this.mcpApi.auth(server.name);
					this.message = result.message;
				}
			} else if (action === "logout") {
				if (!this.mcpApi.logout) {
					this.message = "Logout not available";
				} else {
					const result = await this.mcpApi.logout(server.name);
					this.message = result.message;
				}
			} else {
				this.inspectText = await this.mcpApi.inspect(server.name);
				this.detailMode = true;
				this.message = "";
			}
		} catch (err) {
			this.message = err instanceof Error ? err.message : String(err);
		}
		this.refresh();
	}

	handleInput(data: string): void {
		if (this.filterMode) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.filterMode = false;
				this.refresh();
				return;
			}
			if (matchesKey(data, "backspace") || data === "\x7f") {
				this.filter = this.filter.slice(0, -1);
				this.index = 0;
				this.refresh();
				return;
			}
			if (data.length === 1 && data >= " ") {
				this.filter += data;
				this.index = 0;
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.detailMode) {
				this.detailMode = false;
				this.inspectText = "";
				this.refresh();
				return;
			}
			this.done();
			return;
		}
		if (data === "/" || data === "f" || data === "F") {
			this.filterMode = true;
			this.refresh();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.index = Math.max(0, this.index - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.index = Math.min(Math.max(0, this.servers().length - 1), this.index + 1);
			this.refresh();
			return;
		}
		if (data === "e" || data === "E") void this.runAction("enable");
		else if (data === "d" || data === "D") void this.runAction("disable");
		else if (data === "r" || data === "R") void this.runAction("reconnect");
		else if (data === "a" || data === "A") void this.runAction("auth");
		else if (data === "l" || data === "L") void this.runAction("logout");
		else if (data === "i" || data === "I" || matchesKey(data, "enter") || matchesKey(data, "return")) {
			void this.runAction("inspect");
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const th = this.theme;
		const w = Math.max(1, width);
		const servers = this.servers();
		const wide = w >= 80;
		const body: string[] = [];

		if (this.filter || this.filterMode) {
			const cursor = this.filterMode ? th.fg("accent", "▌") : "";
			body.push(th.fg("muted", `◎  ${this.filter}${cursor}`) || th.fg("dim", "◎  search…"));
			body.push("");
		}

		if (servers.length === 0) {
			for (const line of CONFIG_HINT) {
				body.push(th.fg("dim", line));
			}
		} else if (this.detailMode || !wide) {
			const server = servers[this.index];
			if (server) {
				const label = statusLabel(server);
				body.push(
					`${mcpGlyph(th, server.status, server.enabled)} ${th.bold(th.fg("text", server.name))}  ${colorStatus(th, label, label)}`,
				);
				body.push(th.fg("muted", `${server.transport} · tools ${server.toolCount}`));
				if (server.sourcePath) body.push(th.fg("dim", server.sourcePath));
				if (server.error) {
					for (const line of wrapTextWithAnsi(th.fg("error", server.error), Math.max(20, w - 6))) {
						body.push(line);
					}
				}
				if (this.inspectText) {
					body.push("");
					for (const line of this.inspectText.split("\n").slice(0, 18)) {
						body.push(th.fg("text", line));
					}
				}
			}
		} else {
			const listWidth = Math.min(34, Math.floor(w * 0.38));
			const detailWidth = Math.max(20, w - listWidth - 5);
			const maxRows = Math.max(1, Math.min(servers.length, 12));
			const start = Math.max(0, Math.min(this.index - 5, servers.length - maxRows));
			for (let row = 0; row < maxRows; row++) {
				const i = start + row;
				const server = servers[i];
				if (!server) break;
				const focused = i === this.index;
				const prefix = focused ? th.fg("accent", "▸ ") : "  ";
				const name = th.fg(focused ? "accent" : "text", focused ? th.bold(server.name) : server.name);
				const left = truncateToWidth(
					`${prefix}${mcpGlyph(th, server.status, server.enabled)} ${name}${server.enabled ? "" : th.fg("warning", " ⊘")}`,
					listWidth,
				);
				let right = "";
				if (focused) {
					const label = statusLabel(server);
					right = truncateToWidth(
						`${colorStatus(th, label, label)} · ${server.transport} · tools ${server.toolCount}` +
							(server.error ? th.fg("error", ` · ${server.error}`) : ""),
						detailWidth,
					);
				}
				const div = th.fg("borderMuted", " │ ");
				body.push(truncateToWidth(`${left}${div}${right}`, Math.max(1, w - 4)));
			}
		}

		if (this.message) {
			body.push("");
			body.push(th.fg("warning", this.message));
		}

		const footer = [
			th.fg(
				"dim",
				"↑↓ navigate · e enable · d disable · r reconnect · a auth · l logout · i inspect · / filter · Esc",
			),
		];

		const lines = renderBoxPanel(th, {
			title: "MCP Servers",
			width: w,
			body,
			footer,
			maxHeight: panelMaxHeight(tuiRows(this.tui), "sheet"),
			fillHeight: true,
		});
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

async function narrowMcpSelect(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	mcpApi: McpPanelApi,
): Promise<void> {
	const servers = controller.getState().mcpServers;
	if (servers.length === 0) {
		await ctx.ui.select("MCP setup", CONFIG_HINT);
		return;
	}
	const choice = await ctx.ui.select(
		"MCP servers",
		servers.map((s) => `${s.name} [${s.status}]${s.enabled ? "" : " (disabled)"}`),
	);
	if (!choice) return;
	const server = servers.find((s) => choice.startsWith(s.name));
	if (!server) return;
	const action = await ctx.ui.select(`${server.name}`, [
		"Enable",
		"Disable",
		"Reconnect",
		"Auth",
		"Logout",
		"Inspect",
		"Close",
	]);
	if (!action || action === "Close") return;
	try {
		if (action === "Enable") {
			controller.apply((s) => setMcpEnabled(s, server.name, true));
			await mcpApi.enable(server.name);
		} else if (action === "Disable") {
			controller.apply((s) => setMcpEnabled(s, server.name, false));
			await mcpApi.disable(server.name);
		} else if (action === "Reconnect") {
			await mcpApi.reconnect(server.name);
		} else if (action === "Auth") {
			const result = await mcpApi.auth?.(server.name);
			ctx.ui.notify(result?.message ?? "Auth not available", result?.ok === false ? "error" : "info");
		} else if (action === "Logout") {
			const result = await mcpApi.logout?.(server.name);
			ctx.ui.notify(result?.message ?? "Logout not available", result?.ok === false ? "error" : "info");
		} else {
			const text = await mcpApi.inspect(server.name);
			await ctx.ui.select("Inspect", text.split("\n").slice(0, 30));
		}
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

export async function showMcpPanel(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	mcpApi: McpPanelApi,
): Promise<void> {
	if (termCols() < 60) {
		await narrowMcpSelect(ctx, controller, mcpApi);
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new McpPanel(tui, theme, controller, mcpApi, done), {
		overlay: true,
		overlayOptions: BOTTOM_OVERLAY,
	});
}
