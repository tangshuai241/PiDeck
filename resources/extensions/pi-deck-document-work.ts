/**
 * TPA 文稿工作绑定与成果候选汇报（pi 侧）。
 *
 * 边界（见 docs/tpa-document-work-v1.md 第 5 节）：
 * - 本扩展只绑定上下文、汇报候选、声明改稿意图；不创建操作、不批准执行、不判定检查通过；
 * - 绑定命令不触发模型回合；模型汇报的候选只是候选，主进程会独立复核身份与文件；
 * - 工具执行成功或 `agent_end` 都不是归档完成——主进程自己在运行稳定后才结算。
 */
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DOCUMENT_WORK_BINDING_ENTRY_TYPE,
	DOCUMENT_WORK_REPORT_ENTRY_TYPE,
	DOCUMENT_WORK_REPORT_MAX_FILES,
	DOCUMENT_WORK_REVISION_INTENT_TYPE,
	DOCUMENT_WORK_STATE_TYPE,
	decodeArtifactCandidate,
	decodeBinding,
	decodeBindingCommandArgument,
	decodeExtensionState,
	isRecord,
	type DocumentWorkBinding,
	type DocumentWorkExtensionState,
} from "./pi-deck-document-work-types";

const CONTEXT_TYPE = "pi-deck-document-work-context";
const REPORT_BYTE_BUDGET = 64 * 1024 * 1024;

/** 与主进程 `hashTurnText` 完全一致：用正文指纹绑定授权来源，而不是消息 ID 生成方案。 */
function hashTurnText(text: string): string {
	return createHash("sha256").update(text.replace(/\r\n?/g, "\n").trim(), "utf8").digest("hex");
}

function latestUserTurn(branch: readonly unknown[]): { id: string; text: string } | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const message = entry.message;
		if (message.role !== "user") continue;
		const text = messageText(message);
		const id = typeof entry.id === "string" ? entry.id : typeof message.id === "string" ? message.id : undefined;
		if (id && text.trim()) return { id, text };
	}
	return undefined;
}

function messageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const part of content) {
		if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
	}
	return text;
}

