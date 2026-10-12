/**
 * TPA 独立文稿：程序检查（后台 worker）。
 *
 * 硬性要求（审查修正项 5）：
 * - 解压与比较必须在**可终止的后台 worker** 里跑，主线程不做同步重活；
 * - 2 秒硬截止：超时就 `terminate()`，结论记 `unverified`，绝不虚报通过；
 * - 预算：单文件 32 MiB、解包 64 MiB、单 XML 8 MiB、部件 1 万，并发 2；
 * - worker 起不来（打包缺失/路径不可解析）也是 `unverified`，不静默降级成同步解析。
 *
 * 解析与比较的**唯一实现**在 `documentInspectionCore.cjs`（worker 内 require）。
 * 程序格式检查只说明实际覆盖的内容，不等于渲染验收。
 */
import { Worker } from "node:worker_threads";
import { workFail, workOk, DOCUMENT_WORK_BUDGETS, type WorkResult } from "../../shared/documentWork";
import type { DocumentInspection } from "../../shared/types/documentWork";

export const DOCUMENT_INSPECTOR_VERSION = "doc-inspector-v2";

export type InspectionTarget = { absolutePath: string; relativePath: string; existenceOnly?: boolean };
export type InspectionRequest = { base?: InspectionTarget; candidate: InspectionTarget; scope: DocumentInspection["channels"] extends never ? never : import("../../shared/types/documentWork").DocumentChangeScope };

/** 主线程只读字节；workers 只收字节与范围。 */
export type InspectionPorts = {
	read(path: string, maxBytes: number): Buffer | undefined;
	/** 解析 worker 与 core 的路径；返回 undefined 表示当前环境不可用（记 unverified）。 */
	resolveWorkerPaths(): { workerPath: string; corePath: string } | undefined;
	now?: () => number;
	/** 超时覆盖点（默认取共享预算）。 */
	timeoutMs?: number;
	/** 只有在显式给出时才注入 worker 的测试延迟（默认不传）。 */
	testDelayMs?: number;
};

type WorkerOutcome = { ok: true; value: DocumentInspection } | { ok: false; reason: string };

export class DocumentInspectionService {
	private readonly ports: InspectionPorts;
	private readonly running = new Set<Worker>();
	private readonly waiters: Array<() => void> = [];
	private active = 0;
	private closed = false;

	constructor(ports: InspectionPorts) {
		this.ports = ports;
	}

	/** 停止服务：终止所有在跑的 worker（退出清理路径必须走到）。 */
	async shutdown(): Promise<void> {
		this.closed = true;
		const workers = [...this.running];
		await Promise.allSettled(workers.map((worker) => worker.terminate()));
		this.running.clear();
	}

	/** 诊断/测试：当前在跑的 worker 数。 */
	runningWorkers(): number {
		return this.running.size;
	}

