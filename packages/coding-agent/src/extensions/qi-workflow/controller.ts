import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { type QiWorkflowState, type TransitionResult, WorkflowStore } from "./domain/index.ts";
import { loadStateFromSession, persistState } from "./persistence/session-store.ts";

type AppendEntry = (customType: string, data?: unknown) => void;

/**
 * Single facade used by commands, tools, and UI.
 * Every mutation goes through apply() so state machines are never duplicated.
 */
export class WorkflowController {
	readonly store = new WorkflowStore();
	private appendEntry: AppendEntry | undefined;
	private sessionId = "unknown";

	bindApi(pi: ExtensionAPI): void {
		this.appendEntry = (customType, data) => pi.appendEntry(customType, data);
	}

	/** Persist a branch-replayable custom entry (e.g. qi-todo-state). */
	appendCustom(customType: string, data?: unknown): void {
		this.appendEntry?.(customType, data);
	}

	getState(): QiWorkflowState {
		return this.store.getState();
	}

	subscribe(listener: (state: QiWorkflowState) => void): () => void {
		return this.store.subscribe(listener);
	}

	restoreFromSession(sessionManager: SessionManager, sessionId: string): void {
		this.sessionId = sessionId;
		const loaded = loadStateFromSession(sessionManager, sessionId);
		this.store.replaceState(loaded, true);
	}

	resetSession(sessionId: string): void {
		this.sessionId = sessionId;
		this.store.resetForSession(sessionId);
		this.persist();
	}

	apply<T>(transition: (state: QiWorkflowState) => TransitionResult<T>): TransitionResult<T> {
		const result = transition(this.store.getState());
		if (result.ok) {
			this.store.replaceState(result.state, true);
			this.persist();
		}
		return result;
	}

	persist(): void {
		if (!this.appendEntry) return;
		const state = this.store.getState();
		if (state.sessionId === "unknown") {
			this.store.replaceState({ ...state, sessionId: this.sessionId }, false);
		}
		persistState(this.appendEntry, this.store.getState());
	}
}

export const workflowController = new WorkflowController();
