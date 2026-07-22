/**
 * Qi rewind — vendor createCheckpoint/restoreCheckpoint with domain sync.
 * Auto-checkpoint on MUTATING_TOOLS is hooked from the extension index.
 */

import type { ExtensionCommandContext } from "../../../core/extensions/types.ts";
import { workflowController } from "../controller.ts";
import { addRewindCheckpoint, type RestoreScope, type RewindCheckpoint } from "../domain/index.ts";
import {
	type CheckpointData,
	createCheckpoint,
	loadCheckpointFromRef,
	MUTATING_TOOLS,
	REF_BASE,
	restoreCheckpoint,
	sanitizeForRef,
} from "../vendor/rewind/core.ts";

export { MUTATING_TOOLS };

export interface RewindRestoreOptions {
	/** Required. No-op when false. */
	confirmed: boolean;
	scope: RestoreScope;
	/** Session entry id to navigate to (conversation / all). */
	entryId?: string;
	/** Vendor checkpoint ref (`refs/pi-checkpoints/<id>`) or bare id. */
	gitRef?: string;
	label?: string;
	cwd?: string;
	/** Vendor checkpoint payload when restoring files from a prior auto-checkpoint. */
	checkpoint?: CheckpointData;
}

let turnIndex = 0;

function nextCheckpointId(label: string): string {
	const stamp = Date.now().toString(36);
	return sanitizeForRef(`${label}-${stamp}`).slice(0, 80);
}

/** Normalize stored gitRef to the bare vendor checkpoint id used by loadCheckpointFromRef. */
export function checkpointIdFromGitRef(gitRef: string): string {
	const prefix = `${REF_BASE}/`;
	return gitRef.startsWith(prefix) ? gitRef.slice(prefix.length) : gitRef;
}

/**
 * Create a filesystem checkpoint and record it in domain state (gitRef + entryId).
 * gitRef matches vendor `update-ref ${REF_BASE}/${id}` exactly.
 */
export async function checkpointFiles(opts: {
	cwd: string;
	sessionId: string;
	trigger: CheckpointData["trigger"];
	toolName?: string;
	description?: string;
	entryId?: string;
}): Promise<RewindCheckpoint> {
	const id = nextCheckpointId(opts.toolName ?? opts.trigger);
	const data = await createCheckpoint({
		root: opts.cwd,
		id,
		sessionId: opts.sessionId,
		trigger: opts.trigger,
		turnIndex: turnIndex++,
		toolName: opts.toolName,
		description: opts.description,
	});

	const gitRef = `${REF_BASE}/${data.id}`;
	const result = workflowController.apply((state) =>
		addRewindCheckpoint(state, opts.description ?? data.id, {
			entryId: opts.entryId,
			scope: "files",
			gitRef,
		}),
	);
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

async function resolveCheckpointForRestore(
	cwd: string,
	options: RewindRestoreOptions,
): Promise<CheckpointData | undefined> {
	if (options.checkpoint) return options.checkpoint;
	if (!options.gitRef) return undefined;
	const id = checkpointIdFromGitRef(options.gitRef);
	return (await loadCheckpointFromRef(cwd, id)) ?? undefined;
}

/**
 * Restore conversation and/or files from a rewind checkpoint.
 * Call site must pass confirmed=true after explicit user confirmation.
 */
export async function restoreRewind(
	ctx: ExtensionCommandContext,
	options: RewindRestoreOptions,
): Promise<RewindCheckpoint | undefined> {
	if (!options.confirmed) return undefined;

	const cwd = options.cwd ?? ctx.cwd;
	const entryId = options.entryId;
	const gitRef = options.gitRef;
	const label = options.label ?? `rewind:${options.scope}`;

	if ((options.scope === "conversation" || options.scope === "all") && !entryId) {
		throw new Error("entryId is required for conversation restore");
	}

	if (entryId) {
		const entry = ctx.sessionManager.getEntry(entryId);
		if (!entry) throw new Error(`Session entry not found: ${entryId}`);
	}

	const checkpoint = workflowController.apply((state) =>
		addRewindCheckpoint(state, label, {
			entryId,
			scope: options.scope,
			gitRef,
		}),
	);
	if (!checkpoint.ok) throw new Error(checkpoint.error);

	if (options.scope === "files" || options.scope === "all") {
		const data = await resolveCheckpointForRestore(cwd, options);
		if (!data) {
			ctx.ui.notify("No checkpoint data available for file restore", "warning");
			if (options.scope === "files") return checkpoint.value;
		} else {
			try {
				// Safety snapshot before mutating the worktree.
				await createCheckpoint({
					root: cwd,
					id: nextCheckpointId("before-restore"),
					sessionId: ctx.sessionManager.getSessionId(),
					trigger: "before-restore",
					turnIndex: turnIndex++,
					description: "auto before restore",
				});
				await restoreCheckpoint(cwd, data);
			} catch {
				ctx.ui.notify("File restore failed (best-effort); conversation restore may continue", "warning");
				if (options.scope === "files") return checkpoint.value;
			}
		}
	}

	if (options.scope === "conversation" || options.scope === "all") {
		if (!entryId) throw new Error("entryId is required for conversation restore");
		const result = await ctx.navigateTree(entryId, {
			summarize: false,
			label,
		});
		if (result.cancelled) {
			ctx.ui.notify("Conversation restore cancelled", "info");
		}
	}

	return checkpoint.value;
}

export function listRewindCheckpoints(): RewindCheckpoint[] {
	return workflowController.getState().rewindCheckpoints.slice();
}