	private async acquire(): Promise<void> {
		if (this.active < DOCUMENT_WORK_BUDGETS.concurrentInspections) {
			this.active++;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.active++;
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		const next = this.waiters.shift();
		if (next) next();
	}

	private unverified(request: InspectionRequest, reason: string): WorkResult<DocumentInspection> {
		const now = (this.ports.now ?? (() => Date.now()))();
		return workOk({
			schemaVersion: 1,
			status: "unverified",
			channels: [
				{ channel: "fingerprint", status: "unverified", coverage: request.candidate.relativePath, reason },
				{ channel: "text", status: "unverified", coverage: "not inspected", reason },
				{ channel: "format", status: "unverified", coverage: "not inspected", reason },
			],
			inspectorVersion: DOCUMENT_INSPECTOR_VERSION,
			bytes: 0,
			budgetBytes: DOCUMENT_WORK_BUDGETS.artifactBytes,
			elapsedMs: 0,
			reason,
		});
	}

	/** 在 worker 里跑一个任务；超时/启动失败都返回结构化失败。 */
	private async runJob(job: Record<string, unknown>, transferable: Buffer[]): Promise<WorkerOutcome> {
		if (this.closed) return { ok: false, reason: "the inspection service is shutting down" };
		const paths = this.ports.resolveWorkerPaths();
		if (!paths) return { ok: false, reason: "the inspection worker is not available in this build" };
		const timeoutMs = this.ports.timeoutMs ?? DOCUMENT_WORK_BUDGETS.inspectionMs;
		let worker: Worker;
		try {
			worker = new Worker(paths.workerPath, { workerData: { corePath: paths.corePath, job, ...(this.ports.testDelayMs === undefined ? {} : { testDelayMs: this.ports.testDelayMs }) } });
		} catch (error) {
			return { ok: false, reason: `the inspection worker could not start: ${error instanceof Error ? error.message : String(error)}` };
		}
		this.running.add(worker);
		// 传递字节所有权：worker 只读副本，主线程不再动这些 buffer。
		void transferable;
		return await new Promise<WorkerOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: WorkerOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.running.delete(worker);
				// 结果已到也要 terminate：worker 不留常驻线程。
				void worker.terminate().catch(() => undefined);
				resolve(outcome);
			};
			const timer = setTimeout(() => {
				// 硬截止：同步死循环也能被 terminate 打断。
				void worker.terminate().catch(() => undefined);
				finish({ ok: false, reason: `the inspection did not finish within ${timeoutMs}ms` });
			}, timeoutMs);
			timer.unref?.();
			worker.once("message", (message: unknown) => {
				if (typeof message === "object" && message !== null && "status" in message) finish({ ok: true, value: message as DocumentInspection });
				else if (typeof message === "object" && message !== null && "reason" in message) finish({ ok: false, reason: String((message as { reason: unknown }).reason) });
				else finish({ ok: false, reason: "the inspection worker returned an unusable result" });
			});
			worker.once("error", (error: Error) => finish({ ok: false, reason: `the inspection worker failed: ${error.message}` }));
			worker.once("exit", (code: number) => {
				if (!settled && code !== 0) finish({ ok: false, reason: `the inspection worker exited with code ${code}` });
			});
		});
	}

	async inspect(request: InspectionRequest): Promise<WorkResult<DocumentInspection>> {
		if (request.candidate.existenceOnly) return this.unverified(request, "the file exceeded the byte budget; only existence was recorded");
		const candidateBytes = this.ports.read(request.candidate.absolutePath, DOCUMENT_WORK_BUDGETS.artifactBytes);
		if (!candidateBytes) return this.unverified(request, "the candidate is missing, unreadable or over the byte budget");
		let baseBytes: Buffer | undefined;
		if (request.base) {
			baseBytes = this.ports.read(request.base.absolutePath, DOCUMENT_WORK_BUDGETS.artifactBytes);
			if (!baseBytes) return this.unverified(request, "the frozen base copy is not readable");
		}
		await this.acquire();
		try {
			const outcome = await this.runJob(
				{
					kind: "compare",
					candidateRelativePath: request.candidate.relativePath,
					candidateBytes,
					...(request.base && baseBytes ? { baseRelativePath: request.base.relativePath, baseBytes } : {}),
					scope: request.scope,
					budgetBytes: DOCUMENT_WORK_BUDGETS.artifactBytes,
				},
				[baseBytes, candidateBytes].filter((value): value is Buffer => value !== undefined),
			);
			if (!outcome.ok) return this.unverified(request, outcome.reason);
			return workOk(outcome.value);
		} finally {
			this.release();
		}
	}

	/** 读取冻结基稿里真实存在的标题（供"只改第二节"落到真实章节）。 */
	async listHeadings(absolutePath: string): Promise<string[]> {
		const bytes = this.ports.read(absolutePath, DOCUMENT_WORK_BUDGETS.artifactBytes);
		if (!bytes) return [];
		await this.acquire();
		try {
			const outcome = await this.runJob({ kind: "headings", relativePath: absolutePath, bytes }, [bytes]);
			if (!outcome.ok) return [];
			const value = outcome.value as unknown as { headings?: unknown };
			return Array.isArray(value.headings) ? value.headings.filter((item): item is string => typeof item === "string") : [];
		} finally {
			this.release();
		}
	}

	/** 兼容旧调用点：不可读时返回结构化错误而不是空结论。 */
	async inspectOrFail(request: InspectionRequest): Promise<WorkResult<DocumentInspection>> {
		const result = await this.inspect(request);
		if ("error" in result) return workFail("IO_ERROR", true, { detail: result.error.detail });
		return result;
	}
}
