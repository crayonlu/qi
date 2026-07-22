/**
 * pi-cleanup — manual janitor for ~/.pi cruft that pi-delete-session does not cover.
 *
 * /cleanup         dry-run report → confirm → delete
 *
 * Cleans (safe-first):
 *   1. .DS_Store under ~/.pi (regenerable)
 *   2. context-mode stats-pid-*.json whose PID is dead (ESRCH, not EPERM)
 *   3. empty top-level project session dirs under ~/.pi/agent/sessions
 *   4. idle sessions (.jsonl + sibling artifact dir) older than 14 days
 *   5. stale subagent run-N/ dirs (mtime older than 7 days, excluding idle sessions')
 *
 * Never touches: npm/node_modules, .git, intercom broker, current session,
 * context-mode FTS5 *.db (use ctx_purge for those), run-history.jsonl.
 *
 * Self-test runs before every scan: asserts ESRCH=dead / EPERM=alive semantics.
 */

import type { Dirent } from "node:fs";
import { readdir, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "../pi-coding-agent-shim.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../pi-coding-agent-shim.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const IDLE_AGE_MS = 14 * DAY_MS; // sessions idle longer than this are flagged
export const STALE_AGE_MS = 7 * DAY_MS; // subagent run-N dirs older than this are flagged
const PRUNE_DIRS = new Set(["node_modules", ".git", "git", ".Trash"]);

export interface Finding {
	category: string;
	path: string;
	size: number; // bytes; 0 for empty dirs
	kind: "file" | "dir";
}

// ── liveness ──────────────────────────────────────────────────────────────────
// process.kill(pid, 0) is a liveness probe. Throws ESRCH if no such process,
// EPERM if the process exists but we lack permission to signal it (e.g. PID 1).
// bash `kill -0` falsely flags EPERM PIDs as dead; this does not.
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: unknown) {
		return typeof e === "object" && e !== null && (e as { code?: string }).code === "EPERM"; // ESRCH → dead (false), EPERM → alive (true)
	}
}

