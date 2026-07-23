import { newId, nowMs } from "../ids.ts";
import type { TransitionResult } from "../result.ts";
import type {
	BtwDraft,
	CleanupCategoryReport,
	CleanupReport,
	JobEntity,
	JobStatus,
	McpConnectionStatus,
	McpServerState,
	QiWorkflowState,
	QuestionOption,
	QuestionStatus,
	RestoreScope,
	RewindCheckpoint,
	StructuredQuestion,
} from "../types.ts";
import { JOB_MAX_OUTPUT_BYTES } from "../types.ts";

function bump(entity: { revision: number; updatedAt: number }): void {
	entity.revision += 1;
	entity.updatedAt = nowMs();
}

function fail<T>(state: QiWorkflowState, error: string): TransitionResult<T> {
	return { ok: false, error, state };
}

function ok<T>(state: QiWorkflowState, value: T): TransitionResult<T> {
	return { ok: true, value, state };
}

export function startJob(
	state: QiWorkflowState,
	name: string,
	command: string,
	cwd: string,
	opts?: { workflowId?: string; pid?: number; logPath?: string },
): TransitionResult<JobEntity> {
	const trimmedName = name.trim();
	const trimmedCommand = command.trim();
	if (!trimmedName || !trimmedCommand) return fail(state, "Job name and command are required");
	const t = nowMs();
	const job: JobEntity = {
		id: newId("job"),
		name: trimmedName,
		command: trimmedCommand,
		cwd,
		summary: trimmedName,
		status: "running",
		pid: opts?.pid,
		logPath: opts?.logPath,
		workflowId: opts?.workflowId,
		outputBytes: 0,
		cancelRequested: false,
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	return ok({ ...state, jobs: [...state.jobs, job] }, job);
}

export function updateJobOutput(state: QiWorkflowState, id: string, addedBytes: number): TransitionResult<JobEntity> {
	const job = state.jobs.find((item) => item.id === id);
	if (!job) return fail(state, `Job not found: ${id}`);
	const outputBytes = Math.min(JOB_MAX_OUTPUT_BYTES, job.outputBytes + Math.max(0, addedBytes));
	const updated = { ...job, outputBytes };
	bump(updated);
	return ok({ ...state, jobs: state.jobs.map((item) => (item.id === id ? updated : item)) }, updated);
}

export function finishJob(
	state: QiWorkflowState,
	id: string,
	status: Exclude<JobStatus, "running" | "terminating">,
	exitCode?: number,
): TransitionResult<JobEntity> {
	const job = state.jobs.find((item) => item.id === id);
	if (!job) return fail(state, `Job not found: ${id}`);
	const updated = {
		...job,
		status,
		exitCode,
		summary: `${status}: ${job.name}`,
	};
	bump(updated);
	return ok({ ...state, jobs: state.jobs.map((item) => (item.id === id ? updated : item)) }, updated);
}

export function cancelJob(state: QiWorkflowState, id: string): TransitionResult<JobEntity> {
	const job = state.jobs.find((item) => item.id === id || item.id.endsWith(id));
	if (!job) return fail(state, `Job not found: ${id}`);
	const updated = {
		...job,
		cancelRequested: true,
		status: job.status === "running" ? ("terminating" as JobStatus) : job.status,
		summary: `Cancelling: ${job.name}`,
	};
	bump(updated);
	return ok({ ...state, jobs: state.jobs.map((item) => (item.id === job.id ? updated : item)) }, updated);
}

const TERMINAL_JOB: ReadonlySet<JobStatus> = new Set(["exited", "killed", "failed", "unknown"]);

/** Remove finished jobs from domain so list/clear stay in sync with ProcessManager.clearFinished. */
export function clearFinishedJobs(state: QiWorkflowState): TransitionResult<{ removed: number }> {
	const kept = state.jobs.filter((job) => !TERMINAL_JOB.has(job.status));
	const removed = state.jobs.length - kept.length;
	return ok({ ...state, jobs: kept }, { removed });
}

export function recoverJobStatuses(state: QiWorkflowState): TransitionResult<null> {
	const jobs = state.jobs.map((job) => {
		if (job.status !== "running" && job.status !== "terminating") return job;
		const updated = {
			...job,
			status: "unknown" as JobStatus,
			summary: `Interrupted: ${job.name}`,
		};
		bump(updated);
		return updated;
	});
	return ok({ ...state, jobs }, null);
}

export function openQuestion(
	state: QiWorkflowState,
	prompt: string,
	options: QuestionOption[],
	opts?: {
		header?: string;
		multiSelect?: boolean;
		allowFreeInput?: boolean;
		questionIndex?: number;
		questionCount?: number;
	},
): TransitionResult<StructuredQuestion> {
	const trimmed = prompt.trim();
	if (!trimmed) return fail(state, "Question prompt is required");
	if (options.length < 2) return fail(state, "At least two options are required");
	const t = nowMs();
	const question: StructuredQuestion = {
		id: newId("q"),
		prompt: trimmed,
		summary: opts?.header ?? trimmed,
		header: opts?.header,
		options,
		multiSelect: opts?.multiSelect,
		allowFreeInput: opts?.allowFreeInput ?? true,
		questionIndex: opts?.questionIndex,
		questionCount: opts?.questionCount,
		status: "open",
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	const btw = state.btw ? { ...state.btw, hiddenByQuestion: true } : state.btw;
	return ok({ ...state, question, btw }, question);
}

export function answerQuestion(
	state: QiWorkflowState,
	selected: string[],
	freeInput?: string,
	notes?: string,
): TransitionResult<StructuredQuestion> {
	if (!state.question || state.question.status !== "open") return fail(state, "No open question");
	const answerSummary = [...selected, freeInput?.trim()].filter(Boolean).join("; ");
	if (!answerSummary) return fail(state, "Answer required");
	const question = {
		...state.question,
		status: "answered" as QuestionStatus,
		selected,
		freeInput: freeInput?.trim() || undefined,
		notes: notes?.trim() || undefined,
		answerSummary,
		summary: answerSummary,
	};
	bump(question);
	const btw = state.btw ? { ...state.btw, hiddenByQuestion: false } : state.btw;
	return ok({ ...state, question, btw }, question);
}

export function cancelQuestion(state: QiWorkflowState): TransitionResult<StructuredQuestion> {
	if (!state.question || state.question.status !== "open") return fail(state, "No open question");
	const question = {
		...state.question,
		status: "cancelled" as QuestionStatus,
		summary: "Cancelled",
	};
	bump(question);
	const btw = state.btw ? { ...state.btw, hiddenByQuestion: false } : state.btw;
	return ok({ ...state, question, btw }, question);
}

export function startBtw(
	state: QiWorkflowState,
	question: string,
	priorHistory?: Array<{ role: "user" | "assistant"; text: string }>,
): TransitionResult<BtwDraft> {
	if (state.question?.status === "open") return fail(state, "Structured question has priority over /btw");
	const trimmed = question.trim();
	if (!trimmed) return fail(state, "btw question is required");
	const history = priorHistory && priorHistory.length > 0 ? priorHistory : [{ role: "user" as const, text: trimmed }];
	const btw: BtwDraft = {
		question: trimmed,
		history,
		hiddenByQuestion: false,
	};
	return ok({ ...state, btw }, btw);
}

export function updateBtwAnswer(state: QiWorkflowState, answer: string): TransitionResult<BtwDraft> {
	if (!state.btw) return fail(state, "No active /btw draft");
	const btw: BtwDraft = {
		...state.btw,
		answer,
		history: [...state.btw.history, { role: "assistant", text: answer }],
	};
	return ok({ ...state, btw }, btw);
}

export function clearBtw(state: QiWorkflowState): TransitionResult<null> {
	return ok({ ...state, btw: null }, null);
}

export function upsertMcpServer(
	state: QiWorkflowState,
	input: {
		name: string;
		status: McpConnectionStatus;
		transport?: McpServerState["transport"];
		sourcePath?: string;
		toolCount?: number;
		error?: string;
		enabled?: boolean;
		id?: string;
	},
): TransitionResult<McpServerState> {
	const existing = state.mcpServers.find((server) => server.name === input.name || server.id === input.id);
	const t = nowMs();
	if (existing) {
		const updated: McpServerState = {
			...existing,
			status: input.status,
			transport: input.transport ?? existing.transport,
			sourcePath: input.sourcePath ?? existing.sourcePath,
			toolCount: input.toolCount ?? existing.toolCount,
			error: input.error,
			enabled: input.enabled ?? existing.enabled,
			summary: `${input.name}: ${input.status}`,
		};
		bump(updated);
		return ok(
			{ ...state, mcpServers: state.mcpServers.map((server) => (server.id === existing.id ? updated : server)) },
			updated,
		);
	}
	const server: McpServerState = {
		id: input.id ?? newId("mcp"),
		name: input.name,
		status: input.status,
		transport: input.transport ?? "stdio",
		sourcePath: input.sourcePath,
		toolCount: input.toolCount ?? 0,
		error: input.error,
		enabled: input.enabled ?? true,
		summary: `${input.name}: ${input.status}`,
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	return ok({ ...state, mcpServers: [...state.mcpServers, server] }, server);
}

export function setMcpEnabled(
	state: QiWorkflowState,
	name: string,
	enabled: boolean,
): TransitionResult<McpServerState> {
	const server = state.mcpServers.find((item) => item.name === name || item.id.endsWith(name));
	if (!server) return fail(state, `MCP server not found: ${name}`);
	const updated = {
		...server,
		enabled,
		status: enabled
			? server.status === "disabled"
				? ("disconnected" as McpConnectionStatus)
				: server.status
			: ("disabled" as McpConnectionStatus),
		summary: `${server.name}: ${enabled ? "enabled" : "disabled"}`,
	};
	bump(updated);
	return ok(
		{ ...state, mcpServers: state.mcpServers.map((item) => (item.id === server.id ? updated : item)) },
		updated,
	);
}

export function addRewindCheckpoint(
	state: QiWorkflowState,
	label: string,
	opts?: { entryId?: string; scope?: RestoreScope; gitRef?: string },
): TransitionResult<RewindCheckpoint> {
	const t = nowMs();
	const checkpoint: RewindCheckpoint = {
		id: newId("rw"),
		label,
		summary: label,
		entryId: opts?.entryId,
		scope: opts?.scope,
		gitRef: opts?.gitRef,
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	return ok({ ...state, rewindCheckpoints: [...state.rewindCheckpoints, checkpoint] }, checkpoint);
}

export function setCleanupReport(
	state: QiWorkflowState,
	categories: CleanupCategoryReport[],
	dryRun: boolean,
): TransitionResult<CleanupReport> {
	const t = nowMs();
	const total = categories.reduce((sum, category) => sum + category.count, 0);
	const report: CleanupReport = {
		id: newId("clean"),
		summary: dryRun ? `Dry run: ${total} items` : `Applied: ${total} items`,
		dryRun,
		applied: !dryRun,
		categories,
		createdAt: t,
		updatedAt: t,
		revision: 1,
	};
	return ok({ ...state, cleanupReport: report }, report);
}

export function applyCleanupReport(state: QiWorkflowState): TransitionResult<CleanupReport> {
	if (!state.cleanupReport) return fail(state, "No cleanup report");
	if (state.cleanupReport.applied) return fail(state, "Cleanup already applied");
	const report = {
		...state.cleanupReport,
		dryRun: false,
		applied: true,
		summary: `Applied: ${state.cleanupReport.categories.reduce((sum, category) => sum + category.count, 0)} items`,
	};
	bump(report);
	return ok({ ...state, cleanupReport: report }, report);
}

export function setBoardCollapsed(state: QiWorkflowState, collapsed: boolean): TransitionResult<null> {
	return ok({ ...state, boardCollapsed: collapsed }, null);
}
