import { type ChildProcess, spawn } from "node:child_process";
import { workflowController } from "../controller.ts";
import {
	cancelJob,
	finishJob,
	JOB_DEFAULT_TAIL_LINES,
	JOB_KILL_TIMEOUT_MS,
	JOB_MAX_OUTPUT_BYTES,
	type JobEntity,
	type JobStatus,
	recoverJobStatuses,
	startJob,
	updateJobOutput,
} from "../domain/index.ts";

interface LiveJob {
	child: ChildProcess;
	/** Bounded combined stdout/stderr bytes (UTF-8). */
	output: Buffer;
	outputBytes: number;
	truncated: boolean;
	exitCode: number | null;
	ended: boolean;
	killTimer: ReturnType<typeof setTimeout> | undefined;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(["exited", "killed", "failed", "unknown"]);

function appendBounded(live: LiveJob, chunk: Buffer): number {
	const remaining = JOB_MAX_OUTPUT_BYTES - live.outputBytes;
	if (remaining <= 0) {
		live.truncated = true;
		return 0;
	}
	const take = Math.min(remaining, chunk.length);
	if (take < chunk.length) live.truncated = true;
	live.output = Buffer.concat([live.output, chunk.subarray(0, take)]);
	live.outputBytes += take;
	return take;
}

function findJob(id: string): JobEntity | undefined {
	const state = workflowController.getState();
	return state.jobs.find((job) => job.id === id || job.id.endsWith(id));
}

/**
 * Manages shell child processes for Qi jobs.
 * Domain state is the source of truth; the live map holds only in-process ChildProcess handles.
 * After restart the live map is empty and recoverJobStatuses marks orphaned jobs unknown.
 */
export class JobManager {
	private readonly live = new Map<string, LiveJob>();
	/** Retained after process exit so logs/status remain inspectable in-session. */
	private readonly archives = new Map<string, LiveJob>();

	start(name: string, command: string, cwd: string, opts?: { workflowId?: string }): JobEntity {
		const child = spawn(command, {
			cwd,
			shell: true,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const created = workflowController.apply((state) =>
			startJob(state, name, command, cwd, {
				workflowId: opts?.workflowId,
				pid: child.pid,
			}),
		);
		if (!created.ok) {
			child.kill("SIGKILL");
			throw new Error(created.error);
		}

		const job = created.value;
		const live: LiveJob = {
			child,
			output: Buffer.alloc(0),
			outputBytes: 0,
			truncated: false,
			exitCode: null,
			ended: false,
			killTimer: undefined,
		};
		this.live.set(job.id, live);

		const onChunk = (chunk: Buffer) => {
			const added = appendBounded(live, chunk);
			if (added > 0) {
				workflowController.apply((state) => updateJobOutput(state, job.id, added));
			}
		};
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);

		child.on("error", (err) => {
			if (live.ended) return;
			live.ended = true;
			this.clearKillTimer(live);
			const msg = err.message || "spawn failed";
			const added = appendBounded(live, Buffer.from(`\n${msg}\n`));
			if (added > 0) {
				workflowController.apply((state) => updateJobOutput(state, job.id, added));
			}
			workflowController.apply((state) => finishJob(state, job.id, "failed"));
			this.archives.set(job.id, live);
			this.live.delete(job.id);
		});

		child.on("close", (code, signal) => {
			if (live.ended) return;
			live.ended = true;
			this.clearKillTimer(live);
			live.exitCode = code;
			const cancelRequested = findJob(job.id)?.cancelRequested === true;
			let status: Exclude<JobStatus, "running" | "terminating">;
			if (signal === "SIGKILL" || (cancelRequested && signal)) {
				status = "killed";
			} else if (code === 0) {
				status = "exited";
			} else if (code === null && signal) {
				status = "killed";
			} else {
				status = "exited";
			}
			workflowController.apply((state) => finishJob(state, job.id, status, code ?? undefined));
			this.archives.set(job.id, live);
			this.live.delete(job.id);
		});

		return findJob(job.id) ?? job;
	}

	status(id: string): JobEntity | undefined {
		return findJob(id);
	}

	logs(id: string, tail: number = JOB_DEFAULT_TAIL_LINES): string {
		const live =
			this.live.get(id) ?? this.findLiveBySuffix(id) ?? this.archives.get(id) ?? this.findArchiveBySuffix(id);
		const text = live ? live.output.toString("utf8") : "";
		const lines = text.split("\n");
		const n = Math.max(0, Math.floor(tail));
		const sliced = n === 0 ? [] : lines.slice(-n);
		const suffix = live?.truncated ? "\n…[output truncated]" : "";
		return (
			sliced.join("\n") +
			(live?.truncated && sliced.length > 0 ? suffix : live?.truncated ? "…[output truncated]" : "")
		);
	}

	/**
	 * Poll until the job reaches a terminal domain status (or timeout).
	 * Does not busy-wait; yields via setTimeout.
	 */
	async wait(id: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<JobEntity> {
		const timeoutMs = opts?.timeoutMs ?? 0;
		const pollMs = Math.max(25, opts?.pollMs ?? 100);
		const started = Date.now();

		for (;;) {
			const job = findJob(id);
			if (!job) throw new Error(`Job not found: ${id}`);
			if (TERMINAL.has(job.status)) return job;
			if (timeoutMs > 0 && Date.now() - started >= timeoutMs) {
				throw new Error(`Job wait timed out: ${job.id}`);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
		}
	}

	cancel(id: string): JobEntity {
		const cancelled = workflowController.apply((state) => cancelJob(state, id));
		if (!cancelled.ok) throw new Error(cancelled.error);

		const job = cancelled.value;
		const live = this.live.get(job.id) ?? this.findLiveBySuffix(id);
		if (!live || live.ended) return findJob(job.id) ?? job;

		try {
			live.child.kill("SIGTERM");
		} catch {
			// Process may have already exited.
		}

		this.clearKillTimer(live);
		live.killTimer = setTimeout(() => {
			if (live.ended) return;
			try {
				live.child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}, JOB_KILL_TIMEOUT_MS);

		return findJob(job.id) ?? job;
	}

	/** Mark running/terminating jobs unknown after process restart (live map is empty). */
	recover(): void {
		workflowController.apply((state) => recoverJobStatuses(state));
	}

	private findLiveBySuffix(id: string): LiveJob | undefined {
		for (const [jobId, live] of this.live) {
			if (jobId === id || jobId.endsWith(id)) return live;
		}
		return undefined;
	}

	private findArchiveBySuffix(id: string): LiveJob | undefined {
		for (const [jobId, live] of this.archives) {
			if (jobId === id || jobId.endsWith(id)) return live;
		}
		return undefined;
	}

	private clearKillTimer(live: LiveJob): void {
		if (live.killTimer !== undefined) {
			clearTimeout(live.killTimer);
			live.killTimer = undefined;
		}
	}
}

export const jobManager = new JobManager();
