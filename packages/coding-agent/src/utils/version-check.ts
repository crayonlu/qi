import { compare, valid } from "semver";
import { getPiUserAgent } from "./pi-user-agent.ts";
import { VERSION } from "../config.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetch(LATEST_VERSION_URL, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

/**
 * Resolve the latest release version from a GitHub repo's "latest release"
 * redirect. `https://github.com/<repo>/releases/latest` 302-redirects to
 * `.../releases/tag/<tag>`, so we follow the redirect and parse the tag from the
 * final URL. This avoids the authenticated api.github.com rate limit entirely.
 *
 * Returns the version with any leading "v" stripped, or undefined if the repo
 * has no releases or the request fails.
 */
export async function getLatestGithubReleaseTag(
	repo: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	const url = `https://github.com/${repo}/releases/latest`;
	try {
		const response = await fetch(url, {
			redirect: "follow",
			headers: {
				"User-Agent": getPiUserAgent(VERSION),
				accept: "application/json",
			},
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
		});
		if (!response.ok) {
			return undefined;
		}
		const finalUrl = response.url;
		const tag = finalUrl.split("/releases/tag/")[1]?.split(/[/?#]/)[0];
		if (!tag) {
			return undefined;
		}
		return tag.replace(/^v/, "");
	} catch {
		return undefined;
	}
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
