/**
 * 单个检查任务的纯逻辑：worker 入口与业务测试共用同一份实现。
 *
 * 这里只做「取检查器 → 跑一次 → 组装覆盖信息」，不做状态聚合、不写盘、不碰 IPC：
 * 聚合归 `DocumentInspectionService`，进程生命周期归 worker 宿主。
 */
import { extname } from "node:path";
import { defaultInspectors, type FormatInspector, type InspectorOutput, type InspectorSection } from "./documentInspectors";

export type InspectionTaskInput = {
	task: "inspect" | "analyze";
	filePath: string;
	versionId: string;
	artifactByteBudget: number;
	unpackByteBudget: number;
	memberByteBudget: number;
	timeoutMs: number;
	comparedTo?: { versionId: string; textDigest?: string; sections?: readonly InspectorSection[] };
	preserve?: readonly string[];
	allow?: readonly string[];
};

export type InspectionTaskOutput = { ok: true; kind: "inspect"; inspectorId: string; inspectorVersion: string; output: InspectorOutput } | { ok: true; kind: "analyze"; analysis: { headings: string[]; sections: InspectorSection[] } } | { ok: false; reason: "unknown_format" | "inspector_failed" };

export function resolveInspector(filePath: string, inspectors: readonly FormatInspector[] = defaultInspectors): FormatInspector | undefined {
	const extension = extname(filePath).toLowerCase();
	return inspectors.find((inspector) => inspector.extensions.includes(extension));
}

export async function runInspectionTask(input: InspectionTaskInput, inspectors: readonly FormatInspector[] = defaultInspectors): Promise<InspectionTaskOutput> {
	const inspector = resolveInspector(input.filePath, inspectors);
	if (!inspector) return { ok: false, reason: "unknown_format" };
	const deadlineAt = Date.now() + input.timeoutMs;
	try {
		if (input.task === "analyze") {
			const analysis = await inspector.analyze({ filePath: input.filePath, artifactByteBudget: input.artifactByteBudget, unpackByteBudget: input.unpackByteBudget, memberByteBudget: input.memberByteBudget, deadlineAt });
			return analysis ? { ok: true, kind: "analyze", analysis } : { ok: false, reason: "inspector_failed" };
		}
		const output = await inspector.inspect({
			filePath: input.filePath,
			artifactByteBudget: input.artifactByteBudget,
			unpackByteBudget: input.unpackByteBudget,
			memberByteBudget: input.memberByteBudget,
			deadlineAt,
			...(input.comparedTo ? { comparedTo: input.comparedTo } : {}),
			...(input.preserve ? { preserve: input.preserve } : {}),
			...(input.allow ? { allow: input.allow } : {}),
		});
		return { ok: true, kind: "inspect", inspectorId: inspector.id, inspectorVersion: inspector.version, output };
	} catch {
		return { ok: false, reason: "inspector_failed" };
	}
}
