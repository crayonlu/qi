// @ts-nocheck
import type { ExtensionAPI } from "../../pi-coding-agent-shim.ts";
import type { ProcessManager } from "../manager.ts";
import { setupCleanupHook } from "./cleanup.ts";
import { setupProcessEndHook } from "./process-end.ts";
import { setupProcessWatchHook } from "./process-watch.ts";

export function setupProcessesHooks(
  pi: ExtensionAPI,
  manager: ProcessManager,
): void {
  setupCleanupHook(pi, manager);
  setupProcessEndHook(pi, manager);
  setupProcessWatchHook(pi, manager);
}
