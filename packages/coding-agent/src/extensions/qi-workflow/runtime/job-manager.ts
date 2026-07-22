/**
 * Qi job manager — ProcessManager (stdin, disk logs, process groups) + domain JobEntity sync.
 */

import { readFileSync } from "node:fs";
import { workflowController } from "../controller.ts";
import {
	cancelJob,
	clearFinishedJobs,
	finishJob,
	JOB_DEFAULT_TAIL_LINES,
	type JobEntity,
	type JobStatus,
	recoverJobStatuses,
	startJob,
	updateJobOutput,
} from "../domain/index.ts";
import { ProcessManager } from "../vendor/processes/manager.ts";

const TERMINAL: ReadonlySet<JobStatus> = new Set(["exited", "killed", "failed", "unknown"]);

function findJob(id: string): JobEntity | undefined {
	const state = workflowController.getState();
	return state.jobs.find((job) => job.id === id || job.id.endsWith(id));
}

/**
 * Manages shell child processes via vendor ProcessManager.
 * Domain state remains the source of truth for JobEntity fields.
 */
export class JobManager {
	private readonly processes = new ProcessManager();
	/** Map domain job id → process manager id */
	private readonly processByJob = new Map<string, string>();
	private readonly jobByProcess = new Map<string, string>();
	private unsub: (() => void) | undefined;

	constructor() {
		this.unsub = this.processes.onEvent((event) => {
			if (event.type === "process_output_changed") {
				const jobId = this.jobByProcess.get(event.id);
				if (!jobId) return;
				const info = this.processes.get(event.id);
				if (!info) return;
				try {
					const bytes = readFileSync(info.stdoutFile).byteLength + readFileSync(info.stderrFile).byteLength;
					const job = findJob(jobId);
					if (!job) return;
					const added = Math.max(0, bytes - job.outputBytes);
					if (added > 0) {
						workflowController.apply((state) => updateJobOutput(state, jobId, added));
					}
				} catch {
					// ignore log read races
				}
				return;
			}

			if (event.type === "process_ended") {
				const jobId = this.jobByProcess.get(event.info.id);
				if (!jobId) return;
				const info = event.info;
				const cancelRequested = findJob(jobId)?.cancelRequested === true;
				let status: Exclude<JobStatus, "running" | "terminating">;
				if (info.status === "killed" || cancelRequested) status = "killed";
				else if (info.success === false && info.exitCode === null) status = "failed";
				else status = "exited";
				workflowController.apply((state) => finishJob(state, jobId, status, info.exitCode ?? undefined));
			}
		});
	}

	start(name: string, command: string, cwd: string, opts?: { workflowId?: string }): JobEntity {
		const info = this.processes.start(name, command, cwd);
		const created = workflowController.apply((state) =>
			startJob(state, name, command, cwd, {
				workflowId: opts?.workflowId,
				pid: info.pid > 0 ? info.pid : undefined,
				logPath: info.stdoutFile,
			}),
		);
		if (!created.ok) {
			void this.processes.kill(info.id, { signal: "SIGKILL" });
			throw new Error(created.error);
		}

		const job = created.value;
		this.processByJob.set(job.id, info.id);
		this.jobByProcess.set(info.id, job.id);
		return findJob(job.id) ?? job;
	}

	status(id: string): JobEntity | undefined {
		return findJob(id);
	}

	list(): JobEntity[] {
		return workflowController.getState().jobs.slice();
	}

	/** Structured process output (stdout/stderr/both). */
	output(
		id: string,
		opts?: { tail?: number; stream?: "stdout" | "stderr" | "both" },
	): { text: string; stdoutBytes: number; stderrBytes: number } {
		const job = findJob(id);
		if (!job) throw new Error(`Job not found: ${id}`);
		const processId = this.processByJob.get(job.id);
		const tail = Math.max(0, Math.floor(opts?.tail ?? JOB_DEFAULT_TAIL_LINES));
		const stream = opts?.stream ?? "both";
		if (processId) {
			const parted = this.processes.getOutput(processId, tail);
			const full = this.processes.getFullOutput(processId);
			const stdoutBytes = full?.stdout.length ?? 0;
			const stderrBytes = full?.stderr.length ?? 0;
			if (!parted) return { text: "", stdoutBytes, stderrBytes };
			if (stream === "stdout") return { text: parted.stdout.join("\n"), stdoutBytes, stderrBytes };
			if (stream === "stderr") return { text: parted.stderr.join("\n"), stdoutBytes, stderrBytes };
			const combined = this.processes.getCombinedOutput(processId, tail);
			return {
				text: combined?.map((line) => line.text).join("\n") ?? "",
				stdoutBytes,
				stderrBytes,
			};
		}
		return { text: this.logs(id, tail), stdoutBytes: job.outputBytes, stderrBytes: 0 };
	}

	clearFinished(): number {
		const cleared = this.processes.clearFinished();
		const jobs = workflowController.getState().jobs;
		for (const job of jobs) {
			if (!TERMINAL.has(job.status)) continue;
			const processId = this.processByJob.get(job.id);
			if (processId) {
				this.processByJob.delete(job.id);
				this.jobByProcess.delete(processId);
			}
		}
		const domain = workflowController.apply((state) => clearFinishedJobs(state));
		const removed = domain.ok ? domain.value.removed : 0;
		return Math.max(cleared, removed);
	}

	shutdownKillAll(): void {
		this.processes.shutdownKillAll();
	}

	logs(id: string, tail: number = JOB_DEFAULT_TAIL_LINES): string {
		const job = findJob(id);
		const processId = job ? this.processByJob.get(job.id) : undefined;
		if (processId) {
			const combined = this.processes.getCombinedOutput(processId, Math.max(0, Math.floor(tail)));
			if (combined) {
				return combined.map((line) => line.text).join("\n");
			}
		}
		const path = job?.logPath;
		if (!path) return "";
		try {
			const text = readFileSync(path, "utf8");
			const lines = text.split("\n");
			const n = Math.max(0, Math.floor(tail));
			return n === 0 ? "" : lines.slice(-n).join("\n");
		} catch {
			return "";
		}
	}

	/** Write to a running job's stdin (ProcessManager capability). */
	write(id: string, data: string, opts?: { end?: boolean }): void {
		const job = findJob(id);
		if (!job) throw new Error(`Job not found: ${id}`);
		const processId = this.processByJob.get(job.id);
		if (!processId) throw new Error(`No live process for job: ${job.id}`);
		const result = this.processes.writeToStdin(processId, data, { end: opts?.end === true });
		if (!result.ok) throw new Error(result.reason);
	}

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
		const processId = this.processByJob.get(job.id);
		if (processId) {
			void this.processes.kill(processId, { signal: "SIGTERM" });
		}
		return findJob(job.id) ?? job;
	}

	recover(): void {
		workflowController.apply((state) => recoverJobStatuses(state));
	}

	dispose(): void {
		this.unsub?.();
		this.unsub = undefined;
	}
}

export const jobManager = new JobManager();
