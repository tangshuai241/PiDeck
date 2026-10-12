/**
 * TPA 独立文稿：Pi 侧工作绑定与成果候选汇报。
 *
 * 职责边界（与方案 §5 一致）：
 * - 主进程经既有发送接口调用注册命令 `/tpa-work bind <base64url>`，命令**只绑定上下文**，
 *   不触发模型回合；
 * - 扩展确认绑定后发布隐藏 `custom_message`（`customType: tpa-document-work-state`），
 *   主进程收到匹配确认后才认为本轮准备生效；
 * - 模型用 `tpa_artifact_report` 汇报**候选**：扩展只做身份核对、路径边界和落分支，
 *   汇报不创建操作、不批准执行、不判定检查通过；
 * - 汇报在 `agent_end` 时打上 `reported`；`agent_end` 不是归档完成，归档由主进程等
 *   `agent_settled` 后独立完成。
 *
 * 与对齐模块共享一个明确的绑定入口（`pi-deck-document-work-binding.ts`）：绑定生效期间，
 * 对齐批准必须指向绑定的同一份确认单，否则拒绝——不靠两条相邻消息的顺序猜。
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOCUMENT_WORK_PROTOCOL, canonicalJson, isBoundedId, isInsideStaging, isRecord, parseArtifactReport, parseBindingPayload, type DocumentArtifactCandidateReport, type DocumentWorkBindingPayload, type DocumentWorkBindingState } from "./pi-deck-document-work-protocol";
import { setDocumentWorkApprovalGate } from "./pi-deck-document-work-binding";
import { registerMaterialTool } from "./pi-deck-document-materials";

const STATE_TYPE = DOCUMENT_WORK_PROTOCOL.stateType;
const SNAPSHOT_TYPE = DOCUMENT_WORK_PROTOCOL.snapshotType;
const CONTEXT_TYPE = "tpa-document-work-context";
const STAGING_INTERNAL_DIR = "_tpa";

type Snapshot = { schemaVersion: number; sessionId: string; binding: DocumentWorkBindingPayload; phase: DocumentWorkBindingState["phase"]; reportId?: string };

export default function piDeckDocumentWorkExtension(pi: ExtensionAPI): void {
	let binding: DocumentWorkBindingPayload | undefined;
	let phase: DocumentWorkBindingState["phase"] = "bound";
	let lastReport: DocumentArtifactCandidateReport | undefined;
	let sessionId: string | undefined;
	let invalidBindWarning: string | undefined;

	function state(): DocumentWorkBindingState | undefined {
		if (!binding) return undefined;
		return {
			schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion,
			sessionId: binding.sessionId,
			workId: binding.workId,
			attemptId: binding.attemptId,
			preparationId: binding.preparationId,
			digest: binding.digest,
			phase,
			...(lastReport ? { reportId: lastReport.reportId } : {}),
			kind: binding.kind,
			stagingRelativeDir: binding.stagingRelativeDir,
			updatedAt: Date.now(),
		};
	}

	/** 隐藏状态：同步权威（私有快照）+ 公开消息（主进程订阅）。 */
	function publish(): void {
		const current = state();
		if (!current || !binding) return;
		const schemaVersion = DOCUMENT_WORK_PROTOCOL.schemaVersion;
		const snapshot: Snapshot = { schemaVersion, sessionId: binding.sessionId, binding, phase, ...(lastReport ? { reportId: lastReport.reportId } : {}) };
		pi.appendEntry(SNAPSHOT_TYPE, snapshot);
		pi.sendMessage({ customType: STATE_TYPE, content: "", display: false, details: { documentWork: current, ...(lastReport ? { report: lastReport } : {}) } }, { triggerTurn: false });
	}

	/** 分支恢复：只看本会话自己的快照；汇报记录可以补登记，但执行授权不恢复。 */
	function restoreSession(ctx: ExtensionContext): void {
		binding = undefined;
		lastReport = undefined;
		phase = "bound";
		invalidBindWarning = undefined;
		sessionId = ctx.sessionManager.getSessionId();
		let lastSnapshot: Snapshot | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE || !isRecord(entry.data)) continue;
			if (entry.data.sessionId !== sessionId) continue;
			const parsed = parseBindingPayload(entry.data.binding);
			if (!parsed) continue;
			lastSnapshot = { schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion, sessionId, binding: parsed, phase: typeof entry.data.phase === "string" ? (entry.data.phase as DocumentWorkBindingState["phase"]) : "bound", ...(isBoundedId(entry.data.reportId) ? { reportId: entry.data.reportId } : {}) };
		}
		if (!lastSnapshot) return;
		binding = lastSnapshot.binding;
		phase = lastSnapshot.phase === "reported" ? "reported" : "bound";
	}

	/** 对齐批准闸：绑定生效期间批准必须指向同一份确认单。 */
	setDocumentWorkApprovalGate({
		refuse: (briefId: string, revision: number) => {
			if (!binding) {
				// 绑定载荷损坏过：在拿到有效绑定前不允许任何对齐批准触发制作。
				return invalidBindWarning;
			}
			const bound = binding.briefId;
			if (bound && bound !== briefId) return `Document work ${binding.workId} is bound to another confirmation sheet; approve that one or cancel this round.`;
			if (bound && binding.briefRevision !== undefined && binding.briefRevision !== revision) return `Document work ${binding.workId} is bound to confirmation ${bound} revision ${binding.briefRevision}; approve that exact revision or cancel this round.`;
			return undefined;
		},
	});

	registerMaterialTool(pi, { getBinding: () => binding });

	/** 汇报路径校验：必须落在本轮 staging 内，且真实路径仍在输出根内。 */
	function stagingPathOf(relativePath: string): string | undefined {
		if (!binding) return undefined;
		if (!isInsideStaging(binding.stagingRelativeDir, relativePath)) return undefined;
		const absolute = join(binding.outputRootPath, ...relativePath.split("/"));
		if (!existsSync(absolute)) return undefined;
		try {
			const rootReal = realpathSync(binding.outputRootPath);
			const targetReal = realpathSync(absolute);
			const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
			const root = normalize(rootReal);
			const target = normalize(targetReal);
			if (target !== root && !target.startsWith(root.endsWith("\\") || root.endsWith("/") ? root : `${root}${process.platform === "win32" ? "\\" : "/"}`)) return undefined;
		} catch {
			return undefined;
		}
		return absolute;
	}

	pi.registerCommand(DOCUMENT_WORK_PROTOCOL.command, {
		description: "TPA document work: bind <payload> | status | clear",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/);
			if (action === "status") {
				const current = state();
				ctx.ui.notify(current ? `Document work ${current.workId} attempt ${current.attemptId}: ${current.phase}` : "No document work is bound to this session.", "info");
				return;
			}
			if (action === "clear") {
				binding = undefined;
				lastReport = undefined;
				phase = "bound";
				invalidBindWarning = undefined;
				ctx.ui.notify("Document work binding cleared.", "info");
				return;
			}
			if (action !== "bind") {
				ctx.ui.notify("Usage: /tpa-work bind <payload> | status | clear", "warning");
				return;
			}
			const encoded = rest[0];
			const decoded = encoded ? decodeAndVerify(encoded) : undefined;
			if (!decoded || decoded.sessionId !== ctx.sessionManager.getSessionId()) {
				binding = undefined;
				lastReport = undefined;
				phase = "bound";
				invalidBindWarning = "A document work round tried to bind with an invalid payload; ask the desktop app to start the round again before approving.";
				ctx.ui.notify(invalidBindWarning, "warning");
				return;
			}
			binding = decoded;
			lastReport = undefined;
			phase = "bound";
			invalidBindWarning = undefined;
			publish();
		},
	});

	pi.registerTool({
		name: DOCUMENT_WORK_PROTOCOL.reportTool,
		label: "Report this round's document artifacts",
		description: "Report the files this round produced, as relative paths inside the round's staging directory. This only files a candidate: it does not approve, archive or verify anything. Report honestly and list any part you could not finish.",
		parameters: Type.Object(
			{
				workId: Type.Optional(Type.String({ maxLength: 80 })),
				attemptId: Type.Optional(Type.String({ maxLength: 80 })),
				preparationId: Type.Optional(Type.String({ maxLength: 80 })),
				digest: Type.Optional(Type.String({ maxLength: 200 })),
				artifacts: Type.Array(Type.String({ maxLength: 1024 }), { minItems: 1, maxItems: DOCUMENT_WORK_PROTOCOL.budgets.reportFiles }),
				editableSources: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: DOCUMENT_WORK_PROTOCOL.budgets.reportFiles })),
				summary: Type.String({ maxLength: 4000 }),
				risks: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: Record<string, unknown>) {
			if (!binding) return { content: [{ type: "text", text: "No document work round is bound; there is nothing to report." }], isError: true };
			for (const key of ["workId", "attemptId", "preparationId", "digest"] as const) {
				const supplied = params[key];
				if (typeof supplied === "string" && supplied !== binding[key]) return { content: [{ type: "text", text: `Report rejected: ${key} does not match the bound round.` }], isError: true };
			}
			const artifacts = Array.isArray(params.artifacts) ? (params.artifacts as string[]) : [];
			const editableSources = Array.isArray(params.editableSources) ? (params.editableSources as string[]) : [];
			const risks = Array.isArray(params.risks) ? (params.risks as string[]) : [];
			const invalid = [...artifacts, ...editableSources].find((candidate) => stagingPathOf(candidate) === undefined);
			if (invalid !== undefined) return { content: [{ type: "text", text: `Report rejected: ${invalid} is not a file inside this round's staging directory.` }], isError: true };
			const candidate: DocumentArtifactCandidateReport = {
				schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion,
				workId: binding.workId,
				attemptId: binding.attemptId,
				preparationId: binding.preparationId,
				digest: binding.digest,
				reportId: randomUUID().slice(0, 32),
				artifacts: [...artifacts],
				editableSources: [...editableSources],
				summary: typeof params.summary === "string" ? params.summary : "",
				risks: [...risks],
			};
			const parsed = parseArtifactReport(candidate);
			if (!parsed) return { content: [{ type: "text", text: "Report rejected: the payload is malformed or over the byte budget." }], isError: true };
			lastReport = parsed;
			phase = "reported";
			publish();
			return { content: [{ type: "text", text: `Candidate recorded (reportId=${parsed.reportId}). The desktop app archives and inspects it independently; this report is not an approval.` }], details: { reportId: parsed.reportId } };
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!binding) return;
		if (binding.sessionId !== ctx.sessionManager.getSessionId()) return;
		return { message: { customType: CONTEXT_TYPE, display: false, content: buildWorkContext(binding) } };
	});

	pi.on("context", async (event) => {
		// 隐藏状态与控制消息不进模型上下文；只保留最新的工作上下文。
		let latestContext = -1;
		for (let index = 0; index < event.messages.length; index++) {
			const message: unknown = event.messages[index];
			if (isRecord(message) && message.customType === CONTEXT_TYPE) latestContext = index;
		}
		const filtered = event.messages.filter((message: unknown, index: number) => {
			if (!isRecord(message)) return true;
			if (message.customType === STATE_TYPE || message.customType === SNAPSHOT_TYPE) return false;
			if (message.customType === CONTEXT_TYPE) return Boolean(binding) && index === latestContext;
			return true;
		});
		return { messages: filtered };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!binding || binding.sessionId !== ctx.sessionManager.getSessionId()) return;
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (last && (last.stopReason === "aborted" || last.stopReason === "error")) {
			// 中断/出错的一轮不算产出：主进程据此记 interrupted，不归档半成品。
			phase = "failed";
			publish();
			return;
		}
		// agent_end 只说明底层 run 结束；没汇报就保持 bound，等主进程按 settled 判据处理。
		if (lastReport) {
			phase = "reported";
			publish();
		}
	});

	pi.on("session_start", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_shutdown", async () => {
		binding = undefined;
		lastReport = undefined;
		phase = "bound";
		invalidBindWarning = undefined;
		sessionId = undefined;
	});
}

