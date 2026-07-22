import type { QiWorkflowState } from "./types.ts";

export type TransitionResult<T = void> =
	| { ok: true; value: T; state: QiWorkflowState }
	| { ok: false; error: string; state: QiWorkflowState };
