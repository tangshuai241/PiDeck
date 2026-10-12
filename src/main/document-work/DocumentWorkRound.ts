/**
 * TPA 独立文稿：输入校验与本轮授权解析（准备阶段的核心判断）。
 *
 * 两件事分开在这里，是因为它们都是"外部输入 → 领域事实"的唯一闸门：
 *
 * 1. `parse*` 只做形状与预算校验，纯函数；
 * 2. `resolveRound` 决定**本轮到底被授权做什么**。授权只认两种权威来源：
 *    - 首次制作：当前对齐确认单（原生投影里的 briefId + revision，必须正好是本轮要求的版本）；
 *    - 改稿：会话里那一轮**真实用户消息**（角色必须是 user、必须是最后一条用户消息、
 *      正文从会话读回并现场算指纹）。
 *
 * 渲染层布尔值、模型自报、assistant/system 文本、旧轮、编辑前正文、以及"别改，
 * 先解释第二节"这类否定句都不构成授权。范围一律来自本轮指令，绝不沿用上一轮的
 * 全篇 scope。
 */
import { createHash } from "node:crypto";
import { DOCUMENT_WORK_BUDGETS, isBoundedText, isNonNegativeInteger, isSafeRelativePath, isWorkId, normalizeChangeScope, workFail, workOk, type WorkResult } from "../../shared/documentWork";
import type { AuthorizationReference, DocumentChangeScope, DocumentMaterialReference, DocumentMaterialRoot, RequirementsReference, DocumentWorkKind } from "../../shared/types/documentWork";
import { deriveInstructionScope } from "./DocumentRevisionPolicy";
import { resolveWithinRoot, type DocumentPathFsPort } from "./DocumentPathGuard";
import type { DocumentWorkAlignmentSnapshot, DocumentUserTurnSnapshot, DocumentWorkRuntimePort, DocumentWorkRuntimeTarget } from "./DocumentWorkRuntimeAdapter";

export type DocumentWorkKindInput = DocumentWorkKind;

export type ParsedCreate = { requestId: string; sessionId: string; sourceTurnId: string; title: string; outputRootId: string };
export type ParsedPrepare = { requestId: string; workId: string; sessionId: string; expectedRevision: number; kind: DocumentWorkKind; requirementsRef: RequirementsReference; feedbackSourceTurnId?: string; baseVersionId?: string };
export type ParsedStart = {
	requestId: string;
	workId: string;
	expectedRevision: number;
	kind: DocumentWorkKind;
	preparation: { preparationId: string; digest: string };
	expectedRuntime: DocumentWorkRuntimeTarget;
	authorization: AuthorizationReference;
	attemptId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function parseCreate(input: unknown): WorkResult<ParsedCreate> {
	if (!isRecord(input)) return workFail("INVALID_INPUT", false, { detail: "create input must be an object" });
	if (!isWorkId(input.requestId) || !isWorkId(input.sourceTurnId)) return workFail("INVALID_INPUT", false, { detail: "requestId and sourceTurnId must be bounded ids" });
	// 空 outputRootId 表示首次提交时用户还没选成果目录，绑定由 set-root 补上。
	if (input.outputRootId !== undefined && input.outputRootId !== "" && !isWorkId(input.outputRootId)) return workFail("INVALID_INPUT", false, { detail: "outputRootId must be a registered root id" });
	if (!isBoundedText(input.sessionId, 200) || !input.sessionId) return workFail("INVALID_INPUT", false, { detail: "sessionId is required" });
	if (input.title !== undefined && !isBoundedText(input.title, 200)) return workFail("INVALID_INPUT", false, { detail: "title is too long" });
	return workOk({
		requestId: input.requestId,
		sessionId: input.sessionId,
		sourceTurnId: input.sourceTurnId,
		title: typeof input.title === "string" ? input.title : "document",
		outputRootId: typeof input.outputRootId === "string" ? input.outputRootId : "",
	});
}

function parseRequirementsRef(value: unknown): RequirementsReference | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "alignment" && isWorkId(value.briefId) && isNonNegativeInteger(value.revision)) return { kind: "alignment", briefId: value.briefId, revision: value.revision };
	if (value.kind === "user_instruction" && isWorkId(value.sourceTurnId)) return { kind: "user_instruction", sourceTurnId: value.sourceTurnId };
	return undefined;
}

