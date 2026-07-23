/**
 * /btw adapter — Qi UI placement + rpiv-btw mature runtime (runtime/btw-side-turn).
 */

import {
	clearBtwHistory,
	peekBtwRuntimeReachable,
	registerBtwLifecycleHooks,
	runBtwSideTurn,
} from "../runtime/btw-side-turn.ts";

export function peekBtwVendorReachable(): boolean {
	return peekBtwRuntimeReachable();
}

export { clearBtwHistory, registerBtwLifecycleHooks, runBtwSideTurn };
