/**
 * TPA 独立文稿：Pi 侧工作绑定、成果候选汇报与改稿意向。
 *
 * 职责边界（方案 §5 + 审查修正项 1/3）：
 * - 主进程经既有发送接口调用注册命令 `/tpa-work bind <base64url>`，命令**只绑定上下文**，
 *   不触发模型回合；
 * - **身份**：pi 进程里只能看到原生会话 id（`ctx.sessionManager.getSessionId()`），
 *   绑定载荷里的 `nativeSessionId` 是唯一的身份判据；稳定会话 id 只回显，不参与判断。
 *   这样新草稿"稳定 id ≠ 原生 id"不再导致所有绑定被拒；
 * - 模型用 `tpa_artifact_report` 汇报**候选**：扩展只做身份核对、路径边界和落分支；
 * - 普通聊天里的改稿只报**意向候选**（`tpa-document-work-intent`）：扩展不派发、不授权，
 *   由主进程验证用户轮次、等稳定点后决定；
 * - `/tpa-work revise` 由主进程在准备完成后下发，扩展用**主进程冻结的指令正文**触发回合；
 * - 汇报在 `agent_end` 时打上 `reported`；`agent_end` 不是归档完成，归档由主进程等
 *   `agent_settled` 后独立完成。
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DOCUMENT_WORK_PROTOCOL, canonicalJson, contentDigest, isBoundedId, isInsideStaging, isRecord, looksLikeChangeRequest, parseArtifactReport, parseBindingPayload, type DocumentArtifactCandidateReport, type DocumentWorkBindingPayload, type DocumentWorkBindingState } from "./pi-deck-document-work-protocol";
import { setDocumentWorkApprovalGate } from "./pi-deck-document-work-binding";
import { registerMaterialTool } from "./pi-deck-document-materials";

const STATE_TYPE = DOCUMENT_WORK_PROTOCOL.stateType;
const SNAPSHOT_TYPE = DOCUMENT_WORK_PROTOCOL.snapshotType;
const INTENT_TYPE = DOCUMENT_WORK_PROTOCOL.intentType;
const CONTEXT_TYPE = "tpa-document-work-context";
const EXECUTE_TYPE = "tpa-document-work-execute";
const STAGING_INTERNAL_DIR = "_tpa";

type Snapshot = { schemaVersion: number; nativeSessionId: string; binding: DocumentWorkBindingPayload; phase: DocumentWorkBindingState["phase"]; reportId?: string };

export default function piDeckDocumentWorkExtension(pi: ExtensionAPI): void {
	let binding: DocumentWorkBindingPayload | undefined;
	let phase: DocumentWorkBindingState["phase"] = "bound";
	let lastReport: DocumentArtifactCandidateReport | undefined;
	let invalidBindWarning: string | undefined;
	/** 本轮回合是否已经结束（agent_end）：结束后不再算"进行中"，也就不再约束批准。 */
	let roundFinished = false;
	/** 已经报过意向的用户轮次，避免同一轮重复上报。 */
	const reportedIntents = new Set<string>();

	/**
	 * 一轮正在进行（绑定已确认、回合未结束）；只有这时才注入上下文、才允许汇报、
	 * 才让批准闸约束确认单。回合一旦结束（agent_end，含中断），闸就放开——
	 * 归档由主进程按 settled 判据决定，扩展的"回合结束"不等于归档完成。
	 */
	function roundActive(): boolean {
		return Boolean(binding) && (phase === "bound" || phase === "running") && !roundFinished;
	}

	function activeNativeSession(): string | undefined {
		return binding?.nativeSessionId;
	}

	function state(sessionId: string): DocumentWorkBindingState | undefined {
		if (!binding) return undefined;
		return {
			schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion,
			sessionId: binding.sessionId,
			nativeSessionId: binding.nativeSessionId,
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
	function publish(ctx: ExtensionContext): void {
		if (!binding) return;
		const current = state(ctx.sessionManager.getSessionId());
		if (!current) return;
		const snapshot: Snapshot = { schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion, nativeSessionId: binding.nativeSessionId, binding, phase, ...(lastReport ? { reportId: lastReport.reportId } : {}) };
		pi.appendEntry(SNAPSHOT_TYPE, snapshot);
		pi.sendMessage({ customType: STATE_TYPE, content: "", display: false, details: { documentWork: current, ...(lastReport ? { report: lastReport } : {}) } }, { triggerTurn: false });
	}

	/** 分支恢复：只看本会话自己的快照；汇报可以补登记，但执行授权不恢复。 */
	function restoreSession(ctx: ExtensionContext): void {
		binding = undefined;
		lastReport = undefined;
		phase = "bound";
		roundFinished = true;
		invalidBindWarning = undefined;
		reportedIntents.clear();
		const nativeSessionId = ctx.sessionManager.getSessionId();
		let lastSnapshot: Snapshot | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SNAPSHOT_TYPE || !isRecord(entry.data)) continue;
			// 身份按原生会话 id 比对：换会话文件（fork/导入）不得继承上一轮的绑定。
			if (entry.data.nativeSessionId !== nativeSessionId) continue;
			const parsed = parseBindingPayload(entry.data.binding);
			if (!parsed || parsed.nativeSessionId !== nativeSessionId) continue;
			lastSnapshot = { schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion, nativeSessionId, binding: parsed, phase: typeof entry.data.phase === "string" ? (entry.data.phase as DocumentWorkBindingState["phase"]) : "bound", ...(isBoundedId(entry.data.reportId) ? { reportId: entry.data.reportId } : {}) };
		}
		if (!lastSnapshot) return;
		binding = lastSnapshot.binding;
		// 恢复的只是"最近一件工作"的身份，不是进行中的轮次：标 reported，
		// 这样普通聊天的改稿意向与新的绑定都能正常工作，已结束的轮次也不会被重放。
		phase = "reported";
	}

	/**
	 * 对齐批准闸：**只有进行中的文稿轮次**才约束批准，而且只约束"它自己那一份确认单"。
	 *
	 * 关键边界（审查修正项 1）：归档/取消/失败之后保留文稿关联只用于读与改稿意向，
	 * 绝不注入旧制作指令、也不阻断同一会话里后来的普通 Plan/编码确认。
	 * 绑定载荷损坏过（invalidBindWarning）同样不阻断：那时没有进行中的轮次，
	 * 文稿侧会在分发阶段如实失败，而用户的普通任务必须照常执行。
	 */
	setDocumentWorkApprovalGate({
		refuse: (briefId: string, revision: number) => {
			if (!binding || !roundActive()) return undefined;
			const bound = binding.briefId;
			// 改稿轮的绑定没有 briefId：它不约束任何确认单。
			if (!bound) return undefined;
			if (bound !== briefId) return `Document work ${binding.workId} is bound to another confirmation sheet; approve that one or cancel this round.`;
			if (binding.briefRevision !== undefined && binding.briefRevision !== revision) return `Document work ${binding.workId} is bound to confirmation ${bound} revision ${binding.briefRevision}; approve that exact revision or cancel this round.`;
			return undefined;
		},
	});

	registerMaterialTool(pi, { getBinding: () => binding });

	/** 汇报路径校验：必须落在本轮 staging 内，且真实路径仍在**本轮绑定的材料根**内。 */
	function stagingPathOf(relativePath: string): string | undefined {
		if (!binding) return undefined;
		if (!isInsideStaging(binding.stagingRelativeDir, relativePath)) return undefined;
		const root = binding.materialRoots.find((candidate) => candidate.rootId === binding?.outputRootId);
		if (!root) return undefined;
		const absolute = join(root.path, ...relativePath.split("/"));
		if (!existsSync(absolute)) return undefined;
		try {
			const rootReal = realpathSync(root.path);
			const targetReal = realpathSync(absolute);
			const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
			const base = normalize(rootReal);
			const target = normalize(targetReal);
			const separator = process.platform === "win32" ? "\\" : "/";
			if (target !== base && !target.startsWith(base.endsWith(separator) ? base : `${base}${separator}`)) return undefined;
		} catch {
			return undefined;
		}
		return absolute;
	}

	/** 最近一条用户消息（原生 entry id + 正文）；意向候选只基于它。 */
	function latestUserTurn(ctx: ExtensionContext): { entryId: string; text: string } | undefined {
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index] as { id?: unknown; type?: unknown; message?: unknown };
			if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") continue;
			const content = entry.message.content;
			let text = "";
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) text = content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
			if (typeof entry.id !== "string" || !text.trim()) return undefined;
			return { entryId: entry.id, text };
		}
		return undefined;
	}

	pi.registerCommand(DOCUMENT_WORK_PROTOCOL.command, {
		description: "TPA document work: bind <payload> | revise | status | clear",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/);
			if (action === "status") {
				const current = state(ctx.sessionManager.getSessionId());
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
			if (action === "revise") {
				// 主进程完成准备并绑定之后才下发这条命令：这里只负责用**冻结的指令正文**触发回合。
				const current = binding;
				if (!current || current.kind !== "revise_document" || !current.instruction || current.nativeSessionId !== ctx.sessionManager.getSessionId()) {
					ctx.ui.notify("No prepared revision round is bound to this session.", "warning");
					return;
				}
				phase = "running";
				roundFinished = false;
				publish(ctx);
				pi.sendMessage({ customType: EXECUTE_TYPE, content: `${buildWorkContext(current)}\n\nThe user asked for this change in an earlier message (frozen by the desktop app):\n${current.instruction.text}`, display: false, details: { workId: current.workId, attemptId: current.attemptId, sourceTurnId: current.instruction.sourceTurnId } }, { triggerTurn: true });
				return;
			}
			if (action !== "bind") {
				ctx.ui.notify("Usage: /tpa-work bind <payload> | revise | status | clear", "warning");
				return;
			}
			const encoded = rest[0];
			const decoded = encoded ? decodeAndVerify(encoded) : undefined;
			const nativeSessionId = ctx.sessionManager.getSessionId();
			// 身份判据只有原生会话 id：稳定 id 不同是常态，不参与判断。
			if (!decoded || decoded.nativeSessionId !== nativeSessionId) {
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
			roundFinished = false;
			invalidBindWarning = undefined;
			publish(ctx);
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
		async execute(_id, params: Record<string, unknown>, _signal, _onUpdate, ctx) {
			if (!binding || !roundActive()) return { content: [{ type: "text", text: "No document work round is bound; there is nothing to report." }], isError: true };
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
			publish(ctx);
			return { content: [{ type: "text", text: `Candidate recorded (reportId=${parsed.reportId}). The desktop app archives and inspects it independently; this report is not an approval.` }], details: { reportId: parsed.reportId } };
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const nativeSessionId = ctx.sessionManager.getSessionId();
		// 1) 正在进行的文稿轮次：注入本轮边界（staging、基稿、范围、材料）。
		if (binding && binding.nativeSessionId === nativeSessionId && roundActive()) return { message: { customType: CONTEXT_TYPE, display: false, content: buildWorkContext(binding) } };
		// 2) 普通聊天：只报"这一轮像是要求改稿"的候选，不派发、不授权。
		const lastWork = binding && binding.nativeSessionId === nativeSessionId ? binding : undefined;
		if (!lastWork || !binding) return;
		const turn = latestUserTurn(ctx);
		if (!turn || reportedIntents.has(turn.entryId)) return;
		if (!looksLikeChangeRequest(turn.text)) return;
		reportedIntents.add(turn.entryId);
		const digest = contentDigest(turn.text.trim());
		pi.sendMessage(
			{
				customType: INTENT_TYPE,
				content: "",
				display: false,
				details: {
					intent: {
						schemaVersion: DOCUMENT_WORK_PROTOCOL.schemaVersion,
						sessionId: binding.sessionId,
						nativeSessionId: binding.nativeSessionId,
						workId: binding.workId,
						sourceTurnId: turn.entryId,
						instructionDigest: digest,
						summary: turn.text.replace(/\s+/g, " ").trim().slice(0, 200),
					},
				},
			},
			{ triggerTurn: false },
		);
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
			if (message.customType === STATE_TYPE || message.customType === SNAPSHOT_TYPE || message.customType === INTENT_TYPE) return false;
			if (message.customType === CONTEXT_TYPE) return roundActive() && index === latestContext;
			if (message.customType === EXECUTE_TYPE) return Boolean(binding) && isRecord(message.details) && message.details.attemptId === binding?.attemptId;
			return true;
		});
		return { messages: filtered };
	});

	pi.on("agent_end", async (event, ctx) => {
		// 回合结束：此后不再算"进行中"（不注入旧制作指令、不阻断其他确认单）。
		roundFinished = true;
		if (!binding || binding.nativeSessionId !== ctx.sessionManager.getSessionId()) return;
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (last && (last.stopReason === "aborted" || last.stopReason === "error")) {
			// 中断/出错的一轮不算产出：主进程据此记 interrupted，不归档半成品。
			phase = "failed";
			publish(ctx);
			return;
		}
		// agent_end 只说明底层 run 结束；没汇报就保持 bound，等主进程按 settled 判据处理。
		if (lastReport) {
			phase = "reported";
			publish(ctx);
		}
	});

	pi.on("session_start", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_shutdown", async () => {
		binding = undefined;
		lastReport = undefined;
		phase = "bound";
		roundFinished = true;
		invalidBindWarning = undefined;
		reportedIntents.clear();
	});
	void activeNativeSession;
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
		`Output root: ${binding.outputRootId}. Work only inside this round's staging directory: ${binding.stagingRelativeDir}/. Do not write outside it and do not touch archived versions.`,
		binding.kind === "create_document" ? "This round creates a new document." : "This round revises an existing document.",
		...(frozenBase ? [`The frozen base copy of this round is ${frozenBase}. Revise that copy in place and keep the same file format; do not rebuild an existing Word file from Markdown notes, and do not overwrite the user's original file.`] : []),
		`Authorized change scope: ${scope}. ${preserve}`,
		`Registered materials (read them with ${DOCUMENT_WORK_PROTOCOL.materialTool} by id; do not read them by guessing paths): ${materials}.`,
		"Materials that need conversion are converted by that tool; never claim a material was read or converted unless the tool returned its text. If it fails, say so.",
		`Deliverable formats this round: .docx and .md. Per-file byte budget: ${binding.budgetBytes} bytes; larger files are recorded as existence evidence and cannot pass inspection.`,
		`When finished, report the produced files with ${DOCUMENT_WORK_PROTOCOL.reportTool} using paths relative to the output root. The report only files a candidate; the desktop app archives and inspects it independently, and the user has not accepted anything yet.`,
	];
	return lines.join("\n");
}