/** 载荷自校验：解码 + 规范形态（拒绝重复键/非规范 JSON）。 */
function decodeAndVerify(encoded: string): DocumentWorkBindingPayload | undefined {
	if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
	let json: string;
	try {
		json = Buffer.from(encoded, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
	if (Buffer.byteLength(json, "utf8") > DOCUMENT_WORK_PROTOCOL.budgets.bindPayloadBytes) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	// 与主进程 decodeWorkBinding 同一判据：重新规范化的结果必须与输入完全一致。
	if (canonicalJson(value) !== json) return undefined;
	return parseBindingPayload(value);
}

/** 注入的工作上下文：只描述本轮边界，不授予额外权限。 */
function buildWorkContext(binding: DocumentWorkBindingPayload): string {
	const frozenBase = binding.base ? `${binding.stagingRelativeDir}/${STAGING_INTERNAL_DIR}/base/${basename(binding.base.relativePath)}` : undefined;
	const scope = binding.scope.wholeDocument ? "the whole deliverable may change" : `only these locations may change: ${binding.scope.allow.join("; ") || "(none declared)"}`;
	const preserve = binding.scope.preserve.length > 0 ? `Preserve verbatim: ${binding.scope.preserve.join("; ")}` : "Preserve everything the user did not ask to change.";
	const materials = binding.materials.length > 0 ? binding.materials.map((material) => `${material.materialId} (${material.relativePath})`).join(", ") : "none";
	const lines = [
		`TPA document work ${binding.workId}, attempt ${binding.attemptId}, preparation ${binding.preparationId}.`,
		`Output root: ${binding.outputRootPath}. Work only inside this round's staging directory: ${binding.stagingRelativeDir}/. Do not write outside it and do not touch archived versions.`,
		binding.kind === "create_document" ? "This round creates a new document." : "This round revises an existing document.",
		...(frozenBase ? [`The frozen base copy of this round is ${frozenBase}. Revise that copy in place and keep the same file format; do not rebuild an existing Word file from Markdown notes, and do not overwrite the user's original file.`] : []),
		`Authorized change scope: ${scope}. ${preserve}`,
		`Registered materials (read them with ${DOCUMENT_WORK_PROTOCOL.materialTool} by id; do not read them by guessing paths): ${materials}.`,
		`Materials that need conversion are converted by that tool; never claim a material was read or converted unless the tool returned its text. If it fails, say so.`,
		`Supported deliverable formats this round: .docx and .md. Per-file byte budget: ${binding.budgetBytes} bytes; larger files are recorded as existence evidence and cannot pass inspection.`,
		`When finished, report the produced files with ${DOCUMENT_WORK_PROTOCOL.reportTool} using paths relative to the output root. The report only files a candidate; the desktop app archives and inspects it independently, and the user has not accepted anything yet.`,
	];
	return lines.join("\n");
}
