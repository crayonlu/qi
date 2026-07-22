#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const upstreamRepo = process.env.UPSTREAM_REPO || "earendil-works/pi-mono";
const remoteName = process.env.UPSTREAM_REMOTE_NAME || "upstream-pi";
const remoteUrl =
  process.env.UPSTREAM_REMOTE_URL || `https://github.com/${upstreamRepo}.git`;
const markerPath =
  process.env.UPSTREAM_SYNC_MARKER || ".github/upstream-pi-release.json";
const baseBranch = process.env.UPSTREAM_SYNC_BASE_BRANCH || "main";
const explicitTag = (process.env.UPSTREAM_RELEASE_TAG || "").trim();
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function tryRun(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function assertCleanWorktree() {
  const status = run("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error(
      [
        "Refusing to sync upstream release with a dirty worktree.",
        "Run this workflow in CI or commit/stash local changes first.",
        status,
      ].join("\n"),
    );
  }
}

function readMarker() {
  if (!existsSync(markerPath)) return {};
  return JSON.parse(readFileSync(markerPath, "utf8"));
}

async function githubJson(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "qi-upstream-release-sync",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${path} failed: ${response.status} ${response.statusText}\n${body}`,
    );
  }
  return response.json();
}

async function resolveRelease() {
  if (explicitTag) {
    const release = await githubJson(
      `/repos/${upstreamRepo}/releases/tags/${encodeURIComponent(explicitTag)}`,
    );
    return {
      tag: release.tag_name,
      name: release.name || release.tag_name,
      url: release.html_url,
      publishedAt: release.published_at || release.created_at || "",
    };
  }

  const release = await githubJson(`/repos/${upstreamRepo}/releases/latest`);
  return {
    tag: release.tag_name,
    name: release.name || release.tag_name,
    url: release.html_url,
    publishedAt: release.published_at || release.created_at || "",
  };
}

function sanitizeTag(tag) {
  return tag.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function ensureRemote() {
  const current = tryRun("git", ["remote", "get-url", remoteName]);
  if (current.ok) {
    if (current.stdout.trim() !== remoteUrl) {
      run("git", ["remote", "set-url", remoteName, remoteUrl]);
    }
    return;
  }
  run("git", ["remote", "add", remoteName, remoteUrl]);
}

function mergeRelease(tag) {
  const target = `${tag}^{commit}`;
  run("git", ["fetch", remoteName, "--tags", "--prune"]);
  run("git", ["fetch", remoteName, `refs/tags/${tag}:refs/tags/${tag}`]);
  run("git", ["rev-parse", "--verify", target]);

  const merge = tryRun("git", ["merge", "--no-ff", "--no-commit", target]);
  if (!merge.ok) {
    const conflicts = run("git", ["diff", "--name-only", "--diff-filter=U"]);
    tryRun("git", ["merge", "--abort"]);
    throw new MergeConflictError(tag, conflicts, merge.stdout, merge.stderr);
  }

  return run("git", ["rev-parse", target]);
}

function writeMarker(release, upstreamCommit) {
  const payload = {
    repository: upstreamRepo,
    lastProcessedTag: release.tag,
    lastProcessedAt: release.publishedAt || new Date().toISOString(),
    upstreamCommit,
    releaseUrl: release.url,
    note: "Updated by sync-upstream-pi-release.yml after creating a reviewable upstream sync PR.",
	};
	writeFileSync(`${markerPath}.tmp`, `${JSON.stringify(payload, null, 2)}\n`);
	renameSync(`${markerPath}.tmp`, markerPath);
}

function commitSync(tag) {
  const status = run("git", ["status", "--porcelain"]);
  if (!status) return false;
  run("git", ["add", markerPath]);
  run("git", ["commit", "-m", `chore: sync upstream Pi ${tag}`]);
  return true;
}

function pushBranch(branch) {
  run("git", ["push", "--set-upstream", "origin", `HEAD:${branch}`]);
}

function prBody(release) {
  return [
    `Sync Qi with upstream Pi release ${release.tag}.`,
    "",
    `Upstream release: ${release.url}`,
    "",
    "Review checklist:",
    "- Verify Qi built-in workflow integrations still compile.",
    "- Confirm vendor-adapted UI remains owned by Qi, not package-local panels.",
    "- Run `npm run check` after resolving any upstream conflicts.",
    "- Keep the upstream marker update in this PR only after the merge is accepted.",
  ].join("\n");
}

function createOrUpdatePr(branch, release) {
  const existing = tryRun("gh", [
    "pr",
    "view",
    branch,
    "--json",
    "url",
    "--jq",
    ".url",
  ]);

  if (existing.ok && existing.stdout.trim()) {
    run("gh", [
      "pr",
      "edit",
      branch,
      "--title",
      `chore: sync upstream Pi ${release.tag}`,
      "--body",
      prBody(release),
    ]);
    console.log(`Updated existing upstream sync PR: ${existing.stdout.trim()}`);
    return;
  }

  const created = run("gh", [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    `chore: sync upstream Pi ${release.tag}`,
    "--body",
    prBody(release),
  ]);
  console.log(created);
}

function createConflictIssue(error, release) {
  const body = [
    `Automatic upstream Pi sync for ${release.tag} could not be merged cleanly.`,
    "",
    `Upstream release: ${release.url}`,
    "",
    "Conflicted files:",
    "",
    error.conflicts || "(git did not report conflicted files)",
    "",
    "Merge stdout:",
    "```text",
    error.stdout.trim() || "(empty)",
    "```",
    "",
    "Merge stderr:",
    "```text",
    error.stderr.trim() || "(empty)",
    "```",
  ].join("\n");

  const bodyPath = join(tmpdir(), `qi-upstream-conflict-${Date.now()}.md`);
  writeFileSync(bodyPath, body);
  const issue = run("gh", [
    "issue",
    "create",
    "--title",
    `Upstream Pi ${release.tag} sync has merge conflicts`,
    "--body-file",
    bodyPath,
  ]);
  console.log(issue);
}

class MergeConflictError extends Error {
  constructor(tag, conflicts, stdout, stderr) {
    super(`Upstream Pi ${tag} has merge conflicts.`);
    this.name = "MergeConflictError";
    this.conflicts = conflicts;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

async function main() {
  assertCleanWorktree();

  const release = await resolveRelease();
  const marker = readMarker();
  if (marker.lastProcessedTag === release.tag && !explicitTag) {
    console.log(`Upstream Pi ${release.tag} already processed; no action.`);
    return;
  }

  ensureRemote();
  run("git", ["fetch", "origin", baseBranch]);
  run("git", ["checkout", "-B", baseBranch, `origin/${baseBranch}`]);

  const branch = `automation/upstream-pi-${sanitizeTag(release.tag)}`;
  run("git", ["checkout", "-B", branch]);

  try {
    const upstreamCommit = mergeRelease(release.tag);
    writeMarker(release, upstreamCommit);
    const committed = commitSync(release.tag);
    if (!committed) {
      console.log(`Upstream Pi ${release.tag} produced no repository changes.`);
      return;
    }
    pushBranch(branch);
    createOrUpdatePr(branch, release);
  } catch (error) {
    if (error instanceof MergeConflictError) {
      if (process.env.CREATE_ISSUE_ON_CONFLICT === "false") throw error;
      createConflictIssue(error, release);
      return;
    }
    throw error;
  }
}

await main();
