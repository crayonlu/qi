// @ts-nocheck
import type { ExtensionAPI } from "../../pi-coding-agent-shim.ts";
import type { ProcessManager } from "../manager.ts";

export function setupCleanupHook(pi: ExtensionAPI, manager: ProcessManager) {
  pi.on("session_shutdown", () => {
    manager.stopWatcher();
    manager.shutdownKillAll();
    manager.cleanup();
  });
}
