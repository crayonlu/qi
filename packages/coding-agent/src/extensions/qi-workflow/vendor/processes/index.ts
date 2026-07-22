// @ts-nocheck
import type { ExtensionAPI } from "../pi-coding-agent-shim.ts";
import { configLoader } from "./config.ts";
import { setupProcessesHooks } from "./hooks/index.ts";
import { ProcessManager } from "./manager.ts";
import { setupProcessesTools } from "./tools/index.ts";

/**
 * Detect whether we are running inside a Git Bash session on Windows.
 * Git Bash sets MSYSTEM (e.g. MINGW64, MINGW32, MSYS) and/or SHELL.
 * On Linux/macOS this is irrelevant — the check is a no-op there.
 */
function isGitBash(): boolean {
  const msystem = process.env.MSYSTEM ?? "";
  const shell = process.env.SHELL ?? "";
  return (
    msystem.startsWith("MINGW") ||
    msystem === "MSYS" ||
    shell.toLowerCase().includes("bash")
  );
}

export default async function (pi: ExtensionAPI) {
  // Unix (Linux + macOS): always supported. Windows: only via Git Bash.
  if (process.platform === "win32" && !isGitBash()) {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        "pi-processes requires Git Bash on Windows. Open your terminal in Git Bash and try again.",
        "warning",
      );
    });
    return;
  }

  await configLoader.load();
  const manager = new ProcessManager({
    getConfiguredShellPath: () => configLoader.getConfig().execution.shellPath,
  });

  setupProcessesHooks(pi, manager);
  setupProcessesTools(pi, manager);
}
