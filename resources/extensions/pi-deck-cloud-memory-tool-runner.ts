/**
 * pi-deck-cloud-memory-tool-runner —— 两级记忆工具的执行体（HTTP + 观察 + profile guard）。
 *
 * 为什么单列：主入口只留「注册 + 事件装配」；这里是工具真正的行为：
 * - 请求前与结果返回前都用回合固定的 profile key 复核（owner/baseUrl/stateDir 任一变化即丢弃旧结果）；
 * - 无 deadline、无 retry、不跟随 redirect；取消返回真实 aborted 状态；
 * - 观察记录（tool 调用）与配置状态只写白名单字段，绝不含 query 或正文。
 */

import { performance } from "node:perf_hooks";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { isRecord } from "./pi-deck-cloud-memory-config";
import {
	buildSearchBody,
	buildSearchResultText,
	buildSourcePath,
	buildSourceQuery,
	buildSourceResultText,
	buildUnavailableText,
	isFailureStatus,
	searchStatus,
	sourceStatus,
	TOOL_GET_MEMORY_SOURCE,
	TOOL_SEARCH_MEMORY,
	type CloudMemoryRecordStatus,
	type CloudMemoryToolName,
	type SearchToolArgs,
	type ServerTiming,
	type SourceToolArgs,
	type ToolResultStatus,
} from "./pi-deck-cloud-memory-policy";
import { MAX_RESPONSE_BYTES, parseSearchResponse, parseSourceResponse, readBoundedResponseText, type SearchOutcome, type SourceOutcome } from "./pi-deck-cloud-memory-response";
import type { ProfileLoadResult, RuntimeProfile } from "./pi-deck-cloud-memory-runtime-config";

/** Node 22 自带 fetch；显式声明避免依赖 DOM lib。 */
declare const fetch: (url: string, init?: Record<string, unknown>) => Promise<unknown>;

export type ToolDetails = { status: ToolResultStatus; reason: string | null; itemCount: number | null; sourceIds: string[]; partial: boolean | null };

export type ToolRecordInput = {
	tool: CloudMemoryToolName;
	status: CloudMemoryRecordStatus;
	reason: string | null;
	toolMs: number | null;
	sessionId: string | null;
	serverTiming?: ServerTiming | null;
	itemCount?: number | null;
	previewTruncatedCount?: number | null;
	partial?: boolean | null;
	offset?: number | null;
	nextOffset?: number | null;
	totalChars?: number | null;
	contentChars?: number | null;
	sourceIds?: readonly unknown[];
};

export type ToolRunnerPorts = {
	readProfile: () => Promise<ProfileLoadResult | null>;
	profileKeyOf: (profile: RuntimeProfile) => string;
	/** 本回合固定的 profile key（无回合时为 null，表示不设 guard）。 */
	currentTurnProfileKey: () => string | null;
	/** 同一 session 换账号被锁：不发任何请求，直接返回 needs_new_session。 */
	isTurnBlocked: () => boolean;
	emitProfileChanged: (sessionId: string | null) => void;
	appendToolRecord: (logFile: string, input: ToolRecordInput) => void;
	noteToolCall: (logFile: string, sessionId: string | null, outcome: { status: ToolResultStatus; toolMs: number; sourceIds: string[]; failed: boolean }) => void;
	reportConfigOnce: (sessionId: string | null, status: CloudMemoryRecordStatus, reason: string, logFile: string) => void;
	/** 配置不可读时的默认观测日志路径。 */
	defaultLogFile: () => string;
	makeRunId: () => string;
};

export type ToolRunner = {
	runSearch(ctx: SessionIdReader, args: SearchToolArgs, signal: AbortSignal | undefined): Promise<AgentToolResult<ToolDetails>>;
	runSource(ctx: SessionIdReader, args: SourceToolArgs, signal: AbortSignal | undefined): Promise<AgentToolResult<ToolDetails>>;
};

export type SessionIdReader = { sessionManager?: { getSessionId?: () => unknown } };

type ProfileFailure = Exclude<ProfileLoadResult, { kind: "ok" }>;
type HttpFailure = { kind: "network_error" } | { kind: "aborted"; reason: string } | { kind: "too_large" } | { kind: "invalid_json" };
type HttpResult = { kind: "ok"; status: number; body: unknown } | HttpFailure;

function readSessionId(ctx: SessionIdReader): string | null {
	try {
		const value = ctx.sessionManager?.getSessionId?.();
		return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
	} catch {
		return null;
	}
}

export function toolResult(text: string, status: ToolResultStatus, reason: string | null, extra: Partial<ToolDetails>): AgentToolResult<ToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { status, reason, itemCount: extra.itemCount ?? null, sourceIds: extra.sourceIds ?? [], partial: extra.partial ?? null },
		isError: isFailureStatus(status),
	};
}