export function parseAuthorization(value: unknown): AuthorizationReference | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "alignment_confirmation" && isWorkId(value.briefId) && isNonNegativeInteger(value.revision)) return { kind: "alignment_confirmation", briefId: value.briefId, revision: value.revision };
	if (value.kind === "revision_instruction" && isWorkId(value.sourceTurnId)) return { kind: "revision_instruction", sourceTurnId: value.sourceTurnId };
	return undefined;
}

export function parsePrepare(input: unknown): WorkResult<ParsedPrepare> {
	if (!isRecord(input)) return workFail("INVALID_INPUT", false, { detail: "prepare input must be an object" });
	if (!isWorkId(input.requestId) || !isWorkId(input.workId) || !isBoundedText(input.sessionId, 200) || !input.sessionId) return workFail("INVALID_INPUT", false, { detail: "requestId, workId and sessionId are required" });
	if (!isNonNegativeInteger(input.expectedRevision)) return workFail("INVALID_INPUT", false, { detail: "expectedRevision must be a non-negative integer" });
	if (input.kind !== "create_document" && input.kind !== "revise_document") return workFail("INVALID_INPUT", false, { detail: "kind must be create_document or revise_document" });
	const requirementsRef = parseRequirementsRef(input.requirementsRef);
	if (!requirementsRef) return workFail("INVALID_INPUT", false, { detail: "requirementsRef must be an alignment reference or a user instruction turn" });
	if (input.feedbackSourceTurnId !== undefined && !isWorkId(input.feedbackSourceTurnId)) return workFail("INVALID_INPUT", false, { detail: "feedbackSourceTurnId must be a bounded id" });
	if (input.kind === "revise_document" && input.feedbackSourceTurnId === undefined) return workFail("INVALID_INPUT", false, { detail: "a revision needs the turn that carries the change request" });
	if (input.baseVersionId !== undefined && !isWorkId(input.baseVersionId)) return workFail("INVALID_INPUT", false, { detail: "baseVersionId must be a bounded id" });
	return workOk({
		requestId: input.requestId,
		workId: input.workId,
		sessionId: input.sessionId,
		expectedRevision: input.expectedRevision,
		kind: input.kind,
		requirementsRef,
		...(typeof input.feedbackSourceTurnId === "string" ? { feedbackSourceTurnId: input.feedbackSourceTurnId } : {}),
		...(typeof input.baseVersionId === "string" ? { baseVersionId: input.baseVersionId } : {}),
	});
}

export function parseStart(input: unknown, newId: (prefix: string) => string): WorkResult<ParsedStart> {
	if (!isRecord(input)) return workFail("INVALID_INPUT", false, { detail: "start input must be an object" });
	if (!isWorkId(input.workId) || !isWorkId(input.requestId) || !isNonNegativeInteger(input.expectedRevision)) return workFail("INVALID_INPUT", false, { detail: "workId, requestId and expectedRevision are required" });
	if (input.kind !== "create_document" && input.kind !== "revise_document") return workFail("INVALID_INPUT", false, { detail: "kind must be create_document or revise_document" });
	if (!isRecord(input.preparation) || !isWorkId(input.preparation.preparationId) || !isBoundedText(input.preparation.digest, 200) || !input.preparation.digest) return workFail("INVALID_INPUT", false, { detail: "the preparation reference is malformed" });
	if (!isRecord(input.expectedRuntime)) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime is required" });
	const runtime = input.expectedRuntime;
	if (!isBoundedText(runtime.sessionId, 200) || !isBoundedText(runtime.agentId, 200) || !isNonNegativeInteger(runtime.runtimeGeneration)) return workFail("INVALID_INPUT", false, { detail: "expectedRuntime must carry the full runtime triple" });
	if (runtime.piSessionId !== undefined && !isBoundedText(runtime.piSessionId, 200)) return workFail("INVALID_INPUT", false, { detail: "piSessionId is malformed" });
	const authorization = parseAuthorization(input.authorization);
	if (!authorization) return workFail("INVALID_INPUT", false, { detail: "authorization must be an alignment confirmation or a revision instruction" });
	return workOk({
		requestId: input.requestId,
		workId: input.workId,
		expectedRevision: input.expectedRevision,
		kind: input.kind,
		preparation: { preparationId: input.preparation.preparationId, digest: input.preparation.digest },
		expectedRuntime: {
			sessionId: runtime.sessionId,
			agentId: runtime.agentId,
			runtimeGeneration: runtime.runtimeGeneration,
			...(typeof runtime.piSessionId === "string" ? { piSessionId: runtime.piSessionId } : {}),
		},
		authorization,
		attemptId: newId("attempt"),
	});
}

