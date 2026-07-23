/**
 * Qi rewind auto-checkpoint — mature pi-rewind turn_end aggregation policy.
 * Qi owns /rewind panel UI; this module owns resume / turn_end / prune / fork-tree file restore.
 */

import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import { workflowController } from "../controller.ts";
import { addRewindCheckpoint } from "../domain/index.ts";
import {
	type CheckpointData,
	createCheckpoint,
	DEFAULT_MAX_CHECKPOINTS,
	deleteCheckpoint,
	getRepoRoot,
	isGitRepo,
	loadAllCheckpoints,
	MUTATING_TOOLS,
	pruneCheckpoints,
	pruneOldSessions,
	REF_BASE,
	restoreCheckpoint,
	sanitizeForRef,
} from "../vendor/rewind/core.ts";

export { MUTATING_TOOLS };

interface AutoRewindState {
	gitAvailable: boolean;
	repoRoot: string | null;
	sessionId: string | null;
	failed: boolean;
	pending: Promise<void> | null;
	currentTurnIndex: number;
	currentPrompt: string;
	pendingToolInfo: Map<string, string>;
	turnToolDescriptions: string[];
	turnHadMutations: boolean;
	lastWorktreeTree: string | null;
	checkpoints: Map<string, CheckpointData>;
	resumeCheckpoint: CheckpointData | null;
	redoStack: CheckpointData[];
}

function createState(): AutoRewindState {
	return {
		gitAvailable: false,
		repoRoot: null,
		sessionId: null,
		failed: false,
		pending: null,
		currentTurnIndex: 0,
		currentPrompt: "",
		pendingToolInfo: new Map(),
		turnToolDescriptions: [],
		turnHadMutations: false,
		lastWorktreeTree: null,
		checkpoints: new Map(),
		resumeCheckpoint: null,
		redoStack: [],
	};
}

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return `${s.slice(0, maxLen - 1)}…`;
}

function describeToolCall(toolName: string, input: unknown): string {
	const args = input as { path?: string; command?: string } | null;
	if (!args) return toolName;
	switch (toolName) {
		case "write":
			return `write → ${args.path || "?"}`;
		case "edit":
			return `edit → ${args.path || "?"}`;
		case "bash":
			return `bash: ${truncate(String(args.command || ""), 50)}`;
		default:
			return toolName;
	}
}

function recordDomainCheckpoint(gitRef: string, description: string, entryId?: string): void {
	workflowController.apply((state) =>
		addRewindCheckpoint(state, description, {
			entryId,
			scope: "files",
			gitRef,
		}),
	);
}

async function performFileRestore(state: AutoRewindState, _ctx: ExtensionContext, cp: CheckpointData): Promise<void> {
	if (!state.repoRoot) return;
	const before = await createCheckpoint({
		root: state.repoRoot,
		id: sanitizeForRef(`before-restore-${Date.now()}`).slice(0, 80),
		sessionId: state.sessionId ?? "unknown",
		trigger: "before-restore",
		turnIndex: state.currentTurnIndex,
		description: "auto before restore",
	});
	state.redoStack.push(before);
	await restoreCheckpoint(state.repoRoot, cp);
	state.lastWorktreeTree = cp.worktreeTreeSha;
}

/**
 * Wire mature rewind checkpoint lifecycle (resume + turn_end aggregation + prune + fork/tree).
 */
