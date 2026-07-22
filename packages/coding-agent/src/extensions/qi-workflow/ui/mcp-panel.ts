import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import type { McpServerState } from "../domain/index.ts";
import { setMcpEnabled } from "../domain/index.ts";
import { colorStatus } from "./status-color.ts";

export interface McpPanelApi {
	enable(name: string): Promise<void>;
	disable(name: string): Promise<void>;
	reconnect(name: string): Promise<void>;
	/** Return inspect text (tools, source, errors). */
	inspect(name: string): Promise<string>;
}

const CENTER_OVERLAY = {
	anchor: "center" as const,
	width: "95%" as const,
	minWidth: 60,
	maxHeight: "85%" as const,
	margin: 1,
};

const CONFIG_HINT = [
	"No MCP servers configured.",
	"Add servers in one of:",
	"  .mcp.json",
	"  .pi/mcp.json",
	"  ~/.pi/agent/mcp.json",
];

function termCols(): number {
	return process.stdout.columns ?? 80;
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
		return this.controller.getState().mcpServers;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private async runAction(action: "enable" | "disable" | "reconnect" | "inspect"): Promise<void> {
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

		const list = this.servers();
		if (matchesKey(data, "up")) {
			this.index = Math.max(0, this.index - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "down")) {
			this.index = Math.min(Math.max(0, list.length - 1), this.index + 1);
			this.refresh();
			return;
		}
		if (data === "e" || data === "E") void this.runAction("enable");
		else if (data === "d" || data === "D") void this.runAction("disable");
		else if (data === "r" || data === "R") void this.runAction("reconnect");
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
		const lines: string[] = [];

		lines.push(th.fg("accent", "─".repeat(w)));
		lines.push(truncateToWidth(th.fg("accent", " MCP "), w));
		lines.push("");

		if (servers.length === 0) {
			for (const line of CONFIG_HINT) {
				lines.push(truncateToWidth(th.fg("muted", line), w));
			}
		} else if (this.detailMode || !wide) {
			const server = servers[this.index];
			if (server) {
				lines.push(
					truncateToWidth(`${colorStatus(th, server.status, server.status)} ${th.fg("text", server.name)}`, w),
				);
				lines.push(truncateToWidth(th.fg("muted", `transport ${server.transport} · tools ${server.toolCount}`), w));
				if (server.sourcePath) {
					lines.push(truncateToWidth(th.fg("dim", server.sourcePath), w));
				}
				if (server.error) {
					lines.push(...wrapTextWithAnsi(th.fg("error", server.error), w));
				}
				if (this.inspectText) {
					lines.push("");
					for (const line of this.inspectText.split("\n").slice(0, 20)) {
						lines.push(truncateToWidth(th.fg("text", line), w));
					}
				}
			}
		} else {
			const listWidth = Math.min(36, Math.floor(w * 0.4));
			const detailWidth = w - listWidth - 3;
			const maxRows = Math.max(1, Math.min(servers.length, 12));
			const start = Math.max(0, Math.min(this.index - 5, servers.length - maxRows));
			for (let row = 0; row < maxRows; row++) {
				const i = start + row;
				const server = servers[i];
				if (!server) break;
				const focused = i === this.index;
				const prefix = focused ? th.fg("accent", "> ") : "  ";
				const left = truncateToWidth(
					`${prefix}${colorStatus(th, server.status, "●")} ${th.fg(focused ? "accent" : "text", server.name)}`,
					listWidth,
				);
				let right = "";
				if (focused) {
					right = truncateToWidth(
						th.fg("muted", `${server.transport} · tools=${server.toolCount}`) +
							(server.error ? th.fg("error", ` · ${server.error}`) : ""),
						detailWidth,
					);
				}
				lines.push(truncateToWidth(`${left} │ ${right}`, w));
			}
		}

		if (this.message) {
			lines.push("");
			lines.push(truncateToWidth(th.fg("warning", this.message), w));
		}

		lines.push("");
		lines.push(truncateToWidth(th.fg("dim", "↑↓ · e enable · d disable · r reconnect · i inspect · Esc close"), w));
		lines.push(th.fg("accent", "─".repeat(w)));

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
	const action = await ctx.ui.select(`${server.name}`, ["Enable", "Disable", "Reconnect", "Inspect", "Close"]);
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
		overlayOptions: CENTER_OVERLAY,
	});
}