export function selfTest(): string | null {
	// INT_MAX PID — guaranteed no such process → ESRCH → not alive.
	if (isPidAlive(2147483647)) return "self-test failed: PID 2147483647 should be dead (ESRCH)";
	// PID 1 (launchd/init) exists but is unsignalable as non-root → EPERM → alive.
	if (!isPidAlive(1)) return "self-test failed: PID 1 should be alive (EPERM)";
	return null;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// best-effort file size: 0 if unreadable (size is cosmetic in the report)
async function safeSize(p: string): Promise<number> {
	try {
		return (await stat(p)).size;
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
	for (const e of entries) {
		if (e.isDirectory() && PRUNE_DIRS.has(e.name)) continue;
		const p = join(root, e.name);
		yield { path: p, dir: e.isDirectory() };
		if (e.isDirectory()) yield* walkEntries(p);
	}
}

async function dirSize(p: string): Promise<number> {
	let total = 0;
	let entries: Dirent[];
	try {
		entries = await readdir(p, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const e of entries) {
		const sub = join(p, e.name);
		if (e.isDirectory() && !PRUNE_DIRS.has(e.name)) total += await dirSize(sub);
		else total += await safeSize(sub);
	}
	return total;
}

function parseStatsPid(name: string): number | null {
	const m = name.match(/^stats-pid-(\d+)\.json$/);
	return m ? Number(m[1]) : null;
}

function sessionBasename(file: string): string {
	return basename(file).replace(/\.jsonl$/, "");
}

// ── scanners ──────────────────────────────────────────────────────────────────
export async function scanDS_Store(piRoot: string): Promise<Finding[]> {
	const out: Finding[] = [];
	for await (const e of walkEntries(piRoot)) {
		if (e.dir) continue;
		if (basename(e.path) !== ".DS_Store") continue;
		out.push({ category: ".DS_Store", path: e.path, size: await safeSize(e.path), kind: "file" });
	}
	return out;
}

export async function scanDeadStatsPids(ctxDir: string): Promise<Finding[]> {
	const out: Finding[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(ctxDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isFile()) continue;
		const pid = parseStatsPid(e.name);
		if (pid === null) continue;
		if (isPidAlive(pid)) continue; // alive → keep
		const path = join(ctxDir, e.name);
		out.push({ category: "context-mode dead stats-pid", path, size: await safeSize(path), kind: "file" });
	}
	return out;
}

export async function scanEmptySessionDirs(sessionsDir: string, currentProjectDir: string | null): Promise<Finding[]> {
	const out: Finding[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const dir = join(sessionsDir, e.name);
		if (currentProjectDir && dir === currentProjectDir) continue; // never the live project
		let inside: Dirent[];
		try {
			inside = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		if (inside.length === 0) out.push({ category: "empty session dir", path: dir, size: 0, kind: "dir" });
	}
	return out;
}

// Idle sessions: top-level .jsonl older than IDLE_AGE_MS, plus their sibling
// artifact dir (same basename) if present. Populates idleBasenames so the
// run-N scanner can avoid double-counting those dirs.
export async function scanIdleSessions(
	sessionsDir: string,
	currentSessionFile: string | null,
	idleBasenames: Set<string>,
): Promise<Finding[]> {
	const out: Finding[] = [];
	const now = Date.now();
	let projects: Dirent[];
	try {
		projects = await readdir(sessionsDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const proj of projects) {
		if (!proj.isDirectory()) continue;
		const projDir = join(sessionsDir, proj.name);
		let files: Dirent[];
		try {
			files = await readdir(projDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
			const file = join(projDir, f.name);
			if (currentSessionFile && file === currentSessionFile) continue;
			let mtimeMs: number;
			try {
				mtimeMs = (await stat(file)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < IDLE_AGE_MS) continue;
			const base = sessionBasename(file);
			idleBasenames.add(base);
			out.push({ category: "idle session (>14d)", path: file, size: await safeSize(file), kind: "file" });
			// sibling artifact dir: sessions/<project>/<base>/
			const sibling = join(projDir, base);
			try {
				const s = await stat(sibling);
				if (s.isDirectory()) {
					out.push({ category: "idle session (>14d)", path: sibling, size: await dirSize(sibling), kind: "dir" });
				}
			} catch {
				/* no sibling dir — fine */
			}
		}
	}
	return out;
}

export async function scanStaleRunDirs(
	sessionsDir: string,
	currentSessionBasename: string | null,
	idleBasenames: Set<string>,
): Promise<Finding[]> {
	const out: Finding[] = [];
	const now = Date.now();
	for await (const e of walkEntries(sessionsDir)) {
		if (!e.dir) continue;
		if (!/^run-\d+$/.test(basename(e.path))) continue;
		// skip artifacts belonging to the current (possibly in-flight) session
		if (currentSessionBasename && e.path.includes(currentSessionBasename)) continue;
		// skip run-N dirs that live under an idle session — those are removed with the session
		let underIdle = false;
		for (const base of idleBasenames) {
			if (e.path.includes(base)) {
				underIdle = true;
				break;
			}
		}
		if (underIdle) continue;
		let mtimeMs = 0;
		try {
			mtimeMs = (await stat(e.path)).mtimeMs;
		} catch {
			continue;
		}
		if (now - mtimeMs < STALE_AGE_MS) continue; // too fresh
		out.push({ category: "stale subagent run-N", path: e.path, size: await dirSize(e.path), kind: "dir" });
	}
	return out;
}

// ── report ────────────────────────────────────────────────────────────────────
function buildReport(findings: Finding[]): string {
	const byCat = new Map<string, { files: number; dirs: number; size: number }>();
	for (const f of findings) {
		const cur = byCat.get(f.category) ?? { files: 0, dirs: 0, size: 0 };
		if (f.kind === "dir") cur.dirs++;
		else cur.files++;
		cur.size += f.size;
		byCat.set(f.category, cur);
	}

	const rows = Array.from(byCat.entries()).map(([cat, v]) => {
		const parts: string[] = [];
		if (v.files) parts.push(`${v.files} file${v.files > 1 ? "s" : ""}`);
		if (v.dirs) parts.push(`${v.dirs} dir${v.dirs > 1 ? "s" : ""}`);
		return `  ${cat.padEnd(32)} ${parts.join(" + ").padEnd(14)} ${fmtBytes(v.size).padStart(8)}`;
	});

	const total = findings.reduce((s, f) => s + f.size, 0);
	const header = `🧹 pi-cleanup — dry run (${findings.length} items, ~${fmtBytes(total)})`;
	const body = rows.length ? rows.join("\n") : "  (nothing to clean — ~/.pi is tidy)";
	return `${header}\n\n${body}\n\nTotal reclaimable: ~${fmtBytes(total)}`;
}

// ── deleter ───────────────────────────────────────────────────────────────────
export async function deleteFindings(findings: Finding[]): Promise<{ ok: number; fail: number }> {
	let ok = 0,
		fail = 0;
	for (const f of findings) {
		try {
			if (f.kind === "dir") await rm(f.path, { recursive: true, force: true });
			else await unlink(f.path);
			ok++;
		} catch {
			fail++;
		}
	}
	return { ok, fail };
}

// ── extension ──────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	pi.registerCommand("cleanup", {
		description:
			"Scan & remove ~/.pi cruft: DS_Store, dead stats-pid, empty session dirs, idle sessions, stale subagent run-N.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const err = selfTest();
			if (err) {
				ctx.ui.notify(err, "error");
				return;
			}

			const piRoot = join(homedir(), ".pi");
			const agentDir = getAgentDir();
			const sessionsDir = join(agentDir, "sessions");
			const ctxSessionsDir = join(piRoot, "context-mode", "sessions");

			// current-session protection
			const currentSessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
			const currentProjectDir = currentSessionFile ? dirname(currentSessionFile) : null;
			const currentBasename = currentSessionFile ? sessionBasename(currentSessionFile) : null;

			ctx.ui.notify("Scanning ~/.pi for cruft…", "info");

			// idle sessions first — run-N scanner dedupes against their basenames
			const idleBasenames = new Set<string>();
			const findings: Finding[] = [
				...(await scanDS_Store(piRoot)),
				...(await scanDeadStatsPids(ctxSessionsDir)),
				...(await scanEmptySessionDirs(sessionsDir, currentProjectDir)),
				...(await scanIdleSessions(sessionsDir, currentSessionFile, idleBasenames)),
				...(await scanStaleRunDirs(sessionsDir, currentBasename, idleBasenames)),
			];

			const report = buildReport(findings);

			if (!ctx.hasUI) {
				// non-interactive: report only, never auto-delete
				ctx.ui.notify(report, "info");
				return;
			}

			if (findings.length === 0) {
				ctx.ui.notify(report, "info");
				return;
			}

			const ok = await ctx.ui.confirm("Proceed with cleanup?", report);
			if (!ok) {
				ctx.ui.notify("Cleanup cancelled.", "info");
				return;
			}

			const { ok: deleted, fail } = await deleteFindings(findings);
			ctx.ui.notify(`Cleaned ${deleted} item(s)${fail ? `, ${fail} failed` : ""}.`, fail ? "warning" : "info");
		},
	});
}
