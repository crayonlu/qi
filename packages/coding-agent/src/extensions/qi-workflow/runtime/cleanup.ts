import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import { workflowController } from "../controller.ts";
import {
	applyCleanupReport,
	type CleanupCategoryReport,
	type CleanupReport,
	setCleanupReport,
} from "../domain/index.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_AGE_MS = 14 * DAY_MS;
const MAX_PATHS = 20;
const PRUNE_DIRS = new Set(["node_modules", ".git", "git", ".Trash"]);

export interface CleanupScanOptions {
	/** Defaults to parent of getAgentDir() (~/.pi). */
	root?: string;
	currentSessionFile?: string;
}

async function safeSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function* walkEntries(root: string): AsyncGenerator<{ path: string; dir: boolean }> {
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory() && PRUNE_DIRS.has(entry.name)) continue;
		const path = join(root, entry.name);
		yield { path, dir: entry.isDirectory() };
		if (entry.isDirectory()) yield* walkEntries(path);
	}
}

function toCategory(id: string, label: string, paths: Array<{ path: string; bytes: number }>): CleanupCategoryReport {
	const limited = paths.slice(0, MAX_PATHS);
	return {
		id,
		label,
		count: paths.length,
		bytes: paths.reduce((sum, item) => sum + item.bytes, 0),
		paths: limited.map((item) => item.path),
	};
}

async function scanDsStore(root: string, skip: Set<string>): Promise<CleanupCategoryReport> {
	const found: Array<{ path: string; bytes: number }> = [];
	for await (const entry of walkEntries(root)) {
		if (entry.dir) continue;
		if (basename(entry.path) !== ".DS_Store") continue;
		if (skip.has(entry.path)) continue;
		found.push({ path: entry.path, bytes: await safeSize(entry.path) });
	}
	return toCategory("ds_store", ".DS_Store files", found);
}

async function scanEmptySessionDirs(sessionsDir: string, skip: Set<string>): Promise<CleanupCategoryReport> {
	const found: Array<{ path: string; bytes: number }> = [];
	if (!existsSync(sessionsDir)) return toCategory("empty_session_dirs", "Empty session dirs", found);
	let entries: Dirent[];
	try {
		entries = await readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return toCategory("empty_session_dirs", "Empty session dirs", found);
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = join(sessionsDir, entry.name);
		if (skip.has(dir)) continue;
		let inside: Dirent[];
		try {
			inside = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		if (inside.length === 0) found.push({ path: dir, bytes: 0 });
	}
	return toCategory("empty_session_dirs", "Empty session dirs", found);
}

async function scanIdleSessions(sessionsDir: string, skip: Set<string>): Promise<CleanupCategoryReport> {
	const found: Array<{ path: string; bytes: number }> = [];
	if (!existsSync(sessionsDir)) return toCategory("idle_sessions", "Idle session files (>14d)", found);
	const now = Date.now();
	let projects: Dirent[];
	try {
		projects = await readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return toCategory("idle_sessions", "Idle session files (>14d)", found);
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const projectDir = join(sessionsDir, project.name);
		let files: Dirent[];
		try {
			files = await readdir(projectDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			const path = join(projectDir, file.name);
			if (skip.has(path)) continue;
			let mtimeMs: number;
			try {
				mtimeMs = (await stat(path)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < IDLE_AGE_MS) continue;
			found.push({ path, bytes: await safeSize(path) });
		}
	}
	return toCategory("idle_sessions", "Idle session files (>14d)", found);
}

function resolveRoot(root?: string): string {
	if (root) return root;
	const agentDir = getAgentDir();
	const parent = dirname(agentDir);
	return basename(parent) === ".pi" ? parent : join(homedir(), ".pi");
}

function isForbiddenPath(path: string): boolean {
	return path.split(/[/\\]/).some((part) => part === "node_modules" || part === ".git");
}

/**
 * Dry-run scan of regenerable cruft under ~/.pi (or getAgentDir parent).
 * Never deletes. Paths per category are capped at 20.
 */
export async function dryRunCleanup(options: CleanupScanOptions = {}): Promise<CleanupReport> {
	const root = resolveRoot(options.root);
	const skip = new Set<string>();
	if (options.currentSessionFile) skip.add(options.currentSessionFile);

	const sessionsDir = join(getAgentDir(), "sessions");
	const categories = [
		await scanDsStore(root, skip),
		await scanEmptySessionDirs(sessionsDir, skip),
		await scanIdleSessions(sessionsDir, skip),
	];

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

	const allowed = report.categories.flatMap((category) => category.paths);
	for (const path of allowed) {
		if (skip.has(path) || isForbiddenPath(path)) continue;
		try {
			const info = await stat(path);
			if (info.isDirectory()) await rm(path, { recursive: true, force: true });
			else await unlink(path);
		} catch {
			// best-effort delete
		}
	}

	const applied = workflowController.apply((state) => applyCleanupReport(state));
	if (!applied.ok) throw new Error(applied.error);
	return applied.value;
}

/** Convenience: dry-run by default; set apply=true to delete from the last dry-run report only. */
export async function runCleanup(options: CleanupScanOptions & { apply?: boolean } = {}): Promise<CleanupReport> {
	if (options.apply) return applyLastCleanupReport(options);
	return dryRunCleanup(options);
}
