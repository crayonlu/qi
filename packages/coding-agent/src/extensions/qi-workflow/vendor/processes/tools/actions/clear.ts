// @ts-nocheck
import type { ExecuteResult } from "../../constants/index.ts";
import type { ProcessManager } from "../../manager.ts";

export function executeClear(manager: ProcessManager): ExecuteResult {
  const cleared = manager.clearFinished();
  const message =
    cleared > 0
      ? `Cleared ${cleared} finished process(es)`
      : "No finished processes to clear";

  return {
    content: [{ type: "text", text: message }],
    details: {
      action: "clear",
      success: true,
      message,
      cleared,
    },
  };
}
