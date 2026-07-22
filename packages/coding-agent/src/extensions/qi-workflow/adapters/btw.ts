/**
 * /btw adapter — Qi runtime uses branch-clone completeSimple (rpiv-btw pattern).
 * Vendor package UI/settings file is not retained; Qi owns /btw UX.
 */

import { runBtwSideTurn } from "../runtime/btw-side-turn.ts";

/** Upstream pi-btw settings filename (provenance only; Qi does not load this file). */
export const BTW_SETTINGS_FILE = "pi-btw.json";

export function peekBtwVendorReachable(): boolean {
	return typeof runBtwSideTurn === "function";
}

export { runBtwSideTurn };