/** 用户指令的稳定指纹（准备阶段冻结、分发前复查）。 */
export function instructionDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export type ResolvedRound = {
	scope: DocumentChangeScope;
	requirementsRef: RequirementsReference;
	authorization: AuthorizationReference;
	materials: DocumentMaterialReference[];
	materialRoots: DocumentMaterialRoot[];
	instruction?: { sourceTurnId: string; text: string; textDigest: string };
	/** 用户可见的本轮摘要（不含正文）。 */
	summary: string;
};

export type RoundDeps = {
	runtime: DocumentWorkRuntimePort;
	pathFs: DocumentPathFsPort;
	newId: (prefix: string) => string;
	/** 读取冻结基稿里实际存在的标题；拿不到时返回空数组（不猜）。 */
	readBaseHeadings: (absolutePath: string) => Promise<string[]>;
};

/**
 * 材料登记：只接受**已授权根**内真实存在的文件。
 *
 * 根来自用户已有的授权入口（成果目录选择 / 项目目录），因此材料不必先搬进成果目录；
 * 要求单里的非路径描述按描述忽略，不猜路径。
 */
export function collectMaterials(input: { roots: readonly DocumentMaterialRoot[]; candidates: readonly string[]; pathFs: DocumentPathFsPort; newId: (prefix: string) => string }): DocumentMaterialReference[] {
	const materials: DocumentMaterialReference[] = [];
	for (const candidate of input.candidates) {
		const trimmed = candidate.trim();
		if (!trimmed || trimmed.length > 500) continue;
		const relative = trimmed.replace(/\\/g, "/");
		if (!isSafeRelativePath(relative)) continue;
		for (const root of input.roots) {
			const resolved = resolveWithinRoot(input.pathFs, root.path, relative);
			if (!resolved.ok) continue;
			const stat = input.pathFs.stat(resolved.absolutePath);
			if (!stat || !stat.isFile() || stat.size === 0 || stat.size > DOCUMENT_WORK_BUDGETS.materialBytes) continue;
			const data = input.pathFs.readFile(resolved.absolutePath);
			if (!data) continue;
			materials.push({
				materialId: input.newId("mat"),
				rootId: root.rootId,
				relativePath: relative,
				sha256: createHash("sha256").update(data).digest("hex"),
				bytes: data.byteLength,
				converter: "anydoc",
			});
			break;
		}
		if (materials.length >= 32) break;
	}
	return materials;
}

/**
 * 首次制作的授权：只认**当前**对齐确认单。
 *
 * `revision` 必须与要求的版本完全一致（确认单在准备期间变过就失效），
 * 且不得还有未回答的问题。用户指令、模型文本、布尔值都不在这里出现。
 */
