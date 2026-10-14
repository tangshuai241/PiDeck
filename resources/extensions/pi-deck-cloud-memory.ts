/**
 * pi-deck-cloud-memory —— 云端个人记忆按需两级工具（薄装配：工具注册 + 观察 + 事件转发）。
 *
 * 责任划分：
 * - 工具执行体在 `pi-deck-cloud-memory-tool-runner.ts`（HTTP/观察/profile guard）；
 * - profile/人格/采集/sender 在 `pi-deck-cloud-memory-runtime.ts`（含 sync-sender-host 生命周期）；
 * - 这里只做：注册两个 direct 工具、回合观察记录、事件转发、状态控制消息过滤。
 *
 * 硬约束：没有工具调用的回合零云端请求、零模型调用；本地仍会读一次配置快照与已确认人格缓存
 * （纯本地文件读取，不联网、不写观测日志）；回答路径不 await 云 HTTP；
 * 不写 Pi 原生会话文件；观察记录与状态绝不含 query、原话正文或凭据。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createObservationLog } from "./pi-deck-cloud-memory-log";
import {
	addUsage,
	buildLogRecord,
	buildUnavailableText,
	GET_MEMORY_SOURCE_DESCRIPTION,
	GET_MEMORY_SOURCE_GUIDELINES,
	GET_MEMORY_SOURCE_SNIPPET,
	MAX_MAX_CHARS,
	MAX_MAX_TOKENS,
	MAX_OFFSET,
	MAX_RECORD_INDEX,
	MAX_SAFE_ITEMS,
	MIN_MAX_CHARS,
	MIN_MAX_TOKENS,
	normalizeSearchArgs,
	normalizeSourceArgs,
	SEARCH_MEMORY_DESCRIPTION,
	SEARCH_MEMORY_GUIDELINES,
	SEARCH_MEMORY_SNIPPET,
	TIMING_ENTRY_TYPE,
	TOOL_GET_MEMORY_SOURCE,
	TOOL_SEARCH_MEMORY,
	type CloudMemoryRecordStatus,
	type CloudMemoryToolName,
	type ToolResultStatus,
	type UsageSnapshot,
} from "./pi-deck-cloud-memory-policy";
import { createCloudMemoryRuntime, type CloudMemoryRuntime, type TurnRuntime } from "./pi-deck-cloud-memory-runtime";
import { defaultLogFileFor } from "./pi-deck-cloud-memory-runtime-config";
import { isStatusControlMessage, sendCloudMemoryStatus } from "./pi-deck-cloud-memory-status";
import { createToolRunner, toolResult, type ToolDetails, type ToolRecordInput } from "./pi-deck-cloud-memory-tool-runner";

/** 一个用户回合的观察状态（档案状态在 runtime，这里只有工具/耗时/用量字段）。 */
type TurnObservation = {
	runId: string;
	sessionId: string | null;
	logFile: string | null;
	startedAt: number;
	firstTextAt: number | null;
	requestCount: number;
	toolCalls: number;
	toolMs: number;
	sourceIds: string[];
	hadFailure: boolean;
	usage: UsageSnapshot | null;
	profileKey: string | null;
	personaRevision: string | null;
};

type SessionIdReader = { sessionManager?: { getSessionId?: () => unknown } };

function readSessionId(ctx: SessionIdReader): string | null {
	try {
		const value = ctx.sessionManager?.getSessionId?.();
		return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
	} catch {
		return null;
	}
}

/** 同步读文件端口：走 node:fs（测试用假 fs 注入），带上界与错误收窄。 */
async function boundedReadText(path: string, maxBytes: number): Promise<{ kind: "ok"; text: string } | { kind: "missing" } | { kind: "invalid"; reason: string }> {
	try {
		if (!existsSync(path)) return { kind: "missing" };
		if (statSync(path).size > maxBytes) return { kind: "invalid", reason: "too_large" };
		return { kind: "ok", text: readFileSync(path, "utf8") };
	} catch {
		return { kind: "invalid", reason: "read_failed" };
	}
}

