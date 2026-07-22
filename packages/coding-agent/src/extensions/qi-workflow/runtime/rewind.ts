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
	git,
	MUTATING_TOOLS,
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
	/** Optional git ref / tree for file restore (best-effort). */
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

/**
 * Create a filesystem checkpoint and record it in domain state (gitRef + entryId).
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

	const gitRef = `refs/pi-checkpoints/${opts.sessionId}/${data.id}`;
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
		if (options.checkpoint) {
			try {
				await restoreCheckpoint(cwd, options.checkpoint);
			} catch {
				ctx.ui.notify("File restore failed (best-effort); conversation restore may continue", "warning");
				if (options.scope === "files") return checkpoint.value;
			}
		} else if (gitRef) {
			// Fallback: restore worktree from the stored checkpoint ref tip.
			try {
				await createCheckpoint({
					root: cwd,
					id: nextCheckpointId("before-restore"),
					sessionId: ctx.sessionManager.getSessionId(),
					trigger: "before-restore",
					turnIndex: turnIndex++,
					description: "auto before restore",
				});
				await git(`checkout ${gitRef} -- .`, cwd);
			} catch {
				ctx.ui.notify("File restore failed (best-effort); conversation restore may continue", "warning");
				if (options.scope === "files") return checkpoint.value;
			}
		} else if (options.scope === "files") {
			ctx.ui.notify("No gitRef/checkpoint provided for file restore", "warning");
			return checkpoint.value;
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
