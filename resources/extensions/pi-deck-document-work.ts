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
	DOCUMENT_WORK_EXECUTION_TYPE,
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
	/** 本轮是否还在制作：结算完成后只保留后台身份，不再注入制作上下文。 */
	let attemptLive = false;
	/** 已经触发过执行的那一次尝试：同一绑定只允许执行一次（重复/释放/重启都不再开一轮）。 */
	let executedAttemptId: string | undefined;

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
		attemptLive = true;
		executedAttemptId = undefined;
		materialStatus.clear();
		// 旧尝试的候选不继承：新绑定只用新汇报。
		reportCache = undefined;
	}

	/**
	 * 本轮执行上下文的正文：每次都由「当前绑定」现场拼出，绝不缓存/复用旧轮文本。
	 * staging/base/scope 三样是模型唯一可信的落盘依据（真实验收里模型因为看不到它，
	 * 去翻了旧 outputs 与源码，先写错旧工作再靠读准备文件猜回为止）。
	 */
	function contextText(current: DocumentWorkBinding): string {
		const materials = current.materials.map((material) => `${material.materialId} (${material.label})`).join(", ") || "none";
		return `This session is executing TPA document work ${current.workId} (attempt ${current.attemptId}, ${current.kind}).\nWrite every deliverable inside this attempt's staging directory: ${current.stagingDirectory}\nRead declared materials with tpa_read_material and their materialId; never invent a path. Materials: ${materials}.\n${current.base ? `The frozen base copy for this round is ${current.base.path} (version ${current.base.versionId}). Modify that copy locally; never rebuild an existing Word document from Markdown and never overwrite the original file.` : "This round creates a new document."}\nScope: ${current.scope.summary || "as confirmed"}${current.scope.sections.length ? `; sections: ${current.scope.sections.join(", ")}` : ""}${current.scope.preserve.length ? `; preserve: ${current.scope.preserve.join(", ")}` : ""}.\nWhen the deliverables are written, call tpa_artifact_report once with staging-relative paths. Reporting is a candidate record only: the desktop verifies, inspects and archives it, and the user decides acceptance. Do not claim the work is archived, verified or accepted.`;
	}

	/**
	 * 本轮正式改稿指令：只由**冻结绑定**里的 scope/base 现场派生，
	 * 不接受调用方自由文本——编码载荷是通道，不是授权，也不是可随意改写的指示。
	 * 与主进程 `buildRevisionPrompt(preparation)` 同形（契约测试逐字比对）。
	 */
	function revisionInstruction(current: DocumentWorkBinding): string {
		const sections = current.scope.sections.length ? `
声明要改的块：${current.scope.sections.join("、")}` : "";
		const preserve = current.scope.preserve.length ? `
必须保留（逐块比较，改动会被判为未授权）：${current.scope.preserve.join("、")}` : "";
		return `改稿要求：${current.scope.summary}${sections}${preserve}
只改声明的范围；成果写入本轮 staging 并调用 tpa_artifact_report 汇报候选。`;
	}

	/** 只有「本轮仍在制作」才产出上下文；结算/释放后连旧消息一起去掉。 */
	function currentContextMessage(): Record<string, unknown> | undefined {
		if (!binding || !attemptLive) return undefined;
		return { role: "custom", customType: CONTEXT_TYPE, content: contextText(binding), display: false, details: { workId: binding.workId, attemptId: binding.attemptId, preparationId: binding.preparationId, digest: binding.digest }, timestamp: Date.now() };
	}

	/**
	 * 同一条请求里只保留一份「当前轮」的上下文；旧轮/已结算/未绑定的条目一律丢掉。
	 * 必须同时要求 attemptLive：release 之后即使历史里还躺着一条身份完全匹配的上下文，
	 * 它也不得继续当「正在制作」的指令跟到普通聊天里。
	 */
	function isCurrentContextMessage(message: unknown): boolean {
		if (!binding || !attemptLive || !isRecord(message) || message.customType !== CONTEXT_TYPE) return false;
		const details = message.details;
		if (!isRecord(details)) return false;
		return details.attemptId === binding.attemptId && details.preparationId === binding.preparationId && details.digest === binding.digest;
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
				if (candidate && candidate.nativeSessionId === current) {
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
		attemptLive = false;
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
		description: "TPA document work binding: bind <base64url payload> | execute <base64url payload> | release | status | unbind",
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
			if (action === "execute") {
				// 本轮正式执行只能由宿主在「扩展已确认绑定 + 主进程复核过人类轮」之后触发。
				// 载荷只是通道（不是授权）：逐项必须与**当前仍在制作的绑定**完全一致，
				// 而且一次绑定只能执行一次——release 后、重复请求、重启恢复的旧绑定都不许
				// 再开一轮。提示词现场从冻结 scope 派生，以自定义消息出发并触发一轮，
				// 因此它在原生会话里**不是** role:user 轮（v2→v3 无限改稿的结构性防线）。
				const raw = decodeBindingCommandArgument(rest.join(""));
				if (!raw) {
					ctx.ui.notify("TPA execution rejected: the payload is not a valid bounded binding.", "warning");
					return;
				}
				if (raw.nativeSessionId !== ctx.sessionManager.getSessionId()) {
					ctx.ui.notify("TPA execution rejected: the payload belongs to another session.", "warning");
					return;
				}
				if (raw.kind !== "revise_document") {
					ctx.ui.notify("TPA execution rejected: only a revision round can be executed this way.", "warning");
					return;
				}
				if (
					!binding ||
					!attemptLive ||
					binding.workId !== raw.workId ||
					binding.attemptId !== raw.attemptId ||
					binding.preparationId !== raw.preparationId ||
					binding.digest !== raw.digest ||
					binding.sessionId !== raw.sessionId ||
					executedAttemptId === raw.attemptId
				) {
					ctx.ui.notify("TPA execution rejected: no matching live binding for this attempt.", "warning");
					return;
				}
				executedAttemptId = raw.attemptId;
				pi.sendMessage(
					{
						customType: DOCUMENT_WORK_EXECUTION_TYPE,
						content: revisionInstruction(binding),
						display: false,
						details: { workId: binding.workId, attemptId: binding.attemptId, preparationId: binding.preparationId, digest: binding.digest },
					},
					{ triggerTurn: true },
				);
				return;
			}
			if (action === "release") {
				// 结算已完成：绑定身份留着做后台归属，但不再注入「本轮要制作」的上下文，
				// 否则下一轮普通聊天还会被上一轮的执行要求污染；执行权同时收回。
				attemptLive = false;
				executedAttemptId = undefined;
				return;
			}
			if (action === "unbind") {
				binding = undefined;
				reportCache = undefined;
				attemptLive = false;
				return;
			}
			if (action === "status") {
				ctx.ui.notify(binding ? `TPA work ${binding.workId}, attempt ${binding.attemptId}` : "No TPA document work is bound.", "info");
			}
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		ensureSession(ctx);
		// 用用户提示词开新回合的路径：这里返回的消息会落成一条 custom_message（可审计）。
		// 但 pi.sendMessage(triggerTurn: true) 的续跑路径不会触发本钩子，因此真正的保底在
		// 下面的 `context`：每个模型请求都会经过它。
		const message = currentContextMessage();
		return message ? { message } : undefined;
	});

	pi.on("context", async (event, ctx) => {
		// 会话边界也要认一次：换了原生会话必须立即按新会话恢复/清空绑定，
		// 否则跨会话的第一次请求可能带着上个会话的上下文。
		ensureSession(ctx);
		// 保留/注入本轮上下文的唯一可靠位置：`context` 对每个模型请求都执行。
		// 背景（真机会话）：批准走的是 alignment 的 pi.sendMessage(triggerTurn: true)，
		// 不经过 before_agent_start，于是模型请求里从未出现 document-work-context，
		// 模型只能去翻旧输出/源码猜 staging。
		const messages: unknown[] = [];
		let kept = false;
		for (const message of event.messages) {
			if (!isRecord(message)) {
				messages.push(message);
				continue;
			}
			if (message.customType === DOCUMENT_WORK_STATE_TYPE || message.customType === DOCUMENT_WORK_REVISION_INTENT_TYPE) continue;
			if (message.customType === DOCUMENT_WORK_EXECUTION_TYPE) {
				// 执行提示只在「本轮仍在制作且完整四元组都匹配」时进入请求；release 之后
				// 它不得继续留在上下文里驱动下一轮普通聊天。
				const details = message.details;
				if (
					binding &&
					attemptLive &&
					isRecord(details) &&
					details.workId === binding.workId &&
					details.attemptId === binding.attemptId &&
					details.preparationId === binding.preparationId &&
					details.digest === binding.digest
				) {
					messages.push(message);
				}
				continue;
			}
			if (message.customType === CONTEXT_TYPE) {
				if (!kept && isCurrentContextMessage(message)) {
					kept = true;
					messages.push(message);
				}
				// 旧轮上下文一律丢弃：新绑定只能配新 staging/base/scope。
				continue;
			}
			messages.push(message);
		}
		const live = currentContextMessage();
		// 续跑路径没有现成条目：补到末尾，紧贴本轮要求，且不动前面的前缀（对提示缓存友好）。
		if (!kept && live) messages.push(live);
		return { messages };
	});

	pi.on("session_start", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_shutdown", async () => {
		binding = undefined;
		attemptLive = false;
		reportCache = undefined;
		sessionId = undefined;
		materialStatus.clear();
	});
}
