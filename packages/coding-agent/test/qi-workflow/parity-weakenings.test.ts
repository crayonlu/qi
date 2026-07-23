import { describe, expect, it } from "vitest";
import {
	buildAskEnvelope,
	mapOverlayToAnswer,
	peekAskVendorReachable,
	validateAskQuestions,
} from "../../src/extensions/qi-workflow/adapters/ask.ts";
import { workflowController } from "../../src/extensions/qi-workflow/controller.ts";
import {
	applyCleanupReport,
	createEmptyState,
	setCleanupReport,
} from "../../src/extensions/qi-workflow/domain/index.ts";
import { JobManager } from "../../src/extensions/qi-workflow/runtime/job-manager.ts";
import {
	DECLINE_MESSAGE,
	ENVELOPE_PREFIX,
} from "../../src/extensions/qi-workflow/vendor/ask/tool/response-envelope.ts";
import { planModeCompleted } from "../../src/extensions/qi-workflow/vendor/plan/completion-tool.ts";

describe("process clear domain sync", () => {
	it("removes finished jobs from domain list after clearFinished", async () => {
		workflowController.store.replaceState(createEmptyState("jobs-clear"), false);
		const manager = new JobManager();
		const job = manager.start("echo-clear", "echo clear-me", process.cwd());
		await manager.wait(job.id, { timeoutMs: 5000 });
		expect(manager.list().some((j) => j.id === job.id)).toBe(true);
		const n = manager.clearFinished();
		expect(n).toBeGreaterThan(0);
		expect(manager.list().some((j) => j.id === job.id)).toBe(false);
		manager.dispose();
	});
});

describe("ask envelope + schema", () => {
	it("rejects missing header/description and builds canonical envelope", () => {
		expect(peekAskVendorReachable()).toBe(true);
		const missing = validateAskQuestions([
			{
				prompt: "Choose?",
				header: "",
				options: [
					{ label: "A", description: "a" },
					{ label: "B", description: "b" },
				],
			},
		]);
		expect(missing.ok).toBe(false);

		const ok = validateAskQuestions([
			{
				prompt: "Choose?",
				header: "Choice",
				options: [
					{ label: "A", description: "option a", preview: "prev-a" },
					{ label: "B", description: "option b" },
				],
			},
		]);
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		const answer = mapOverlayToAnswer(ok.params, 0, { selected: ["A"] });
		expect(answer.preview).toBe("prev-a");
		const envelope = buildAskEnvelope(ok.params, [answer], false);
		expect(envelope.content[0]!.text).toContain(ENVELOPE_PREFIX);
		expect(envelope.content[0]!.text).toContain('"Choose?"="A"');
		const declined = buildAskEnvelope(ok.params, [], true);
		expect(declined.content[0]!.text).toBe(DECLINE_MESSAGE);
	});
});

describe("plan_mode_complete terminate", () => {
	it("planModeCompleted sets terminate true", () => {
		const result = planModeCompleted("# Plan\n\nDo it");
		expect(result.terminate).toBe(true);
		expect(result.details.plan).toContain("Do it");
	});
});

describe("cleanup apply keeps all paths", () => {
	it("does not truncate stored paths beyond 20", () => {
		workflowController.store.replaceState(createEmptyState("cleanup-paths"), false);
		const paths = Array.from({ length: 25 }, (_, i) => `/tmp/qi-cleanup-${i}`);
		const set = workflowController.apply((s) =>
			setCleanupReport(s, [{ id: "cat_0", label: "test", count: paths.length, bytes: 0, paths }], true),
		);
		expect(set.ok).toBe(true);
		if (!set.ok) return;
		expect(set.value.categories[0]!.paths.length).toBe(25);
		const applied = workflowController.apply((s) => applyCleanupReport(s));
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		expect(applied.value.categories[0]!.paths.length).toBe(25);
	});
});
