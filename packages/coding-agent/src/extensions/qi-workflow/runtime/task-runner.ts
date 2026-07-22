import type { Model } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../../config.ts";
import { DefaultResourceLoader } from "../../../core/resource-loader.ts";
import { createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { workflowController } from "../controller.ts";
import { cancelTask, completeTask, failTask, setTaskRunning, type TaskEntity } from "../domain/index.ts";

const RESULT_SUMMARY_MAX = 8 * 1024;

export interface RunTaskOptions {
	cwd?: string;
	// Matches CreateAgentSessionOptions.model (Model is parameterized by Api).
	model?: Model<any>;
	signal?: AbortSignal;
	/** Optional agent/system append text (kept short; no UI). */
	appendSystemPrompt?: string;
	/** Prior chain step summary injected as `{previous}` handoff context. */
	previousSummary?: string;
}

function boundSummary(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= RESULT_SUMMARY_MAX) return trimmed;
	return `${trimmed.slice(0, RESULT_SUMMARY_MAX)}\n…[truncated]`;
}

function findTask(id: string): TaskEntity | undefined {
	return workflowController.getState().tasks.find((task) => task.id === id || task.id.endsWith(id));
}

/**
 * Run a Task as an in-process child AgentSession.
 * Uses SessionManager.inMemory and a resource loader with noExtensions so nested extensions do not load.
 * Does not steal focus or open UI.
 */
export async function runTask(taskId: string, options: RunTaskOptions = {}): Promise<string> {
	const task = findTask(taskId);
	if (!task) throw new Error(`Task not found: ${taskId}`);

	if (task.cancelRequested || options.signal?.aborted) {
		workflowController.apply((state) => cancelTask(state, task.id));
		return boundSummary("Cancelled before start");
	}

	const cwd = options.cwd ?? process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.inMemory(cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		appendSystemPrompt: options.appendSystemPrompt ? [options.appendSystemPrompt] : undefined,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: options.model,
		sessionManager,
		settingsManager,
		resourceLoader,
	});

	const childSessionId = session.sessionId;
	const running = workflowController.apply((state) => setTaskRunning(state, task.id, childSessionId));
	if (!running.ok) {
		session.dispose();
		throw new Error(running.error);
	}
	if (running.value.status === "cancelled") {
		session.dispose();
		return boundSummary("Cancelled before start");
	}

	const onAbort = () => {
		void session.abort();
		workflowController.apply((state) => cancelTask(state, task.id));
	};
	if (options.signal) {
		if (options.signal.aborted) {
			onAbort();
			session.dispose();
			return boundSummary("Cancelled before start");
		}
		options.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const previous = options.previousSummary?.trim();
		const prompt = previous ? `${task.goal}\n\n{previous}\n${previous}` : task.goal;
		await session.prompt(prompt);
		await session.waitForIdle();

		const current = findTask(task.id);
		if (current?.cancelRequested || options.signal?.aborted) {
			workflowController.apply((state) => cancelTask(state, task.id));
			return boundSummary(session.getLastAssistantText() ?? "Cancelled");
		}

		const summary = boundSummary(session.getLastAssistantText() ?? "(no assistant response)");
		const completed = workflowController.apply((state) => completeTask(state, task.id, summary));
		if (!completed.ok) throw new Error(completed.error);
		return summary;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (options.signal?.aborted || findTask(task.id)?.cancelRequested) {
			workflowController.apply((state) => cancelTask(state, task.id));
			return boundSummary(message || "Cancelled");
		}
		workflowController.apply((state) => failTask(state, task.id, message));
		throw err;
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
