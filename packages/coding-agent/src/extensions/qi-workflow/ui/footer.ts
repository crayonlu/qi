import type { ExtensionUIContext } from "../../../core/extensions/types.ts";
import type { JobEntity, McpServerState, QiWorkflowState, TaskEntity } from "../domain/index.ts";

export const QI_FOOTER_STATUS_KEY = "qi";

function isActiveTask(task: TaskEntity): boolean {
	return task.status === "pending" || task.status === "running";
}

function isActiveJob(job: JobEntity): boolean {
	return job.status === "running" || job.status === "terminating";
}

function isFailedTask(task: TaskEntity): boolean {
	return task.status === "failed";
}

function isFailedJob(job: JobEntity): boolean {
	return job.status === "failed" || job.status === "killed";
}

function isConnectedMcp(server: McpServerState): boolean {
	return server.enabled && server.status === "connected";
}

/** Build footer text: tasks=N jobs=N fail=N mcp=N (only nonzero parts). */
export function buildFooterText(state: QiWorkflowState): string | undefined {
	const tasks = state.tasks.filter(isActiveTask).length;
	const jobs = state.jobs.filter(isActiveJob).length;
	const fail =
		state.tasks.filter(isFailedTask).length +
		state.jobs.filter(isFailedJob).length +
		state.workflows.filter((w) => w.status === "failed").length;
	const mcp = state.mcpServers.filter(isConnectedMcp).length;

	const parts: string[] = [];
	if (tasks > 0) parts.push(`tasks=${tasks}`);
	if (jobs > 0) parts.push(`jobs=${jobs}`);
	if (fail > 0) parts.push(`fail=${fail}`);
	if (mcp > 0) parts.push(`mcp=${mcp}`);
	if (parts.length === 0) return undefined;
	return parts.join(" ");
}

/** Exactly one status key `"qi"`. Clears when nothing to show. */
export function refreshFooter(ctx: { ui: Pick<ExtensionUIContext, "setStatus"> }, state: QiWorkflowState): void {
	ctx.ui.setStatus(QI_FOOTER_STATUS_KEY, buildFooterText(state));
}
