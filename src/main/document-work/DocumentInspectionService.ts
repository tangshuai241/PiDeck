/**
 * 检查服务：可终止 worker + 两级字节预算 + 2 秒时限 + 状态聚合。
 *
 * 为什么用 worker（方案第 7 节 + 评审）：XML/ZIP 解析是同步 CPU 工作，`Promise.race`
 * 拦不住已经进入同步计算的调用。这里把整份计算放进 worker，超时直接 `terminate()`，
 * 并限制并发 2；worker 起不来或崩溃一律记 unverified + 保留草稿，**不做同步重试**，
 * 因为「退回主线程解析不可信文稿」正是要避免的事。
 *
 * 聚合规则：预算超限、超时、未知格式、未解析结构与读取失败一律 unverified；
 * 只要有一项 unverified 整体就不是 passed；failed / unverified 不自动成为下一轮基稿。
 */
import { randomUUID } from "node:crypto";
import { clearTimeout as clearDelay, setTimeout as delay } from "node:timers";
import type { Worker, WorkerOptions } from "node:worker_threads";
import { deriveInspectionStatus } from "../../shared/documentWork";
import type { DocumentInspection, DocumentInspectionItem, InspectionStatus } from "../../shared/types/documentWork";
import type { InspectorSection } from "./documentInspectors";
import { fingerprintFile } from "./documentWorkPaths";
import { decodeInspectionTaskOutput, type InspectionTaskInput, type InspectionTaskOutput } from "./inspectionTask";

/** 成果文件本体预算（方案首版设计值）。 */
export const INSPECTION_ARTIFACT_BYTE_BUDGET = 32 * 1024 * 1024;
/** OOXML 解压总量预算。 */
export const INSPECTION_UNPACK_BYTE_BUDGET = 64 * 1024 * 1024;
/** 单个 XML 部件预算。 */
export const INSPECTION_MEMBER_BYTE_BUDGET = 8 * 1024 * 1024;
/** 结构检查时限：到点 terminate worker。 */
export const INSPECTION_TIMEOUT_MS = 2_000;
/** 后台检查并发上限。 */
export const INSPECTION_MAX_CONCURRENCY = 2;

export type InspectionWorkerFactory = (options: WorkerOptions) => Worker;

let defaultWorkerFactory: InspectionWorkerFactory | undefined;

/** 生产装配（main/index.ts）在启动时安装；测试用注入的工厂替代。 */
export function setInspectionWorkerFactory(factory: InspectionWorkerFactory | undefined): void {
	defaultWorkerFactory = factory;
}

export type InspectionRequest = {
	versionId: string;
	filePath: string;
	/** 对比基稿：正文指纹 + 块大纲，用于逐块校验保留内容。 */
	comparedTo?: { versionId: string; textDigest?: string; sections?: readonly InspectorSection[] };
	/** 本轮声明必须保留的块标题（准备记录的 scope.preserve）。 */
	preserve?: readonly string[];
	/** 本轮显式允许改动的块标题（准备记录的 scope.allow / sections）。 */
	allow?: readonly string[];
};

export type InspectionBudgetOptions = {
	workerFactory?: InspectionWorkerFactory;
	artifactByteBudget?: number;
	unpackByteBudget?: number;
	memberByteBudget?: number;
	timeoutMs?: number;
	maxConcurrency?: number;
};

type WorkerOutcome = { kind: "result"; output: InspectionTaskOutput } | { kind: "timeout" } | { kind: "unavailable" } | { kind: "crashed" };

export class DocumentInspectionService {
	private readonly workerFactory: InspectionWorkerFactory | undefined;
	private readonly artifactByteBudget: number;
	private readonly unpackByteBudget: number;
	private readonly memberByteBudget: number;
	private readonly timeoutMs: number;
	private readonly maxConcurrency: number;
	private running = 0;
	private readonly queue: Array<() => void> = [];

	constructor(options: InspectionBudgetOptions = {}) {
		this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
		this.artifactByteBudget = options.artifactByteBudget ?? INSPECTION_ARTIFACT_BYTE_BUDGET;
		this.unpackByteBudget = options.unpackByteBudget ?? INSPECTION_UNPACK_BYTE_BUDGET;
		this.memberByteBudget = options.memberByteBudget ?? INSPECTION_MEMBER_BYTE_BUDGET;
		this.timeoutMs = options.timeoutMs ?? INSPECTION_TIMEOUT_MS;
		this.maxConcurrency = options.maxConcurrency ?? INSPECTION_MAX_CONCURRENCY;
	}

	/** 块大纲：准备阶段用它做范围冲突与保留块校验。 */
	async analyze(filePath: string): Promise<{ headings: string[]; sections: InspectorSection[] } | undefined> {
		const input: InspectionTaskInput = {
			task: "analyze",
			filePath,
			versionId: "analyze",
			artifactByteBudget: this.artifactByteBudget,
			unpackByteBudget: this.unpackByteBudget,
			memberByteBudget: this.memberByteBudget,
			timeoutMs: this.timeoutMs,
		};
		const outcome = await this.runTask(input);
		if (outcome.kind !== "result" || !outcome.output.ok || outcome.output.kind !== "analyze") return undefined;
		return outcome.output.analysis;
	}