export function attachAutoRewind(pi: ExtensionAPI): void {
	const state = createState();

	async function initSession(ctx: ExtensionContext): Promise<void> {
		Object.assign(state, createState());
		state.gitAvailable = await isGitRepo(ctx.cwd);
		if (!state.gitAvailable) return;

		state.repoRoot = await getRepoRoot(ctx.cwd);
		state.sessionId = ctx.sessionManager.getSessionId();

		try {
			const existing = await loadAllCheckpoints(state.repoRoot, state.sessionId);
			for (const cp of existing) {
				state.checkpoints.set(cp.id, cp);
			}
		} catch {
			// rebuild is best-effort
		}

		try {
			const resumeId = sanitizeForRef(`resume-${state.sessionId}-${Date.now()}`).slice(0, 80);
			const cp = await createCheckpoint({
				root: state.repoRoot,
				id: resumeId,
				sessionId: state.sessionId,
				trigger: "resume",
				turnIndex: 0,
				description: "Session start",
			});
			state.resumeCheckpoint = cp;
			state.checkpoints.set(cp.id, cp);
			state.lastWorktreeTree = cp.worktreeTreeSha;
			recordDomainCheckpoint(`${REF_BASE}/${cp.id}`, "Session start");
		} catch {
			// resume checkpoint optional
		}

		const root = state.repoRoot;
		const sid = state.sessionId;
		void pruneOldSessions(root, sid).catch(() => {});
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "fork") {
			if (!state.gitAvailable) return;
			state.sessionId = ctx.sessionManager.getSessionId();
			return;
		}
		await initSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (state.pending) await state.pending;
	});

	pi.on("before_agent_start", async (event) => {
		state.currentPrompt = truncate(String(event.prompt || ""), 60);
		state.turnToolDescriptions = [];
		state.turnHadMutations = false;
	});

	pi.on("turn_start", async (event) => {
		state.currentTurnIndex = event.turnIndex;
	});

	pi.on("tool_call", async (event) => {
		if (MUTATING_TOOLS.has(event.toolName)) {
			state.pendingToolInfo.set(event.toolCallId, describeToolCall(event.toolName, event.input));
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!MUTATING_TOOLS.has(event.toolName)) return;
		state.turnHadMutations = true;
		const toolDesc = state.pendingToolInfo.get(event.toolCallId) || event.toolName;
		state.pendingToolInfo.delete(event.toolCallId);
		state.turnToolDescriptions.push(toolDesc);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!state.gitAvailable || state.failed) return;
		if (!state.repoRoot || !state.sessionId) return;
		if (!state.turnHadMutations) return;

		if (state.pending) await state.pending;

		const promptLabel = state.currentPrompt ? `"${state.currentPrompt}"` : "";
		const toolsLabel = state.turnToolDescriptions.join(", ");
		const desc =
			promptLabel && toolsLabel
				? `${promptLabel} → ${toolsLabel}`
				: promptLabel || toolsLabel || `Turn ${state.currentTurnIndex}`;

		const run = (async () => {
			try {
				const id = sanitizeForRef(`turn-${state.currentTurnIndex}-${Date.now()}`).slice(0, 80);
				const cp = await createCheckpoint({
					root: state.repoRoot!,
					id,
					sessionId: state.sessionId!,
					trigger: "turn",
					turnIndex: state.currentTurnIndex,
					description: desc,
				});
				if (state.lastWorktreeTree && cp.worktreeTreeSha === state.lastWorktreeTree) {
					await deleteCheckpoint(state.repoRoot!, cp.id);
					return;
				}
				state.checkpoints.set(cp.id, cp);
				state.lastWorktreeTree = cp.worktreeTreeSha;
				recordDomainCheckpoint(`${REF_BASE}/${cp.id}`, desc, ctx.sessionManager.getLeafId() ?? undefined);
				await pruneCheckpoints(state.repoRoot!, state.sessionId!, DEFAULT_MAX_CHECKPOINTS);
				const remaining = await loadAllCheckpoints(state.repoRoot!, state.sessionId!);
				state.checkpoints.clear();
				for (const item of remaining) state.checkpoints.set(item.id, item);
			} catch {
				state.failed = true;
			} finally {
				state.turnHadMutations = false;
				state.turnToolDescriptions = [];
				state.pendingToolInfo.clear();
			}
		})();

		state.pending = run;
		await run;
		state.pending = null;
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		if (!state.gitAvailable || !state.repoRoot || !ctx.hasUI) return;
		const sorted = [...state.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
		const cp = sorted[0] ?? state.resumeCheckpoint;
		if (!cp) return;
		const choice = await ctx.ui.select("Restore files before fork?", [
			"Keep current files",
			"Restore files to latest checkpoint",
			"Cancel",
		]);
		if (!choice || choice === "Cancel") return { cancel: true as const };
		if (choice.startsWith("Restore")) {
			await performFileRestore(state, ctx, cp);
			ctx.ui.notify("Files restored from checkpoint", "info");
		}
	});

	pi.on("session_before_tree", async (event, ctx) => {
		if (!state.gitAvailable || !state.repoRoot || !ctx.hasUI) return;
		const entry = ctx.sessionManager.getEntry(event.preparation.targetId);
		const targetTs = entry?.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
		const sorted = [...state.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
		const cp = sorted.find((c) => c.timestamp <= targetTs) ?? state.resumeCheckpoint;
		const options = ["Keep current files"];
		if (cp) options.push("Restore files to that point");
		if (state.redoStack.length > 0) options.push("Undo last rewind");
		options.push("Cancel navigation");
		const choice = await ctx.ui.select("Restore Options", options);
		if (!choice || choice === "Cancel navigation") return { cancel: true as const };
		if (choice === "Keep current files") return;
		if (choice === "Undo last rewind" && state.redoStack.length > 0) {
			const undoCp = state.redoStack.pop()!;
			await performFileRestore(state, ctx, undoCp);
			ctx.ui.notify("Files restored to before last rewind", "info");
			return { cancel: true as const };
		}
		if (cp) {
			await performFileRestore(state, ctx, cp);
			ctx.ui.notify("Files restored to checkpoint", "info");
		}
	});
}