function configStatus(loaded: ProfileFailure): { status: CloudMemoryRecordStatus; reason: string } {
	if (loaded.kind === "missing") return { status: "unconfigured", reason: "config_missing" };
	if (loaded.kind === "disabled") return { status: "disabled", reason: loaded.reason };
	return { status: "config_invalid", reason: loaded.reason };
}

function responseStatus(value: unknown): number {
	if (isRecord(value) && typeof value.status === "number" && Number.isFinite(value.status)) return Math.trunc(value.status);
	return 0;
}

/** 单个 HTTP 调用：无 deadline、无 retry、不跟随 redirect（避免认证被转发到别的端点）。 */
async function requestJson(path: string, method: "GET" | "POST", body: string | null, baseUrl: string, token: string, runId: string, tool: CloudMemoryToolName, signal: AbortSignal | undefined): Promise<HttpResult> {
	if (signal?.aborted) return { kind: "aborted", reason: "client_aborted" };
	const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", "x-tpa-memory-run-id": runId, "x-tpa-memory-tool": tool };
	if (body !== null) headers["content-type"] = "application/json";
	let response: unknown;
	try {
		response = await fetch(`${baseUrl}${path}`, { method, headers, body: body ?? undefined, redirect: "error", signal });
	} catch {
		return signal?.aborted ? { kind: "aborted", reason: "client_aborted" } : { kind: "network_error" };
	}
	const read = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
	if (read.kind === "error") return read.reason === "response_too_large" ? { kind: "too_large" } : { kind: "invalid_json" };
	const text = read.text.trim();
	if (text === "") return { kind: "ok", status: responseStatus(response), body: null };
	try {
		return { kind: "ok", status: responseStatus(response), body: JSON.parse(text) };
	} catch {
		return { kind: "invalid_json" };
	}
}

function httpFailureReason(failure: HttpFailure): string {
	if (failure.kind === "aborted") return failure.reason;
	if (failure.kind === "too_large") return "response_too_large";
	if (failure.kind === "invalid_json") return "invalid_json";
	return "network_error";
}

function httpFailureReasonOf(outcome: SearchOutcome | SourceOutcome): string | null {
	if ("reason" in outcome && typeof outcome.reason === "string") return outcome.reason;
	if (outcome.kind === "unavailable") return "cloud_unavailable";
	if (outcome.kind === "not_found" || outcome.kind === "missing") return "not_found";
	if (outcome.kind === "auth_required") return "auth_required";
	return null;
}

function searchSourceIds(outcome: SearchOutcome): string[] {
	if (outcome.kind !== "items") return [];
	const ids = new Set<string>();
	for (const item of outcome.items) {
		if (item.sourceId) ids.add(item.sourceId);
		if (Array.isArray(item.sources)) for (const ref of item.sources) ids.add(ref.sourceId);
	}
	return [...ids];
}

function sourceSourceIds(outcome: SourceOutcome): string[] {
	if (outcome.kind !== "source") return [];
	const ids = new Set<string>();
	if (outcome.source.sourceId) ids.add(outcome.source.sourceId);
	for (const piece of outcome.source.pieces) if (piece.sourceId) ids.add(piece.sourceId);
	return [...ids];
}