	async inspect(request: InspectionRequest): Promise<DocumentInspection> {
		const started = Date.now();
		const fingerprint = await fingerprintFile(request.filePath, this.artifactByteBudget);
		const base = this.emptyInspection(request.versionId, fingerprint?.bytes ?? 0);
		if (!fingerprint) {
			// 超预算与读取失败同一条路径：两者都不可信，都不许记 passed。
			return { ...base, status: "unverified", items: [{ id: "file_within_budget", status: "unverified", detail: "read_failed_or_over_budget" }], reason: "read_failed_or_over_budget", durationMs: Date.now() - started, coverage: { ...base.coverage, bytesRead: 0, bytesTotal: 0, truncated: true } };
		}
		const outcome = await this.runTask({
			task: "inspect",
			filePath: request.filePath,
			versionId: request.versionId,
			artifactByteBudget: this.artifactByteBudget,
			unpackByteBudget: this.unpackByteBudget,
			memberByteBudget: this.memberByteBudget,
			timeoutMs: this.timeoutMs,
			...(request.comparedTo ? { comparedTo: request.comparedTo } : {}),
			...(request.preserve ? { preserve: request.preserve } : {}),
			...(request.allow ? { allow: request.allow } : {}),
		});
		if (outcome.kind === "timeout") return this.failureInspection(base, request.versionId, "timeout", "within_time_budget", fingerprint.bytes, started);
		if (outcome.kind === "unavailable") return this.failureInspection(base, request.versionId, "worker_unavailable", "worker_available", fingerprint.bytes, started);
		if (outcome.kind === "crashed") return this.failureInspection(base, request.versionId, "worker_crashed", "worker_available", fingerprint.bytes, started);
		if (outcome.output.ok && outcome.output.kind !== "inspect") return this.failureInspection(base, request.versionId, "inspector_failed", "inspector_completed", fingerprint.bytes, started);
		if (!outcome.output.ok) {
			const unknown = outcome.output.reason === "unknown_format";
			return {
				...base,
				status: "unverified",
				items: [{ id: unknown ? "format_supported" : "inspector_completed", status: "unverified", detail: outcome.output.reason }],
				reason: outcome.output.reason,
				durationMs: Date.now() - started,
				coverage: { ...base.coverage, bytesTotal: fingerprint.bytes },
			};
		}
		return this.finalize({ request, output: outcome.output, fingerprintBytes: fingerprint.bytes, started });
	}

	/** worker 起不来就是 unverified：不退回主线程解析不可信文稿，也不做同步重试。 */
	private failureInspection(base: DocumentInspection, versionId: string, reason: string, itemId: string, bytesTotal: number, started: number): DocumentInspection {
		return {
			...base,
			versionId,
			status: "unverified",
			items: [{ id: itemId, status: "unverified", detail: reason }],
			reason,
			durationMs: Date.now() - started,
			coverage: { ...base.coverage, bytesTotal, truncated: reason === "timeout" },
		};
	}

	private emptyInspection(versionId: string, bytesTotal: number): DocumentInspection {
		return {
			schemaVersion: 1,
			inspectionId: `ins_${randomUUID()}`,
			versionId,
			status: "unverified",
			items: [],
			coverage: { format: "unknown", bytesRead: 0, bytesTotal, truncated: false },
			byteBudget: this.artifactByteBudget,
			durationMs: 0,
			inspectorVersion: "worker-1",
			createdAt: Date.now(),
		};
	}

	/** 并发闸门 + 超时 terminate：worker 是唯一执行位置，没有进程内回退。 */
	private async runTask(input: InspectionTaskInput): Promise<WorkerOutcome> {
		if (!this.workerFactory) return { kind: "unavailable" };
		await this.acquire();
		try {
			return await this.runTaskOnce(input);
		} finally {
			this.release();
		}
	}

	private runTaskOnce(input: InspectionTaskInput): Promise<WorkerOutcome> {
		return new Promise<WorkerOutcome>((resolve) => {
			let worker: Worker;
			try {
				worker = this.workerFactory!({ workerData: input });
			} catch {
				resolve({ kind: "unavailable" });
				return;
			}
			let settled = false;
			const finish = (outcome: WorkerOutcome) => {
				if (settled) return;
				settled = true;
				clearDelay(timer);
				// 结束即终止：结果已拿到时不再让 worker 占着 CPU 或内存。
				void worker.terminate().catch(() => undefined);
				resolve(outcome);
			};
			const timer = delay(() => finish({ kind: "timeout" }), this.timeoutMs);
			worker.once("message", (message: unknown) => {
				const decoded = decodeInspectionTaskOutput(message);
				finish(decoded ? { kind: "result", output: decoded } : { kind: "crashed" });
			});
			worker.once("error", () => finish({ kind: "crashed" }));
			worker.once("exit", (code) => {
				if (code !== 0) finish({ kind: "crashed" });
			});
		});
	}

	private acquire(): Promise<void> {
		if (this.running < this.maxConcurrency) {
			this.running += 1;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.queue.push(() => {
				this.running += 1;
				resolve();
			});
		});
	}

	private release(): void {
		this.running -= 1;
		const next = this.queue.shift();
		if (next) next();
	}

	/** 未声明的检查项（例如基稿没有块大纲无法逐块比较）会让结果记 unverified，不假装通过。 */
	private finalize(input: { request: InspectionRequest; output: Extract<InspectionTaskOutput, { ok: true; kind: "inspect" }>; fingerprintBytes: number; started: number }): DocumentInspection {
		const { request, output } = input;
		const items: DocumentInspectionItem[] = [...output.output.items];
		const status: InspectionStatus = deriveInspectionStatus(items);
		return {
			schemaVersion: 1,
			inspectionId: `ins_${randomUUID()}`,
			versionId: request.versionId,
			status,
			items,
			coverage: {
				...output.output.coverage,
				bytesTotal: input.fingerprintBytes,
				...(request.comparedTo ? { comparedToVersionId: request.comparedTo.versionId } : {}),
			},
			byteBudget: this.artifactByteBudget,
			durationMs: Date.now() - input.started,
			...(status === "unverified" ? { reason: items.find((item) => item.status === "unverified")?.detail ?? "unverified" } : {}),
			inspectorVersion: output.inspectorVersion,
			createdAt: Date.now(),
		};
	}
}
