import { describe, expect, it } from "vitest";
import { checkpointIdFromGitRef } from "../../src/extensions/qi-workflow/runtime/rewind.ts";
import { REF_BASE } from "../../src/extensions/qi-workflow/vendor/rewind/core.ts";

describe("qi-workflow rewind refs", () => {
	it("stores and parses vendor REF_BASE ids without session nesting", () => {
		const id = "write-file-abc123";
		const gitRef = `${REF_BASE}/${id}`;
		expect(checkpointIdFromGitRef(gitRef)).toBe(id);
		expect(checkpointIdFromGitRef(id)).toBe(id);
		// Legacy mistaken session-nested refs still resolve to a loadable suffix
		expect(checkpointIdFromGitRef(`${REF_BASE}/session-1/${id}`)).toBe(`session-1/${id}`);
	});
});
