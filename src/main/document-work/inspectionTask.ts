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

/** workerData 跨线程边界：逐字段证明形状后用类型守卫收窄，不做整体断言。 */
export function decodeInspectionTaskInput(value: unknown): InspectionTaskInput | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const read = (key: string): unknown => Reflect.get(value, key);
	const task = read("task");
	if (task !== "inspect" && task !== "analyze") return undefined;
	const filePath = read("filePath");
	const versionId = read("versionId");
	if (typeof filePath !== "string" || typeof versionId !== "string") return undefined;
	const budgets: number[] = [];
	for (const key of ["artifactByteBudget", "unpackByteBudget", "memberByteBudget", "timeoutMs"]) {
		const field = read(key);
		if (typeof field !== "number" || !Number.isFinite(field)) return undefined;
		budgets.push(field);
	}
	const [artifactByteBudget, unpackByteBudget, memberByteBudget, timeoutMs] = budgets;
	return { task, filePath, versionId, artifactByteBudget, unpackByteBudget, memberByteBudget, timeoutMs };
}

/** 输出同样跨线程边界：证明形状后再交给聚合层。 */
export function decodeInspectionTaskOutput(value: unknown): InspectionTaskOutput | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	if (Reflect.get(value, "ok") !== true) {
		const reason = Reflect.get(value, "reason");
		return reason === "unknown_format" || reason === "inspector_failed" ? { ok: false, reason } : undefined;
	}
	if (Reflect.get(value, "kind") === "analyze") {
		const analysis = Reflect.get(value, "analysis");
		if (typeof analysis !== "object" || analysis === null) return undefined;
		const headings = Reflect.get(analysis, "headings");
		const sections = Reflect.get(analysis, "sections");
		if (!Array.isArray(headings) || !Array.isArray(sections)) return undefined;
		const boundedHeadings = headings.filter((heading): heading is string => typeof heading === "string");
		if (boundedHeadings.length !== headings.length) return undefined;
		return { ok: true, kind: "analyze", analysis: { headings: boundedHeadings, sections } };
	}
	if (Reflect.get(value, "kind") !== "inspect") return undefined;
	const output = Reflect.get(value, "output");
	const inspectorId = Reflect.get(value, "inspectorId");
	const inspectorVersion = Reflect.get(value, "inspectorVersion");
	if (typeof inspectorId !== "string" || typeof inspectorVersion !== "string") return undefined;
	if (typeof output !== "object" || output === null || !Array.isArray(Reflect.get(output, "items"))) return undefined;
	return { ok: true, kind: "inspect", inspectorId, inspectorVersion, output };
}

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