export function resolveCreateAuthorization(input: { requirementsRef: RequirementsReference; alignment: DocumentWorkAlignmentSnapshot | undefined }): WorkResult<{ authorization: AuthorizationReference; scope: DocumentChangeScope; briefPreserve: string[] }> {
	if (input.requirementsRef.kind !== "alignment") return workFail("APPROVAL_REQUIRED", false, { detail: "first production is dispatched only by the current requirements confirmation" });
	const alignment = input.alignment;
	if (!alignment || alignment.briefId !== input.requirementsRef.briefId) return workFail("APPROVAL_REQUIRED", true, { detail: "the confirmation sheet for this work is no longer the live one" });
	if (alignment.revision !== input.requirementsRef.revision) return workFail("PREPARATION_STALE", true, { detail: "the requirements changed after this confirmation" });
	if (alignment.phase !== "ready" && alignment.phase !== "approved") return workFail("APPROVAL_REQUIRED", true, { detail: "the confirmation sheet is not in a state that allows execution" });
	if (alignment.hasOpenQuestions) return workFail("APPROVAL_REQUIRED", true, { detail: "the confirmation sheet still has unanswered questions" });
	// 初稿没有可比对象：范围只是说明，不参与正文授权判定；要求单里的"必须保留"照常冻结。
	// 因此这里不套用"整篇授权与保留块互斥"的改稿规则。
	const briefPreserve = [...(alignment.brief?.preserve ?? [])].map((item) => item.trim()).filter((item) => item.length > 0);
	const scope: DocumentChangeScope = { allow: [], preserve: briefPreserve, wholeDocument: true };
	return workOk({ authorization: { kind: "alignment_confirmation", briefId: alignment.briefId, revision: alignment.revision }, scope, briefPreserve });
}

/**
 * 改稿的授权与范围：授权来自"那一轮真实用户消息"，范围来自"本轮指令"。
 *
 * 三个必须同时成立才能派发：
 * - 轮次存在、角色是 user、正文读得回来；
 * - 轮次是这条会话里**最后一条**用户消息（旧轮或被更新的消息挤掉都作废）；
 * - 从本轮指令能定位到冻结基稿里真实存在的章节（说不清就澄清）。
 */
export function resolveRevisionRound(input: {
	instruction: string;
	turn: DocumentUserTurnSnapshot | undefined;
	sourceTurnId: string;
	expectedDigest?: string;
	baseHeadings: readonly string[];
	inheritedPreserve?: readonly string[];
}): WorkResult<{ authorization: AuthorizationReference; scope: DocumentChangeScope; instruction: { sourceTurnId: string; text: string; textDigest: string }; summary: string }> {
	const turn = input.turn;
	if (!turn || turn.entryId !== input.sourceTurnId) return workFail("APPROVAL_REQUIRED", false, { detail: "the change request could not be read back from this session" });
	if (turn.role !== "user") return workFail("APPROVAL_REQUIRED", false, { detail: "only a real user message can authorize a revision" });
	if (!turn.isLatestUserTurn) return workFail("APPROVAL_REQUIRED", true, { detail: "a newer user message arrived after this request; confirm the change again" });
	const text = turn.text.trim();
	if (!text) return workFail("APPROVAL_REQUIRED", false, { detail: "the change request is empty" });
	if (text.length > DOCUMENT_WORK_BUDGETS.instructionChars) return workFail("INVALID_INPUT", false, { detail: "the change request exceeds the instruction budget" });
	if (instructionDigest(text) !== turn.textDigest) return workFail("PREPARATION_STALE", true, { detail: "the change request changed while it was being prepared" });
	if (input.expectedDigest && input.expectedDigest !== turn.textDigest) return workFail("PREPARATION_STALE", true, { detail: "the change request no longer matches the reported intent" });
	const decision = deriveInstructionScope({ instruction: text, baseHeadings: input.baseHeadings, inheritedPreserve: input.inheritedPreserve });
	if (decision.kind === "clarify") return workFail("APPROVAL_REQUIRED", false, { detail: decision.reason });
	return workOk({
		authorization: { kind: "revision_instruction", sourceTurnId: input.sourceTurnId },
		scope: decision.scope,
		instruction: { sourceTurnId: input.sourceTurnId, text, textDigest: turn.textDigest },
		summary: decision.scope.wholeDocument ? "revise the whole document" : `revise ${decision.matched.join(" / ")}`,
	});
}

export { isRecord };