export default function piDeckDocumentWorkExtension(pi: ExtensionAPI): void {
	let binding: DocumentWorkBinding | undefined;
	let sessionId: string | undefined;
	/** 本轮已发布的候选；同一尝试只允许汇报一次，避免覆盖已被检查的成果。 */
	let reportCache: DocumentWorkExtensionState["report"] | undefined;
	const materialStatus = new Map<string, DocumentWorkExtensionState["materials"][number]>();

	function publish(phase: DocumentWorkExtensionState["phase"], extra?: { report?: DocumentWorkExtensionState["report"]; reason?: DocumentWorkExtensionState["reason"] }): void {
		if (!binding) return;
		const state: DocumentWorkExtensionState = {
			schemaVersion: 1,
			workId: binding.workId,
			attemptId: binding.attemptId,
			preparationId: binding.preparationId,
			digest: binding.digest,
			sessionId: binding.sessionId,
			phase,
			materials: binding.materials.map((material) => materialStatus.get(material.materialId) ?? { materialId: material.materialId, status: "unknown" }),
			...(extra?.report ? { report: extra.report } : {}),
			...(extra?.reason ? { reason: extra.reason } : {}),
		};
		const parsed = decodeExtensionState(state);
		if (!parsed) throw new Error("Invalid document work state");
		pi.sendMessage({ customType: DOCUMENT_WORK_STATE_TYPE, content: "", display: false, details: { documentWork: parsed } }, { triggerTurn: false });
	}

	/** 绑定必须落盘：主进程只有看到自己的身份四元组被确认后才会分发批准。 */
	function persistBinding(ctx: ExtensionContext, next: DocumentWorkBinding): void {
		pi.appendEntry(DOCUMENT_WORK_BINDING_ENTRY_TYPE, { sessionId: next.nativeSessionId, binding: next, boundAt: Date.now() });
		binding = next;
		sessionId = next.nativeSessionId;
		materialStatus.clear();
		// 旧尝试的候选不继承：新绑定只用新汇报。
		reportCache = undefined;
	}

	function restoreSession(ctx: ExtensionContext): void {
		const current = ctx.sessionManager.getSessionId();
		sessionId = current;
		binding = undefined;
		reportCache = undefined;
		materialStatus.clear();
		let restored: DocumentWorkBinding | undefined;
		let restoredReport: DocumentWorkExtensionState["report"] | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isRecord(entry)) continue;
			if (entry.type === "custom" && entry.customType === DOCUMENT_WORK_BINDING_ENTRY_TYPE && isRecord(entry.data) && entry.data.sessionId === current) {
				const candidate = decodeBinding(entry.data.binding);
				if (candidate && candidate.sessionId === current) {
					restored = candidate;
					restoredReport = undefined;
				}
				continue;
			}
			if (entry.type === "custom" && entry.customType === DOCUMENT_WORK_REPORT_ENTRY_TYPE && isRecord(entry.data) && entry.data.sessionId === current && restored && entry.data.attemptId === restored.attemptId) {
				restoredReport = isRecord(entry.data.report) ? decodeArtifactCandidate(entry.data.report) : undefined;
			}
		}
		if (!restored) return;
		binding = restored;
		reportCache = restoredReport;
		for (const material of restored.materials) materialStatus.set(material.materialId, { materialId: material.materialId, status: "unknown" });
		// 重新发布绑定状态：应用重启后主进程需要再次确认本轮绑定仍然对应同一份准备。
		publish(restoredReport ? "reported" : "bound", restoredReport ? { report: restoredReport } : undefined);
	}

	function ensureSession(ctx: ExtensionContext): void {
		if (sessionId !== ctx.sessionManager.getSessionId()) restoreSession(ctx);
	}

	/** 候选文件必须留在本轮 staging 内，且是非空普通文件。 */
	async function verifyStagedArtifacts(candidate: { artifacts: Array<{ relativePath: string }> }): Promise<boolean> {
		if (!binding) return false;
		for (const artifact of candidate.artifacts) {
			const absolute = join(binding.stagingDirectory, ...artifact.relativePath.split("/"));
			if (isAbsolute(artifact.relativePath)) return false;
			const relativePath = relative(binding.stagingDirectory, absolute);
			if (relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
			const info = await stat(absolute).catch(() => undefined);
			if (!info?.isFile() || info.size === 0) return false;
		}
		return true;
	}

	pi.registerTool({
		name: "tpa_artifact_report",
		label: "TPA artifact report",
		description: "Report this attempt's document artifacts from the bound staging directory. Paths are relative to the staging directory. This only publishes a candidate; the desktop independently verifies files, inspects them and archives a version. Calling this tool never approves or completes anything.",
		parameters: Type.Object(
			{
				summary: Type.String({ maxLength: 2000 }),
				artifacts: Type.Array(Type.Object({ relativePath: Type.String({ maxLength: 1024 }), role: Type.Union([Type.Literal("primary"), Type.Literal("editable_source"), Type.Literal("supporting")]) }, { additionalProperties: false }), { maxItems: DOCUMENT_WORK_REPORT_MAX_FILES, minItems: 1 }),
				risks: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 24 }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ensureSession(ctx);
			if (!binding) return { content: [{ type: "text", text: "No document work is bound to this session; nothing was reported." }], details: { documentWork: { ok: false, reason: "no_work" } } };
			if (reportCache) return { content: [{ type: "text", text: `This attempt already reported ${reportCache.reportId}; candidates are not replaced.` }], details: { documentWork: { ok: false, reason: "already_reported" } } };
			const candidate = decodeArtifactCandidate({ reportId: `rp_${randomUUID().replace(/-/g, "").slice(0, 20)}`, artifacts: params.artifacts, summary: params.summary, risks: params.risks });
			if (!candidate) return { content: [{ type: "text", text: "The artifact report was rejected: use bounded relative staging paths only." }], details: { documentWork: { ok: false, reason: "invalid" } } };
			if (!(await verifyStagedArtifacts(candidate))) return { content: [{ type: "text", text: "The artifact report was rejected: every path must be a non-empty regular file inside this attempt's staging directory." }], details: { documentWork: { ok: false, reason: "missing_file" } } };
			try {
				pi.appendEntry(DOCUMENT_WORK_REPORT_ENTRY_TYPE, { sessionId: binding.nativeSessionId, attemptId: binding.attemptId, preparationId: binding.preparationId, report: candidate });
				reportCache = candidate;
				publish("reported", { report: candidate });
			} catch (error) {
				return { content: [{ type: "text", text: `The artifact report could not be persisted: ${error instanceof Error ? error.message : "unknown error"}` }], details: { documentWork: { ok: false, reason: "persist_failed" } } };
			}
			return { content: [{ type: "text", text: `Reported ${candidate.artifacts.length} candidate file(s) as ${candidate.reportId}. The desktop verifies, inspects and archives them; continue or stop normally.` }], details: { documentWork: { ok: true, reportId: candidate.reportId } } };
		},
	});

	pi.registerTool({
		name: "tpa_work_revise",
		label: "TPA document revision intent",
		description: "Declare that the user's latest message is an explicit instruction to revise the bound document. Use only when the user clearly asked for a change to the current document; the desktop verifies the latest user turn itself and prepares the revision. This never approves scope expansion or an ambiguous base.",
		parameters: Type.Object(
			{
				instruction: Type.String({ maxLength: 2000 }),
				sections: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 24 }),
				preserve: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 24 }),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ensureSession(ctx);
			if (!binding) return { content: [{ type: "text", text: "No document work is bound to this session." }], details: { documentWork: { ok: false, reason: "no_work" } } };
			const turn = latestUserTurn(ctx.sessionManager.getBranch());
			if (!turn) return { content: [{ type: "text", text: "No user turn is available to authorize a revision." }], details: { documentWork: { ok: false, reason: "no_turn" } } };
			const intent = {
				schemaVersion: 1 as const,
				workId: binding.workId,
				attemptId: binding.attemptId,
				preparationId: binding.preparationId,
				digest: binding.digest,
				sessionId: binding.sessionId,
				intentId: `ri_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
				sourceTurnId: turn.id,
				sourceTurnHash: hashTurnText(turn.text),
				instruction: params.instruction,
				sections: params.sections,
				preserve: params.preserve,
			};
			pi.sendMessage({ customType: DOCUMENT_WORK_REVISION_INTENT_TYPE, content: "", display: false, details: { documentWorkIntent: intent } }, { triggerTurn: false });
			return { content: [{ type: "text", text: "Revision intent published. The desktop decides whether it can prepare and freeze a new base; wait for its result instead of writing files." }], details: { documentWork: { ok: true, intentId: intent.intentId } } };
		},
	});

	pi.registerCommand("tpa-work", {
		description: "TPA document work binding: bind <base64url payload> | status | unbind",
		handler: async (args, ctx) => {
			ensureSession(ctx);
			const [action, ...rest] = args.trim().split(/\s+/);
			if (action === "bind") {
				const parsed = decodeBindingCommandArgument(rest.join(""));
				if (!parsed) {
					ctx.ui.notify("TPA binding rejected: the payload is not a valid bounded binding.", "warning");
					return;
				}
				// 绑定身份用 pi 原生会话 id：稳定 SessionRecord.id 与它不同（新建草稿必然不同）。
				if (parsed.nativeSessionId !== ctx.sessionManager.getSessionId()) {
					ctx.ui.notify("TPA binding rejected: the payload belongs to another session.", "warning");
					return;
				}
				try {
					persistBinding(ctx, parsed);
					publish("bound");
				} catch (error) {
					ctx.ui.notify(`TPA binding failed: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
				}
				return;
			}
			if (action === "unbind") {
				binding = undefined;
				reportCache = undefined;
				return;
			}
			if (action === "status") {
				ctx.ui.notify(binding ? `TPA work ${binding.workId}, attempt ${binding.attemptId}` : "No TPA document work is bound.", "info");
			}
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		ensureSession(ctx);
		if (!binding) return;
		const materials = binding.materials.map((material) => `${material.materialId} (${material.label})`).join(", ") || "none";
		return {
			message: {
				customType: CONTEXT_TYPE,
				display: false,
				content: `This session is executing TPA document work ${binding.workId} (attempt ${binding.attemptId}, ${binding.kind}).\nWrite every deliverable inside this attempt's staging directory: ${binding.stagingDirectory}\nRead declared materials with tpa_read_material and their materialId; never invent a path. Materials: ${materials}.\n${binding.base ? `The frozen base copy for this round is ${binding.base.path} (version ${binding.base.versionId}). Modify that copy locally; never rebuild an existing Word document from Markdown and never overwrite the original file.` : "This round creates a new document."}\nScope: ${binding.scope.summary || "as confirmed"}${binding.scope.sections.length ? `; sections: ${binding.scope.sections.join(", ")}` : ""}${binding.scope.preserve.length ? `; preserve: ${binding.scope.preserve.join(", ")}` : ""}.\nWhen the deliverables are written, call tpa_artifact_report once with staging-relative paths. Reporting is a candidate record only: the desktop verifies, inspects and archives it, and the user decides acceptance. Do not claim the work is archived, verified or accepted.`,
			},
		};
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message: unknown) => {
				if (!isRecord(message)) return true;
				if (message.customType === DOCUMENT_WORK_STATE_TYPE || message.customType === DOCUMENT_WORK_REVISION_INTENT_TYPE) return false;
				if (message.customType === CONTEXT_TYPE) return Boolean(binding);
				return true;
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_shutdown", async () => {
		binding = undefined;
		reportCache = undefined;
		sessionId = undefined;
		materialStatus.clear();
	});
}
