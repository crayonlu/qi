/**
 * /btw adapter — Qi runtime uses branch-clone completeSimple (rpiv-btw pattern).
 * vendor/btw and vendor/btw-rpiv hold the adopted side-turn/UI sources.
 */

import { runBtwSideTurn } from "../runtime/btw-side-turn.ts";
import { BTW_SETTINGS_FILE } from "../vendor/btw/btw.ts";

export function peekBtwVendorReachable(): boolean {
	return typeof BTW_SETTINGS_FILE === "string" && typeof runBtwSideTurn === "function";
}

export { runBtwSideTurn, BTW_SETTINGS_FILE };
