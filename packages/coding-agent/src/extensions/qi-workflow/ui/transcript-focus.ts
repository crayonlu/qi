/**
 * Transcript Agent View focus — Claude-style viewingAgentTaskId.
 * Pure state: which agent (if any) replaces the main chat column.
 */

export type TranscriptFocus = { kind: "main" } | { kind: "agent"; agentId: string };

type Listener = () => void;

let focus: TranscriptFocus = { kind: "main" };
const listeners = new Set<Listener>();

function emit(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* ignore listener errors */
		}
	}
}

export function getTranscriptFocus(): TranscriptFocus {
	return focus;
}

export function isViewingAgent(): boolean {
	return focus.kind === "agent";
}

export function viewingAgentId(): string | undefined {
	return focus.kind === "agent" ? focus.agentId : undefined;
}

/** Enter agent transcript focus (idempotent when already viewing the same agent). */
export function enterTranscriptFocus(agentId: string): TranscriptFocus {
	const id = agentId.trim();
	if (!id) return focus;
	if (focus.kind === "agent" && focus.agentId === id) return focus;
	focus = { kind: "agent", agentId: id };
	emit();
	return focus;
}

/** Exit to main transcript (idempotent). */
export function exitTranscriptFocus(): TranscriptFocus {
	if (focus.kind === "main") return focus;
	focus = { kind: "main" };
	emit();
	return focus;
}

/** Test / session_shutdown helper. */
export function resetTranscriptFocus(): void {
	if (focus.kind === "main" && listeners.size === 0) return;
	focus = { kind: "main" };
	emit();
}

export function subscribeTranscriptFocus(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