export function createToolRunner(ports: ToolRunnerPorts): ToolRunner {
	function configUnavailableResult(tool: CloudMemoryToolName, loaded: ProfileFailure, ctx: SessionIdReader): AgentToolResult<ToolDetails> {
		const { status, reason } = configStatus(loaded);
		const sessionId = readSessionId(ctx);
		const logFile = ports.defaultLogFile();
		ports.reportConfigOnce(sessionId, status, reason, logFile);
		ports.appendToolRecord(logFile, { tool, status, reason, toolMs: null, sessionId });
		ports.noteToolCall(logFile, sessionId, { status: "error", toolMs: 0, sourceIds: [], failed: true });
		return toolResult(buildUnavailableText(tool, status, reason), "error", reason, {});
	}

	function profileChangedResult(tool: CloudMemoryToolName, sessionId: string | null): AgentToolResult<ToolDetails> {
		ports.emitProfileChanged(sessionId);
		return toolResult(buildUnavailableText(tool, "error", "profile_changed"), "error", "profile_changed", {});
	}

	/** 结果返回前的 guard：profile 变了（含 baseUrl/stateDir/owner）就丢弃旧档案结果。 */
	async function profileChangedSince(keyAtStart: string | null): Promise<boolean> {
		if (keyAtStart === null) return false;
		const loaded = await ports.readProfile();
		if (!loaded || loaded.kind !== "ok") return true;
		return ports.profileKeyOf(loaded.profile) !== keyAtStart;
	}

	return {
		async runSearch(ctx, args, signal) {
			const startedAt = performance.now();
			const sessionId = readSessionId(ctx);
			if (ports.isTurnBlocked()) return toolResult(buildUnavailableText(TOOL_SEARCH_MEMORY, "error", "needs_new_session"), "error", "needs_new_session", {});
			const keyAtStart = ports.currentTurnProfileKey();
			const loaded = await ports.readProfile();
			if (!loaded || loaded.kind !== "ok") return configUnavailableResult(TOOL_SEARCH_MEMORY, loaded ?? { kind: "invalid", reason: "config_unreadable" }, ctx);
			const profile = loaded.profile;
			// 请求前 guard：本回合固定的 profile 变了就不发请求（旧 runtime 不得换账号查询）。
			if (keyAtStart !== null && ports.profileKeyOf(profile) !== keyAtStart) return profileChangedResult(TOOL_SEARCH_MEMORY, sessionId);

			const call = await requestJson("/api/cloud/memories/recall", "POST", JSON.stringify(buildSearchBody(args)), profile.config.baseUrl, profile.token, ports.makeRunId(), TOOL_SEARCH_MEMORY, signal);
			if (await profileChangedSince(keyAtStart)) return profileChangedResult(TOOL_SEARCH_MEMORY, sessionId);
			const outcome: SearchOutcome = call.kind === "ok" ? parseSearchResponse(call.status, call.body) : call.kind === "aborted" ? { kind: "aborted", reason: call.reason } : { kind: "error", reason: httpFailureReason(call) };
			const status = searchStatus(outcome);
			const toolMs = performance.now() - startedAt;
			const sourceIds = searchSourceIds(outcome);
			ports.appendToolRecord(profile.config.logFile, {
				tool: TOOL_SEARCH_MEMORY,
				status,
				reason: outcome.kind === "items" ? null : httpFailureReasonOf(outcome),
				toolMs,
				sessionId,
				serverTiming: outcome.kind === "items" ? outcome.serverTiming : null,
				itemCount: outcome.kind === "items" ? outcome.items.length : null,
				previewTruncatedCount: outcome.kind === "items" ? outcome.items.filter((item) => item.previewTruncated === true).length : null,
				partial: outcome.kind === "items" ? outcome.budget.partial : null,
				sourceIds,
			});
			ports.noteToolCall(profile.config.logFile, sessionId, { status, toolMs, sourceIds, failed: isFailureStatus(status) });
			const itemCount = outcome.kind === "items" ? outcome.items.length : null;
			const partial = outcome.kind === "items" ? outcome.budget.partial : null;
			return toolResult(buildSearchResultText(args, outcome), status, outcome.kind === "items" ? null : httpFailureReasonOf(outcome), { itemCount, sourceIds, partial });
		},

		async runSource(ctx, args, signal) {
			const startedAt = performance.now();
			const sessionId = readSessionId(ctx);
			if (ports.isTurnBlocked()) return toolResult(buildUnavailableText(TOOL_GET_MEMORY_SOURCE, "error", "needs_new_session"), "error", "needs_new_session", {});
			const keyAtStart = ports.currentTurnProfileKey();
			const loaded = await ports.readProfile();
			if (!loaded || loaded.kind !== "ok") return configUnavailableResult(TOOL_GET_MEMORY_SOURCE, loaded ?? { kind: "invalid", reason: "config_unreadable" }, ctx);
			const profile = loaded.profile;
			if (keyAtStart !== null && ports.profileKeyOf(profile) !== keyAtStart) return profileChangedResult(TOOL_GET_MEMORY_SOURCE, sessionId);

			const path = `${buildSourcePath(args)}${buildSourceQuery(args)}`;
			const call = await requestJson(path, "GET", null, profile.config.baseUrl, profile.token, ports.makeRunId(), TOOL_GET_MEMORY_SOURCE, signal);
			if (await profileChangedSince(keyAtStart)) return profileChangedResult(TOOL_GET_MEMORY_SOURCE, sessionId);
			const outcome: SourceOutcome = call.kind === "ok" ? parseSourceResponse(call.status, call.body) : call.kind === "aborted" ? { kind: "aborted", reason: call.reason } : { kind: "error", reason: httpFailureReason(call) };
			const status = sourceStatus(outcome);
			const toolMs = performance.now() - startedAt;
			const sourceIds = sourceSourceIds(outcome);
			ports.appendToolRecord(profile.config.logFile, {
				tool: TOOL_GET_MEMORY_SOURCE,
				status,
				reason: outcome.kind === "source" ? null : httpFailureReasonOf(outcome),
				toolMs,
				sessionId,
				offset: outcome.kind === "source" ? outcome.source.offset : null,
				nextOffset: outcome.kind === "source" ? outcome.source.nextOffset : null,
				totalChars: outcome.kind === "source" ? outcome.source.totalChars : null,
				contentChars: outcome.kind === "source" ? outcome.source.content.length : null,
				partial: outcome.kind === "source" ? outcome.source.partial : null,
				sourceIds,
			});
			ports.noteToolCall(profile.config.logFile, sessionId, { status, toolMs, sourceIds, failed: isFailureStatus(status) });
			const partial = outcome.kind === "source" ? outcome.source.partial : null;
			return toolResult(buildSourceResultText(args, outcome), status, outcome.kind === "source" ? null : httpFailureReasonOf(outcome), { itemCount: null, sourceIds, partial });
		},
	};
}
