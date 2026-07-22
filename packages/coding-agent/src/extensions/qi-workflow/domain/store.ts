import type { QiWorkflowState } from "./types.ts";
import { createEmptyState } from "./types.ts";

export type StoreListener = (state: QiWorkflowState) => void;

/**
 * In-memory session workflow state. Persistence is handled separately via appendEntry.
 * Transitions replace state immutably; listeners refresh Board/footer only.
 */
export class WorkflowStore {
	private state: QiWorkflowState;
	private listeners = new Set<StoreListener>();

	constructor(sessionId = "unknown") {
		this.state = createEmptyState(sessionId);
	}

	getState(): QiWorkflowState {
		return this.state;
	}

	/** Replace entire state (restore / tests). Does not notify unless notify=true. */
	replaceState(next: QiWorkflowState, notify = true): void {
		this.state = next;
		if (notify) this.emit();
	}

	resetForSession(sessionId: string): void {
		this.state = createEmptyState(sessionId);
		this.emit();
	}

	subscribe(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	commit(mutator: (prev: QiWorkflowState) => QiWorkflowState): QiWorkflowState {
		this.state = mutator(this.state);
		this.emit();
		return this.state;
	}

	private emit(): void {
		for (const listener of this.listeners) {
			listener(this.state);
		}
	}
}
