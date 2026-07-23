/**
 * Session-scoped bridge so UI (Agent View / footer) can list live subagents
 * without importing the closed-over registry inside stateful.ts.
 */

import type { ManagedAgent } from "./registry.ts";

export type ForegroundRun = {
	id: string;
	mode: "single" | "parallel" | "chain";
	label: string;
	state: "running" | "completed" | "failed";
	updatedAt: number;
	agentNames: string[];
	summary?: string;
};

type StatefulAccessor = {
	list: (includeClosed?: boolean) => ManagedAgent[];
	get?: (id: string) => ManagedAgent | undefined;
	followUp?: (id: string, task: string) => Promise<ManagedAgent>;
};

type Listener = () => void;

let stateful: StatefulAccessor | undefined;
const foreground = new Map<string, ForegroundRun>();
const listeners = new Set<Listener>();

function emit(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* ignore UI listener errors */
		}
	}
}

export function setStatefulAgentAccessor(accessor: StatefulAccessor | undefined): void {
	stateful = accessor;
	emit();
}

export function listStatefulAgents(includeClosed = false): ManagedAgent[] {
	return stateful?.list(includeClosed) ?? [];
}

export function getStatefulAgent(id: string): ManagedAgent | undefined {
	return stateful?.get?.(id);
}

export function followUpStatefulAgent(id: string, task: string): Promise<ManagedAgent> {
	if (!stateful?.followUp) {
		return Promise.reject(new Error("Stateful subagents are not initialized"));
	}
	return stateful.followUp(id, task);
}

export function upsertForegroundRun(run: ForegroundRun): void {
	foreground.set(run.id, run);
	emit();
}

export function removeForegroundRun(id: string): void {
	if (foreground.delete(id)) emit();
}

export function listForegroundRuns(): ForegroundRun[] {
	return [...foreground.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function clearAgentBridge(): void {
	stateful = undefined;
	foreground.clear();
	emit();
}

export function subscribeAgentBridge(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Notify UI that agent roster/state changed. */
export function notifyAgentBridgeChanged(): void {
	emit();
}

/** Active agents for footer/board chips (stateful running + foreground). */
export function countActiveAgents(): number {
	const statefulActive = listStatefulAgents(false).filter(
		(a) => a.state === "starting" || a.state === "running" || a.state === "idle",
	).length;
	const fgActive = listForegroundRuns().filter((r) => r.state === "running").length;
	return statefulActive + fgActive;
}
