/**
 * 检查服务：注册表 + 字节预算 + 超时 + 状态聚合。
 *
 * 硬性规则（方案第 9 节）：预算超限、超时、未知格式、未解析结构和读取失败一律记
 * unverified；只要有一项 unverified 整体就不是 passed。failed / unverified 的版本
 * 保留但不能自动成为下一轮基稿。
 */
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { clearTimeout as clearDelay, setTimeout as delay } from "node:timers";
import { deriveInspectionStatus } from "../../shared/documentWork";
import type { DocumentInspection, DocumentInspectionItem, InspectionStatus } from "../../shared/types/documentWork";
import { defaultInspectors, type FormatInspector, type InspectorOutput } from "./documentInspectors";
import { fingerprintFile } from "./documentWorkPaths";

export const INSPECTION_DEFAULT_BYTE_BUDGET = 64 * 1024 * 1024;
export const INSPECTION_DEFAULT_TIMEOUT_MS = 15_000;

export type InspectionRequest = {
	versionId: string;
	filePath: string;
	/** 对比基稿：用于判定「本轮正文是否真的变化」。 */
	comparedTo?: { versionId: string; textDigest?: string };
};

export class DocumentInspectionService {
	private readonly inspectors: readonly FormatInspector[];
	private readonly byteBudget: number;
	private readonly timeoutMs: number;

	constructor(options: { inspectors?: readonly FormatInspector[]; byteBudget?: number; timeoutMs?: number } = {}) {
		this.inspectors = options.inspectors ?? defaultInspectors;
		this.byteBudget = options.byteBudget ?? INSPECTION_DEFAULT_BYTE_BUDGET;
		this.timeoutMs = options.timeoutMs ?? INSPECTION_DEFAULT_TIMEOUT_MS;
	}

	/** 扩展名 → 检查器；未知格式由 inspect 记 unverified，而不是抛错。 */
	resolve(filePath: string): FormatInspector | undefined {
		const extension = extname(filePath).toLowerCase();
		return this.inspectors.find((inspector) => inspector.extensions.includes(extension));
	}

	async outline(filePath: string): Promise<string[] | undefined> {
		const inspector = this.resolve(filePath);
		if (!inspector) return undefined;
		const started = Date.now();
		return this.withTimeout(inspector.outline({ filePath, byteBudget: this.byteBudget }), this.timeoutMs - (Date.now() - started));
	}

	async inspect(request: InspectionRequest): Promise<DocumentInspection> {
		const started = Date.now();
		const fingerprint = await fingerprintFile(request.filePath, this.byteBudget);
		const base: DocumentInspection = {
			schemaVersion: 1,
			inspectionId: `ins_${randomUUID()}`,
			versionId: request.versionId,
			status: "unverified",
			items: [],
			coverage: { format: "unknown", bytesRead: 0, bytesTotal: fingerprint?.bytes ?? 0, truncated: false },
			byteBudget: this.byteBudget,
			durationMs: 0,
			inspectorVersion: "none-0",
			createdAt: Date.now(),
		};
		if (!fingerprint) {
			// 预算超限与读取失败合并在同一条路径里：两者都不可信，都不许记 passed。
			return { ...base, status: "unverified", items: [{ id: "file_within_budget", status: "unverified", detail: "read_failed_or_over_budget" }], reason: "read_failed_or_over_budget", durationMs: Date.now() - started, coverage: { ...base.coverage, bytesRead: 0, bytesTotal: 0, truncated: true } };
		}
		const inspector = this.resolve(request.filePath);
		if (!inspector) {
			return { ...base, status: "unverified", inspectorVersion: "none-0", items: [{ id: "format_supported", status: "unverified", detail: "unknown_format" }], reason: "unknown_format", durationMs: Date.now() - started, coverage: { ...base.coverage, bytesRead: 0, bytesTotal: fingerprint.bytes } };
		}
		const remaining = this.timeoutMs - (Date.now() - started);
		if (remaining <= 0) {
			return { ...base, status: "unverified", inspectorVersion: inspector.version, items: [{ id: "within_time_budget", status: "unverified", detail: "timeout" }], reason: "timeout", durationMs: Date.now() - started };
		}
		const output = await this.withTimeout(
			inspector.inspect({
				filePath: request.filePath,
				byteBudget: this.byteBudget,
				...(request.comparedTo?.textDigest ? { comparedTextDigest: request.comparedTo.textDigest } : {}),
			}),
			remaining,
		);
		if (!output) {
			return { ...base, status: "unverified", inspectorVersion: inspector.version, items: [{ id: "within_time_budget", status: "unverified", detail: "timeout" }], reason: "timeout", durationMs: Date.now() - started, coverage: { ...base.coverage, format: inspector.id, bytesRead: 0, bytesTotal: fingerprint.bytes } };
		}
		return this.finalize({ request, inspector, output, fingerprintBytes: fingerprint.bytes, started });
	}

	/** 未声明的检查项（例如基稿本身没有正文指纹）会让对比项记 unverified，不假装通过。 */
	private finalize(input: { request: InspectionRequest; inspector: FormatInspector; output: InspectorOutput; fingerprintBytes: number; started: number }): DocumentInspection {
		const { request, inspector, output } = input;
		const items: DocumentInspectionItem[] = [...output.items];
		if (request.comparedTo && !request.comparedTo.textDigest) {
			items.push({ id: "body_content_changed", status: "unverified", detail: "base_text_digest_missing" });
		}
		const status: InspectionStatus = deriveInspectionStatus(items);
		return {
			schemaVersion: 1,
			inspectionId: `ins_${randomUUID()}`,
			versionId: request.versionId,
			status,
			items,
			coverage: {
				...output.coverage,
				bytesTotal: input.fingerprintBytes,
				...(request.comparedTo ? { comparedToVersionId: request.comparedTo.versionId } : {}),
			},
			byteBudget: this.byteBudget,
			durationMs: Date.now() - input.started,
			...(status === "unverified" ? { reason: output.items.find((item) => item.status === "unverified")?.detail ?? "unverified" } : {}),
			inspectorVersion: inspector.version,
			createdAt: Date.now(),
		};
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
		if (timeoutMs <= 0) return undefined;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timer = delay(() => resolve(undefined), timeoutMs);
		});
		try {
			return await Promise.race([promise.catch(() => undefined), timeout]);
		} finally {
			if (timer) clearDelay(timer);
		}
	}
}
