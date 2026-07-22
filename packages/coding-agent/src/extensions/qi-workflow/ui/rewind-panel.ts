import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import type { RestoreScope, RewindCheckpoint } from "../domain/index.ts";

export interface RewindPanelApi {
	restore(checkpointId: string, scope: RestoreScope): Promise<void>;
	/** Optional diff preview before restore (files scope). */
	preview?(checkpointId: string): Promise<string>;
	/** Optional undo of last restore. */
	undoLast?(): Promise<void>;
}

const CENTER_OVERLAY = {
	anchor: "center" as const,
	width: "95%" as const,
	minWidth: 60,
	maxHeight: "85%" as const,
	margin: 1,
};

const SCOPES: RestoreScope[] = ["files", "conversation", "all"];

function termCols(): number {
	return process.stdout.columns ?? 80;
}

class RewindPanel implements Component {
	private tui: TUI;
	private theme: Theme;
	private controller: WorkflowController;
	private rewindApi: RewindPanelApi;
	private done: () => void;
	private index = 0;
	private scopeIndex = 2; // all
	private confirming = false;
	private previewText = "";
	private message = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tui: TUI, theme: Theme, controller: WorkflowController, rewindApi: RewindPanelApi, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.rewindApi = rewindApi;
		this.done = done;
	}

	private checkpoints(): RewindCheckpoint[] {
		return this.controller.getState().rewindCheckpoints;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private async doRestore(): Promise<void> {
		const cp = this.checkpoints()[this.index];
		if (!cp) return;
		const scope = SCOPES[this.scopeIndex] ?? "all";
		try {
			await this.rewindApi.restore(cp.id, scope);
			this.message = `Restored ${cp.label} (${scope})`;
			this.confirming = false;
			this.previewText = "";
			this.refresh();
		} catch (err) {
			this.message = err instanceof Error ? err.message : String(err);
			this.confirming = false;
			this.refresh();
		}
	}

	private async loadPreview(): Promise<void> {
		const cp = this.checkpoints()[this.index];
		if (!cp || !this.rewindApi.preview) {
			this.previewText = this.rewindApi.preview ? "" : "(preview unavailable)";
			this.refresh();
			return;
		}
		try {
			this.previewText = await this.rewindApi.preview(cp.id);
		} catch (err) {
			this.previewText = err instanceof Error ? err.message : String(err);
		}
		this.refresh();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.confirming) {
				this.confirming = false;
				this.refresh();
				return;
			}
			this.done();
			return;
		}

		if (this.confirming) {
			if (data === "y" || data === "Y" || matchesKey(data, "enter") || matchesKey(data, "return")) {
				void this.doRestore();
			} else if (data === "n" || data === "N") {
				this.confirming = false;
				this.refresh();
			}
			return;
		}

		const list = this.checkpoints();
		if (matchesKey(data, "up")) {
			this.index = Math.max(0, this.index - 1);
			this.previewText = "";
			this.refresh();
			return;
		}
		if (matchesKey(data, "down")) {
			this.index = Math.min(Math.max(0, list.length - 1), this.index + 1);
			this.previewText = "";
			this.refresh();
			return;
		}
		if (matchesKey(data, "left") || data === "[") {
			this.scopeIndex = (this.scopeIndex + SCOPES.length - 1) % SCOPES.length;
			this.refresh();
			return;
		}
		if (matchesKey(data, "right") || data === "]") {
			this.scopeIndex = (this.scopeIndex + 1) % SCOPES.length;
			this.refresh();
			return;
		}
		if (data === "p" || data === "P") {
			void this.loadPreview();
			return;
		}
		if ((data === "u" || data === "U") && this.rewindApi.undoLast) {
			void this.rewindApi
				.undoLast()
				.then(() => {
					this.message = "Undid last restore";
					this.refresh();
				})
				.catch((err) => {
					this.message = err instanceof Error ? err.message : String(err);
					this.refresh();
				});
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "r" || data === "R") {
			if (list.length === 0) return;
			this.confirming = true;
			void this.loadPreview();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const w = Math.max(1, width);
		const list = this.checkpoints();
		const lines: string[] = [];

		lines.push(th.fg("accent", "─".repeat(w)));
		lines.push(truncateToWidth(th.fg("accent", " Rewind "), w));
		lines.push("");

		if (list.length === 0) {
			lines.push(truncateToWidth(th.fg("dim", "No checkpoints yet"), w));
		} else {
			const wide = w >= 80;
			for (let i = 0; i < list.length; i++) {
				const cp = list[i]!;
				const focused = i === this.index;
				const prefix = focused ? th.fg("accent", "> ") : "  ";
				const label = th.fg(focused ? "accent" : "text", cp.label);
				const meta = th.fg("dim", cp.gitRef ? ` · ${cp.gitRef}` : cp.entryId ? ` · ${cp.entryId}` : "");
				lines.push(truncateToWidth(prefix + label + meta, wide ? Math.floor(w * 0.55) : w));
				if (focused && wide) {
					lines.push(
						truncateToWidth(
							`    ${th.fg("muted", cp.summary)}${cp.scope ? th.fg("dim", ` · prior scope ${cp.scope}`) : ""}`,
							w,
						),
					);
				}
			}

			lines.push("");
			const scopeParts = SCOPES.map((s, i) => (i === this.scopeIndex ? th.fg("accent", `[${s}]`) : th.fg("dim", s)));
			lines.push(truncateToWidth(`${th.fg("muted", "restore scope:")} ${scopeParts.join(" ")}`, w));
		}

		if (this.confirming) {
			const cp = list[this.index];
			const scope = SCOPES[this.scopeIndex] ?? "all";
			lines.push("");
			lines.push(
				...wrapTextWithAnsi(th.fg("warning", `Restore "${cp?.label ?? "?"}" with scope=${scope}? [y/N]`), w),
			);
			if (this.previewText) {
				lines.push("");
				lines.push(truncateToWidth(th.fg("muted", "preview:"), w));
				for (const line of this.previewText.split("\n").slice(0, 8)) {
					lines.push(truncateToWidth(th.fg("dim", line), w));
				}
			}
		} else if (this.previewText) {
			lines.push("");
			lines.push(truncateToWidth(th.fg("muted", "preview:"), w));
			for (const line of this.previewText.split("\n").slice(0, 8)) {
				lines.push(truncateToWidth(th.fg("dim", line), w));
			}
		}

		if (this.message) {
			lines.push("");
			lines.push(truncateToWidth(th.fg("success", this.message), w));
		}

		lines.push("");
		lines.push(
			truncateToWidth(th.fg("dim", "↑↓ checkpoint · ←→ scope · p preview · Enter restore · u undo · Esc close"), w),
		);
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

async function narrowRewindSelect(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	rewindApi: RewindPanelApi,
): Promise<void> {
	const list = controller.getState().rewindCheckpoints;
	if (list.length === 0) {
		ctx.ui.notify("No checkpoints yet", "info");
		return;
	}
	const choice = await ctx.ui.select(
		"Rewind checkpoint",
		list.map((cp) => cp.label),
	);
	if (!choice) return;
	const cp = list.find((c) => c.label === choice);
	if (!cp) return;
	const scopeChoice = await ctx.ui.select("Restore scope", ["files", "conversation", "all"]);
	if (!scopeChoice) return;
	const scope = scopeChoice as RestoreScope;
	const ok = await ctx.ui.confirm("Confirm restore", `Restore "${cp.label}" with scope=${scope}?`);
	if (!ok) return;
	try {
		await rewindApi.restore(cp.id, scope);
		ctx.ui.notify(`Restored ${cp.label} (${scope})`, "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

export async function showRewindPanel(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	rewindApi: RewindPanelApi,
): Promise<void> {
	if (termCols() < 60) {
		await narrowRewindSelect(ctx, controller, rewindApi);
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new RewindPanel(tui, theme, controller, rewindApi, done), {
		overlay: true,
		overlayOptions: CENTER_OVERLAY,
	});
}
