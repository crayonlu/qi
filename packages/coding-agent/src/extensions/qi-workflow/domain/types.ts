/** Canonical Qi workflow entity types. All commands/tools/UI mutate via transitions. */

export type WorkStatus =
	| "pending"
	| "running"
	| "waiting"
	| "blocked"
	| "completed"
	| "failed"
	| "cancelled"
	| "paused"
	| "unknown";

export type GoalStatus = "active" | "paused" | "blocked" | "completed" | "cancelled";

export type TodoStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";

export type PlanStatus = "draft" | "ready" | "executing" | "discarded";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export type JobStatus = "running" | "terminating" | "exited" | "killed" | "failed" | "unknown";

export type QuestionStatus = "open" | "answered" | "cancelled";

export type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error" | "disabled";

export type ConversionTargetKind = "todos" | "workflow";

export type WorkflowMode = "single" | "parallel" | "chain";

export type RestoreScope = "files" | "conversation" | "all";

export interface EntityMeta {
	id: string;
	createdAt: number;
	updatedAt: number;
	summary: string;
	revision: number;
}

export interface Goal extends EntityMeta {
	objective: string;
	status: GoalStatus;
	todoIds: string[];
	blockReason?: string;
	completionEvidence?: string;
	iteration: number;
	/** Bound continuation: only one in-flight ticket per goalId+iteration. */
	continuationTicket?: string;
	/** Accounting projected from GoalRuntime ActiveGoal (source of truth). */
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	baselineTokens: number;
	activeStartedAt?: number;
	/** Raw vendor status when distinct from Qi GoalStatus (budget/usage/queued). */
	vendorStatus?: string;
}

export interface TodoItem extends EntityMeta {
	text: string;
	status: TodoStatus;
	position: number;
	goalId?: string;
	taskIds: string[];
	blockReason?: string;
	verification?: string;
	/** Vendor numeric task id for graph ops (blockedBy / activeForm). */
	vendorId?: number;
	activeForm?: string;
	blockedBy?: number[];
	description?: string;
	owner?: string;
}

export interface PlanSections {
	discoveries: string[];
	assumptions: string[];
	decisions: string[];
	steps: string[];
	verification: string[];
	unresolvedQuestions: string[];
}

export interface Plan extends EntityMeta {
	goal: string;
	status: PlanStatus;
	sections: PlanSections;
	conversionTarget?: { kind: ConversionTargetKind; targetId: string };
}

export interface TaskSpec {
	goal: string;
	agent?: string;
}

export interface TaskEntity extends EntityMeta {
	goal: string;
	status: TaskStatus;
	workflowId?: string;
	parentSessionId?: string;
	childSessionId?: string;
	resultSummary?: string;
	error?: string;
	attached: boolean;
	cancelRequested: boolean;
}

export interface WorkflowEntity extends EntityMeta {
	goal: string;
	status: WorkflowStatus;
	mode: WorkflowMode;
	taskIds: string[];
	background: boolean;
	resultSummary?: string;
	error?: string;
	/** Prevents duplicate side effects after restart recovery. */
	effectsApplied: boolean;
}

export interface JobEntity extends EntityMeta {
	name: string;
	command: string;
	cwd: string;
	status: JobStatus;
	pid?: number;
	exitCode?: number;
	logPath?: string;
	workflowId?: string;
	outputBytes: number;
	cancelRequested: boolean;
}

export interface QuestionOption {
	label: string;
	description?: string;
	/** Optional preview shown when the option is focused (ask overlay). */
	preview?: string;
}

export interface StructuredQuestion extends EntityMeta {
	status: QuestionStatus;
	prompt: string;
	header?: string;
	options: QuestionOption[];
	multiSelect?: boolean;
	allowFreeInput?: boolean;
	/** 1-based index when part of a multi-question ask sequence. */
	questionIndex?: number;
	questionCount?: number;
	selected?: string[];
	freeInput?: string;
	notes?: string;
	answerSummary?: string;
}

export interface BtwDraft {
	question: string;
	answer?: string;
	/** Inline overlay error (shown instead of answer). */
	error?: string;
	/** Prior /btw questions only (not the current question or answers). */
	history: Array<{ role: "user" | "assistant"; text: string }>;
	hiddenByQuestion: boolean;
}

export interface McpServerState extends EntityMeta {
	name: string;
	status: McpConnectionStatus;
	transport: "stdio" | "sse" | "http" | "unknown";
	sourcePath?: string;
	toolCount: number;
	error?: string;
	enabled: boolean;
}

export interface RewindCheckpoint extends EntityMeta {
	label: string;
	entryId?: string;
	scope?: RestoreScope;
	gitRef?: string;
}

export interface CleanupCategoryReport {
	id: string;
	label: string;
	count: number;
	bytes: number;
	paths: string[];
}

export interface CleanupReport extends EntityMeta {
	dryRun: boolean;
	applied: boolean;
	categories: CleanupCategoryReport[];
}

export interface QiWorkflowState {
	sessionId: string;
	goal: Goal | null;
	todos: TodoItem[];
	plan: Plan | null;
	tasks: TaskEntity[];
	workflows: WorkflowEntity[];
	jobs: JobEntity[];
	question: StructuredQuestion | null;
	btw: BtwDraft | null;
	mcpServers: McpServerState[];
	rewindCheckpoints: RewindCheckpoint[];
	cleanupReport: CleanupReport | null;
	boardCollapsed: boolean;
}

export const QI_STATE_CUSTOM_TYPE = "qi-workflow-state";

export const WORKFLOW_CONCURRENCY = 4;
export const WORKFLOW_MAX_PARALLEL = 8;
export const JOB_MAX_OUTPUT_BYTES = 50 * 1024;
export const JOB_DEFAULT_TAIL_LINES = 50;
export const JOB_KILL_TIMEOUT_MS = 3000;

export function emptySections(): PlanSections {
	return {
		discoveries: [],
		assumptions: [],
		decisions: [],
		steps: [],
		verification: [],
		unresolvedQuestions: [],
	};
}

export function createEmptyState(sessionId: string): QiWorkflowState {
	return {
		sessionId,
		goal: null,
		todos: [],
		plan: null,
		tasks: [],
		workflows: [],
		jobs: [],
		question: null,
		btw: null,
		mcpServers: [],
		rewindCheckpoints: [],
		cleanupReport: null,
		boardCollapsed: false,
	};
}
