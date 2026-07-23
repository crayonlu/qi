import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME, UPDATE_REPO } from "../src/config.ts";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getDistributionLatestRelease,
	getLatestGithubReleaseTag,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;

beforeEach(() => {
	delete process.env.PI_OFFLINE;
	delete process.env.PI_SKIP_VERSION_CHECK;
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.PI_OFFLINE;
	} else {
		process.env.PI_OFFLINE = originalOffline;
	}
});

function stubGithubLatestTag(version: string): ReturnType<typeof vi.fn> {
	return vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes("github.com") && url.includes("/releases/latest")) {
			const response = new Response("", { status: 200 });
			Object.defineProperty(response, "url", {
				value: `https://github.com/${UPDATE_REPO ?? "crayonlu/qi"}/releases/tag/v${version}`,
			});
			return response;
		}
		return Response.json({ version });
	});
}

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = stubGithubLatestTag("1.2.3");
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		const newer = await checkForNewPiVersion("1.2.2");
		expect(fetchMock).toHaveBeenCalled();
		if (UPDATE_REPO) {
			expect(newer).toEqual({ version: "1.2.3", packageName: PACKAGE_NAME });
		} else {
			expect(newer).toEqual({ version: "1.2.3" });
		}
	});

	it("uses the pi.dev version check api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://pi.dev/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/pi",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("resolves distribution latest release from GitHub when updateRepo is set", async () => {
		if (!UPDATE_REPO) return;
		const fetchMock = stubGithubLatestTag("9.9.9");
		vi.stubGlobal("fetch", fetchMock);

		await expect(getDistributionLatestRelease("1.0.0")).resolves.toEqual({
			version: "9.9.9",
			packageName: PACKAGE_NAME,
		});
		await expect(getLatestGithubReleaseTag(UPDATE_REPO)).resolves.toBe("9.9.9");
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`https://github.com/${UPDATE_REPO}/releases/latest`);
	});
});
