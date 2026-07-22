import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { WorkflowController } from "../controller.ts";
import {
	applyCleanupReport,
	type CleanupCategoryReport,
	type CleanupReport,
	setCleanupReport,
} from "../domain/index.ts";

export interface CleanupPanelApi {
	/** Produce a dry-run report (categories with count/bytes/paths). */
	dryRun(): Promise<CleanupCategoryReport[]>;
	/** Actually delete candidates from the last dry-run report. */
	apply(categories: CleanupCategoryReport[]): Promise<void>;
}

const CENTER_OVERLAY = {
	anchor: "center" as const,
	width: "95%" as const,
	minWidth: 60,
	maxHeight: "85%" as const,
	margin: 1,
};

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function termCols(): number {
	return process.stdout.columns ?? 80;
}

class CleanupPanel implements Component {
	private tui: TUI;
	private theme: Theme;
	private controller: WorkflowController;
	private cleanupApi: CleanupPanelApi;
	private done: () => void;
	private index = 0;
	private showPaths = false;
	private confirming = false;
	private message = "";
	private loading = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tui: TUI, theme: Theme, controller: WorkflowController, cleanupApi: CleanupPanelApi, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.controller = controller;
		this.cleanupApi = cleanupApi;
		this.done = done;
		void this.ensureDryRun();
	}

	private report(): CleanupReport | null {
		return this.controller.getState().cleanupReport;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private async ensureDryRun(): Promise<void> {
		const existing = this.report();
		if (existing?.dryRun && !existing.applied) return;
		this.loading = true;
		this.refresh();
		try {
			const categories = await this.cleanupApi.dryRun();
			this.controller.apply((state) => setCleanupReport(state, categories, true));
			this.message = "Dry run ready";
		} catch (err) {
			this.message = err instanceof Error ? err.message : String(err);
		} finally {
			this.loading = false;
			this.refresh();
		}
	}

	private async doApply(): Promise<void> {
		const report = this.report();
		if (!report || report.applied) return;
		this.loading = true;
		this.refresh();
		try {
			await this.cleanupApi.apply(report.categories);
			const result = this.controller.apply((state) => applyCleanupReport(state));
			if (!result.ok) throw new Error(result.error);
			this.message = "Cleanup applied";
			this.confirming = false;
		} catch (err) {
			this.message = err instanceof Error ? err.message : String(err);
			this.confirming = false;
		} finally {
			this.loading = false;
			this.refresh();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.confirming) {
				this.confirming = false;
				this.refresh();
				return;
			}
			if (this.showPaths) {
				this.showPaths = false;
				this.refresh();
				return;
			}
			this.done();
			return;
		}

		if (this.confirming) {
			if (data === "y" || data === "Y") void this.doApply();
			else if (data === "n" || data === "N") {
				this.confirming = false;
				this.refresh();
			}
			return;
		}

		const cats = this.report()?.categories ?? [];
		if (matchesKey(data, "up")) {
			this.index = Math.max(0, this.index - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, "down")) {
			this.index = Math.min(Math.max(0, cats.length - 1), this.index + 1);
			this.refresh();
			return;
		}
		if (data === "p" || data === "P" || matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.showPaths = !this.showPaths;
			this.refresh();
			return;
		}
		if (data === "a" || data === "A") {
			const report = this.report();
			if (!report || report.applied) return;
			this.confirming = true;
			this.refresh();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const w = Math.max(1, width);
		const report = this.report();
		const lines: string[] = [];

		lines.push(th.fg("accent", "─".repeat(w)));
		lines.push(truncateToWidth(th.fg("accent", " Cleanup "), w));
		lines.push(
			truncateToWidth(
				th.fg("muted", report?.applied ? "applied" : report ? "dry run" : this.loading ? "scanning…" : "no report"),
				w,
			),
		);
		lines.push("");

		const cats = report?.categories ?? [];
		if (cats.length === 0 && !this.loading) {
			lines.push(truncateToWidth(th.fg("dim", "Nothing to clean"), w));
		}

		for (let i = 0; i < cats.length; i++) {
			const cat = cats[i]!;
			const focused = i === this.index;
			const prefix = focused ? th.fg("accent", "> ") : "  ";
			const head = `${cat.label}  count=${cat.count}  size=${formatBytes(cat.bytes)}  paths=${cat.paths.length}`;
			lines.push(truncateToWidth(prefix + th.fg(focused ? "accent" : "text", head), w));
			if (focused && this.showPaths) {
				for (const path of cat.paths.slice(0, 8)) {
					lines.push(truncateToWidth(`    ${th.fg("dim", path)}`, w));
				}
				if (cat.paths.length > 8) {
					lines.push(truncateToWidth(th.fg("dim", `    … +${cat.paths.length - 8} more`), w));
				}
			}
		}

		if (this.confirming) {
			lines.push("");
			lines.push(...wrapTextWithAnsi(th.fg("warning", "Apply cleanup and delete candidates? [y/N]"), w));
		}

		if (this.message) {
			lines.push("");
			lines.push(truncateToWidth(th.fg("warning", this.message), w));
		}

		lines.push("");
		lines.push(truncateToWidth(th.fg("dim", "↑↓ · p paths · a apply (confirm) · Esc close"), w));
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

async function narrowCleanupSelect(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	cleanupApi: CleanupPanelApi,
): Promise<void> {
	let report = controller.getState().cleanupReport;
	if (!report || report.applied) {
		try {
			const categories = await cleanupApi.dryRun();
			const result = controller.apply((state) => setCleanupReport(state, categories, true));
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return;
			}
			report = result.value;
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			return;
		}
	}

	const lines = report.categories.map(
		(c) => `${c.label}: count=${c.count} size=${formatBytes(c.bytes)} paths=${c.paths.length}`,
	);
	if (lines.length === 0) {
		ctx.ui.notify("Nothing to clean", "info");
		return;
	}
	const action = await ctx.ui.select("Cleanup (dry run)", [...lines, "Apply cleanup", "Close"]);
	if (!action || action === "Close" || !action.startsWith("Apply")) return;
	const ok = await ctx.ui.confirm("Confirm cleanup", "Delete dry-run candidates?");
	if (!ok) return;
	try {
		await cleanupApi.apply(report.categories);
		controller.apply((state) => applyCleanupReport(state));
		ctx.ui.notify("Cleanup applied", "info");
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
}

export async function showCleanupPanel(
	ctx: { ui: ExtensionUIContext },
	controller: WorkflowController,
	cleanupApi: CleanupPanelApi,
): Promise<void> {
	if (termCols() < 60) {
		await narrowCleanupSelect(ctx, controller, cleanupApi);
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new CleanupPanel(tui, theme, controller, cleanupApi, done), {
		overlay: true,
		overlayOptions: CENTER_OVERLAY,
	});
}