export default function piDeckCloudMemory(pi: ExtensionAPI): void {
	let runCounter = 0;
	const makeRunId = (): string => `${process.pid.toString(36)}-${Date.now().toString(36)}${(runCounter++).toString(36)}`;
	const observationLog = createObservationLog({ makeRunId });
	let turn: TurnObservation | null = null;

	const runtime: CloudMemoryRuntime = createCloudMemoryRuntime({
		homedir: homedir(),
		env: process.env,
		readText: boundedReadText,
		sendStatus: (status) => {
			sendCloudMemoryStatus(pi, status);
		},
	});

	function appendToolRecord(logFile: string, input: ToolRecordInput): void {
		observationLog.append(
			logFile,
			buildLogRecord({
				kind: "tool",
				ts: new Date().toISOString(),
				runId: makeRunId(),
				sessionId: input.sessionId,
				tool: input.tool,
				status: input.status,
				reason: input.reason,
				toolMs: input.toolMs,
				serverTiming: input.serverTiming ?? null,
				itemCount: input.itemCount ?? null,
				previewTruncatedCount: input.previewTruncatedCount ?? null,
				partial: input.partial ?? null,
				offset: input.offset ?? null,
				nextOffset: input.nextOffset ?? null,
				totalChars: input.totalChars ?? null,
				contentChars: input.contentChars ?? null,
				sourceIds: input.sourceIds ?? [],
			}),
		);
	}

	function noteToolCall(configLogFile: string, sessionId: string | null, outcome: { status: ToolResultStatus; toolMs: number; sourceIds: string[]; failed: boolean }): void {
		if (!turn) return;
		turn.logFile = configLogFile;
		turn.sessionId = turn.sessionId ?? sessionId;
		turn.toolCalls += 1;
		turn.toolMs += outcome.toolMs;
		turn.hadFailure = turn.hadFailure || outcome.failed;
		if (turn.sourceIds.length < 40) turn.sourceIds.push(...outcome.sourceIds.slice(0, 20));
	}

	/** 回合记录只在「本回合确实调用过工具」时写。 */
	function flushTurn(status: CloudMemoryRecordStatus, reason: string | null): void {
		const current = turn;
		turn = null;
		runtime.clearTurn();
		if (!current || current.toolCalls === 0 || current.logFile === null) return;
		const record = buildLogRecord({
			kind: "turn",
			ts: new Date().toISOString(),
			runId: current.runId,
			sessionId: current.sessionId,
			status,
			reason,
			toolMs: current.toolMs,
			sourceIds: current.sourceIds,
			toolCallCount: current.toolCalls,
			requestCount: current.requestCount,
			firstTextMs: current.firstTextAt === null ? null : current.firstTextAt - current.startedAt,
			turnMs: performance.now() - current.startedAt,
			personaRevision: current.personaRevision,
			usage: current.usage,
		});
		observationLog.append(current.logFile, record);
		try {
			pi.appendEntry(TIMING_ENTRY_TYPE, record);
		} catch {
			// 时间线摘要缺席不影响 pi 会话。
		}
	}

	const toolRunner = createToolRunner({
		readProfile: () => runtime.readProfile(),
		profileKeyOf: (profile) => runtime.profileKeyOf(profile),
		currentTurnProfileKey: () => turn?.profileKey ?? null,
		isTurnBlocked: () => runtime.turnBlocked(),
		emitProfileChanged: (sessionId) => {
			runtime.emitStatus({ kind: "profile", status: "changed", reason: "profile_changed_before_result", sessionId, needsNewSession: true });
		},
		appendToolRecord,
		noteToolCall,
		reportConfigOnce: (sessionId, status, reason, logFile) => {
			observationLog.reportOnce(sessionId, status, reason, logFile);
		},
		defaultLogFile: () => defaultLogFileFor({ homedir: homedir(), env: process.env }),
		makeRunId,
	});

	// -------------------------------------------------------------------------
	// 工具注册：两个 direct 工具，默认模型可见。
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: TOOL_SEARCH_MEMORY,
		label: "Search memory",
		description: SEARCH_MEMORY_DESCRIPTION,
		promptSnippet: SEARCH_MEMORY_SNIPPET,
		promptGuidelines: SEARCH_MEMORY_GUIDELINES,
		parameters: Type.Object(
			{
				query: Type.String({ description: "What to look up in the user's own cloud personal memory: their background, stated preferences, or an earlier personal decision." }),
				max_tokens: Type.Optional(Type.Integer({ minimum: MIN_MAX_TOKENS, maximum: MAX_MAX_TOKENS, description: "Estimated text budget for the returned memory text (default 500). It is separate from the item-count limit." })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SAFE_ITEMS, description: "Optional item cap, separate from the text budget (default: server decides within the safe cap of 50)." })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
			const normalized = normalizeSearchArgs(params);
			if (normalized.kind === "invalid") return toolResult(buildUnavailableText(TOOL_SEARCH_MEMORY, "error", normalized.reason), "error", normalized.reason, {});
			return toolRunner.runSearch(ctx, normalized.args, signal);
		},
	});

	pi.registerTool({
		name: TOOL_GET_MEMORY_SOURCE,
		label: "Read memory source",
		description: GET_MEMORY_SOURCE_DESCRIPTION,
		promptSnippet: GET_MEMORY_SOURCE_SNIPPET,
		promptGuidelines: GET_MEMORY_SOURCE_GUIDELINES,
		parameters: Type.Object(
			{
				memory_id: Type.Optional(Type.String({ description: "Memory id from search_memory. Provide exactly one of memory_id or source_id." })),
				source_id: Type.Optional(Type.String({ description: "Verbatim source id from search_memory results. Provide exactly one of memory_id or source_id." })),
				offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET, description: "UTF-16 character offset into this fixed source version (default 0). Offset > 0 also requires base_sha256." })),
				max_chars: Type.Optional(Type.Integer({ minimum: MIN_MAX_CHARS, maximum: MAX_MAX_CHARS, description: "Characters to read from the offset (default 8000)." })),
				record: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_RECORD_INDEX, description: "Which source to read when one memory has several sources, 0-based (default 0). Keep it unchanged while paging." })),
				base_sha256: Type.Optional(Type.String({ description: "text_sha256 of the first page; required for offset > 0 so a changed version is rejected instead of concatenated." })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
			const normalized = normalizeSourceArgs(params);
			if (normalized.kind === "invalid") return toolResult(buildUnavailableText(TOOL_GET_MEMORY_SOURCE, "error", normalized.reason), "error", normalized.reason, {});
			return toolRunner.runSource(ctx, normalized.args, signal);
		},
	});

	// -------------------------------------------------------------------------
	// 事件装配：观察 + 运行时转发 + 状态控制消息过滤
	// -------------------------------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		flushTurn("aborted", "superseded_by_new_prompt");
		const observation: TurnObservation = {
			runId: makeRunId(),
			sessionId: readSessionId(ctx),
			logFile: null,
			startedAt: performance.now(),
			firstTextAt: null,
			requestCount: 0,
			toolCalls: 0,
			toolMs: 0,
			sourceIds: [],
			hadFailure: false,
			usage: null,
			profileKey: null,
			personaRevision: null,
		};
		turn = observation;
		const started: TurnRuntime = await runtime.beginTurn(ctx, event);
		observation.sessionId = observation.sessionId ?? started.sessionId;
		observation.logFile = started.logFile;
		observation.profileKey = started.profileKey;
		observation.personaRevision = started.personaRevision;
	});

	// 只把本扩展的状态控制消息从模型请求里剔除：其它扩展的 custom 消息与记忆工具结果原样保留。
	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => !isStatusControlMessage(message));
		return messages.length === event.messages.length ? undefined : { messages };
	});

	pi.on("before_provider_request", () => {
		if (turn) turn.requestCount += 1;
	});

	pi.on("message_update", (event) => {
		if (!turn || turn.firstTextAt !== null) return;
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent?.type !== "text_delta") return;
		const delta = assistantEvent.delta;
		if (typeof delta === "string" && delta.length > 0) turn.firstTextAt = performance.now();
	});

	pi.on("message_end", (event) => {
		if (!turn) return;
		if (event.message.role !== "assistant") return;
		turn.usage = addUsage(turn.usage, event.message.usage);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		await runtime.reconcile(ctx, "turn_end");
	});

	pi.on("agent_settled", async (event, ctx: ExtensionContext) => {
		await runtime.reconcile(ctx, "settled");
		const failed = turn?.hadFailure === true;
		flushTurn(event.aborted ? "aborted" : failed ? "error" : "ok", event.aborted ? "agent_aborted" : failed ? "tool_failed" : null);
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await runtime.reconcile(ctx, "session_start");
	});

	pi.on("session_before_switch", async () => {
		await runtime.stopSender("session_switch");
		await runtime.flushCapture();
	});

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		await runtime.reconcile(ctx, "shutdown");
		await runtime.flushCapture();
	});
}
