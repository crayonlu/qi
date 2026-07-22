import { spawn } from "node:child_process";
import type { ExtensionCommandContext } from "../../../core/extensions/types.ts";
import { workflowController } from "../controller.ts";
import { addRewindCheckpoint, type RestoreScope, type RewindCheckpoint } from "../domain/index.ts";

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
}

function git(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(stdout.trim());
			else reject(new Error(stderr.trim() || `git ${args[0]} failed (${code})`));
		});
	});
}

async function restoreFiles(cwd: string, gitRef: string): Promise<void> {
	// Best-effort: restore tracked files from the checkpoint ref without creating a new branch.
	await git(["checkout", gitRef, "--", "."], cwd);
}

/**
 * Restore conversation and/or files from a rewind checkpoint.
 * Uses sessionManager.getBranch + ctx.navigateTree (same conversation tree; no second tree / fork).
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
		if (gitRef) {
			try {
				await restoreFiles(cwd, gitRef);
			} catch {
				ctx.ui.notify("File restore failed (best-effort); conversation restore may continue", "warning");
				if (options.scope === "files") return checkpoint.value;
			}
		} else if (options.scope === "files") {
			ctx.ui.notify("No gitRef provided for file restore", "warning");
			return checkpoint.value;
		}
	}

	if (options.scope === "conversation" || options.scope === "all") {
		if (!entryId) throw new Error("entryId is required for conversation restore");
		// navigateTree moves the leaf within the existing session tree (does not fork a new conversation).
		const result = await ctx.navigateTree(entryId, {
			summarize: false,
			label: label,
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
