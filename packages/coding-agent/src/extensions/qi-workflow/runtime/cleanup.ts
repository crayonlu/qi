/**
 * Cleanup dry-run / apply — adopts vendor scan helpers (stats-pid + stale run dirs).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import { workflowController } from "../controller.ts";
import {
	applyCleanupReport,
	type CleanupCategoryReport,
	type CleanupReport,
	setCleanupReport,
} from "../domain/index.ts";
import {
	deleteFindings,
	type Finding,
	scanDeadStatsPids,
	scanDS_Store,
	scanEmptySessionDirs,
	scanIdleSessions,
	scanStaleRunDirs,
	selfTest,
} from "../vendor/cleanup/cleanup.ts";

export interface CleanupScanOptions {
	root?: string;
	currentSessionFile?: string | null;
}

function resolveRoot(root?: string): string {
	if (root) return root;
	return dirname(getAgentDir());
}

function toCategory(id: string, label: string, findings: Finding[]): CleanupCategoryReport {
	// Store ALL paths so apply cannot silently drop findings. UI may truncate display.
	return {
		id,
		label,
		count: findings.length,
		bytes: findings.reduce((sum, item) => sum + item.size, 0),
		paths: findings.map((item) => item.path),
	};
}

/**
 * Dry-run scan of regenerable cruft under ~/.pi (or getAgentDir parent).
 * Includes vendor stats-pid + stale subagent run-N scans.
 */
export async function dryRunCleanup(options: CleanupScanOptions = {}): Promise<CleanupReport> {
	const selfTestError = selfTest();
	if (selfTestError) throw new Error(selfTestError);

	const root = resolveRoot(options.root);
	const agentDir = getAgentDir();
	const sessionsDir = join(agentDir, "sessions");
	const currentSessionFile = options.currentSessionFile ?? null;
	const currentProjectDir =
		currentSessionFile && existsSync(dirname(currentSessionFile)) ? dirname(currentSessionFile) : null;

	const idleBasenames = new Set<string>();
	const currentBasename = currentSessionFile
		? (currentSessionFile
				.replace(/\.jsonl$/, "")
				.split(/[/\\]/)
				.pop() ?? null)
		: null;
	const findings: Finding[] = [
		...(await scanDS_Store(root)),
		...(await scanDeadStatsPids(join(root, "context-mode", "sessions"))),
		...(await scanDeadStatsPids(join(agentDir, "context-mode"))),
		...(await scanEmptySessionDirs(sessionsDir, currentProjectDir)),
		...(await scanIdleSessions(sessionsDir, currentSessionFile, idleBasenames)),
		...(await scanStaleRunDirs(sessionsDir, currentBasename, idleBasenames)),
	];

	const byCategory = new Map<string, Finding[]>();
	for (const finding of findings) {
		const list = byCategory.get(finding.category) ?? [];
		list.push(finding);
		byCategory.set(finding.category, list);
	}

	const categories = [...byCategory.entries()].map(([label, items], index) =>
		toCategory(`cat_${index}`, label, items),
	);

	const dry = workflowController.apply((state) => setCleanupReport(state, categories, true));
	if (!dry.ok) throw new Error(dry.error);
	return dry.value;
}

/**
 * Delete only paths listed in the last dry-run report, then mark the report applied.
 */
export async function applyLastCleanupReport(options: CleanupScanOptions = {}): Promise<CleanupReport> {
	const report = workflowController.getState().cleanupReport;
	if (!report) throw new Error("No cleanup report");
	if (report.applied) throw new Error("Cleanup already applied");

	const skip = new Set<string>();
	if (options.currentSessionFile) skip.add(options.currentSessionFile);

	const findings: Finding[] = report.categories.flatMap((category) =>
		category.paths
			.filter((path) => !skip.has(path))
			.map((path) => ({
				category: category.label,
				path,
				size: 0,
				kind: "file" as const,
			})),
	);
	await deleteFindings(findings);

	const applied = workflowController.apply((state) => applyCleanupReport(state));
	if (!applied.ok) throw new Error(applied.error);
	return applied.value;
}

/** Convenience: dry-run by default; set apply=true to delete from the last dry-run report only. */
export async function runCleanup(options: CleanupScanOptions & { apply?: boolean } = {}): Promise<CleanupReport> {
	if (options.apply) return applyLastCleanupReport(options);
	return dryRunCleanup(options);
}
