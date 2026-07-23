import { describe, expect, it } from "vitest";

/**
 * Mirrors InteractiveMode.enqueueExtensionUi — concurrent dialogs must not
 * orphan earlier Promises (the subagent model-picker hang).
 */
function createUiQueue() {
	let chain: Promise<void> = Promise.resolve();
	return function enqueue<T>(run: () => Promise<T>): Promise<T> {
		const result = chain.then(run, run);
		chain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
}

describe("extension UI dialog queue", () => {
	it("runs selects serially so the first Promise still resolves", async () => {
		const enqueue = createUiQueue();
		const order: string[] = [];
		let resolveFirst!: (v: string) => void;
		let resolveSecond!: (v: string) => void;

		const first = enqueue(
			() =>
				new Promise<string>((resolve) => {
					order.push("first-shown");
					resolveFirst = resolve;
				}),
		);
		const second = enqueue(
			() =>
				new Promise<string>((resolve) => {
					order.push("second-shown");
					resolveSecond = resolve;
				}),
		);

		await Promise.resolve();
		expect(order).toEqual(["first-shown"]);
		expect(resolveSecond).toBeUndefined();

		resolveFirst("model-a");
		await expect(first).resolves.toBe("model-a");
		await Promise.resolve();
		expect(order).toEqual(["first-shown", "second-shown"]);

		resolveSecond("model-b");
		await expect(second).resolves.toBe("model-b");
	});
});
