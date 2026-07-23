import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME, VERSION } from "../config.ts";
import { getLatestGithubReleaseTag, isNewerPackageVersion } from "./version-check.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

/**
 * Self-update for compiled (`bun build --compile`) binaries.
 *
 * Unlike the npm-based self-update (which reinstalls a global package), a
 * compiled binary updates by downloading the matching release artifact from the
 * distribution's GitHub Releases and replacing itself in place.
 */

/** Map the current platform/arch to the release artifact name produced by build-binaries.sh. */
export function getReleaseArtifactName(platform: NodeJS.Platform, arch: string): string {
	switch (platform) {
		case "darwin":
			return `pi-darwin-${arch}.tar.gz`;
		case "linux":
			return `pi-linux-${arch}.tar.gz`;
		case "win32":
			return `pi-windows-${arch}.zip`;
		default:
			throw new Error(`Unsupported platform for self-update: ${platform}`);
	}
}

export async function runBinarySelfUpdate(force: boolean, repo: string): Promise<void> {
	const latest = await getLatestGithubReleaseTag(repo);
	if (!latest) {
		throw new Error(`Could not determine latest ${APP_NAME} version from ${repo}.`);
	}
	if (!force && !isNewerPackageVersion(latest, VERSION)) {
		console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
		return;
	}

	const artifact = getReleaseArtifactName(process.platform, process.arch);
	const downloadUrl = `https://github.com/${repo}/releases/download/v${latest}/${artifact}`;
	console.log(chalk.dim(`Updating ${APP_NAME} from v${VERSION} to v${latest}...`));

	const archivePath = await downloadFile(downloadUrl);
	try {
		const binaryPath = extractBinary(archivePath, process.platform);
		replaceSelf(binaryPath);
	} finally {
		rmSync(archivePath, { force: true });
	}

	console.log(chalk.green(`Updated ${APP_NAME} to v${latest}.`));
}

async function downloadFile(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: { "User-Agent": getPiUserAgent(VERSION) },
	});
	if (!response.ok) {
		throw new Error(`Download failed (${response.status}) for ${url}`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	const dest = join(tmpdir(), `pi-update-${process.pid}-${Date.now()}`);
	writeFileSync(dest, buffer);
	return dest;
}

function extractBinary(archivePath: string, platform: NodeJS.Platform): string {
	const destDir = join(tmpdir(), `pi-update-extract-${process.pid}-${Date.now()}`);
	mkdirSync(destDir, { recursive: true });

	if (platform === "win32") {
		const result = spawnSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				`Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
			],
			{ stdio: "ignore" },
		);
		if (result.status !== 0) {
			throw new Error("Failed to extract update archive");
		}
	} else {
		const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "ignore" });
		if (result.status !== 0) {
			throw new Error("Failed to extract update archive");
		}
	}

	const binaryName = platform === "win32" ? "pi.exe" : "pi";
	const found = findFile(destDir, binaryName);
	if (!found) {
		throw new Error(`Could not find ${binaryName} in update archive`);
	}
	return found;
}

function findFile(dir: string, name: string): string | undefined {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			const nested = findFile(full, name);
			if (nested) return nested;
		} else if (entry.name === name) {
			return full;
		}
	}
	return undefined;
}

/**
 * Replace the running executable with the downloaded binary.
 *
 * - Unix: atomic rename over the running binary (the live process keeps the old
 *   inode mapped). Strips the macOS quarantine attribute so Gatekeeper doesn't
 *   block the new binary.
 * - Windows: the running .exe is locked, so a detached PowerShell waits for this
 *   process to exit and then swaps the file in. The update completes on restart.
 */
function replaceSelf(binaryPath: string): void {
	const target = process.execPath;
	chmodSync(binaryPath, 0o755);

	if (process.platform === "win32") {
		const newPath = `${target}.new`;
		copyFileSync(binaryPath, newPath);
		const script = `
$pidToWait = ${process.pid}
while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }
try { Move-Item -Force '${newPath}' '${target}' } catch { }
`;
		const child = spawn("powershell", ["-NoProfile", "-Command", script], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		console.log(
			chalk.yellow(`A pending update will be applied when ${APP_NAME} exits. Restart ${APP_NAME} to finish.`),
		);
		return;
	}

	renameSync(binaryPath, target);
	if (process.platform === "darwin") {
		spawn("xattr", ["-dr", "com.apple.quarantine", target], { stdio: "ignore" }).unref();
	}
}
