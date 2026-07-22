import { describe, expect, it } from "vitest";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import { createEmptyState } from "../../src/extensions/qi-workflow/domain/index.ts";
import { JobManager } from "../../src/extensions/qi-workflow/runtime/job-manager.ts";

describe("qi-workflow job manager", () => {
	it("starts, waits for exit, and records status", async () => {
		workflowController.store.replaceState(createEmptyState("jobs"), false);
		const manager = new JobManager();
		const job = manager.start("echo-job", "echo hello-qi", process.cwd());
		expect(job.status).toBe("running");

		const finished = await manager.wait(job.id, { timeoutMs: 5000 });
		expect(["exited", "killed", "failed"]).toContain(finished.status);
		if (finished.status === "exited") {
			expect(finished.exitCode).toBe(0);
		}

		const logs = manager.logs(job.id, 20);
		expect(logs).toContain("hello-qi");
	});

	it("cancels a long-running job", async () => {
		workflowController.store.replaceState(createEmptyState("jobs"), false);
		const manager = new JobManager();
		const job = await Promise.resolve(manager.start("sleep-job", "sleep 30", process.cwd()));
		manager.cancel(job.id);
		const state = workflowController.getState().jobs.find((j) => j.id === job.id);
		expect(state?.cancelRequested || state?.status === "terminating" || state?.status === "killed").toBe(true);
	});
});
