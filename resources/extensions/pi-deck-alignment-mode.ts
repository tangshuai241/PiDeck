/**
 * Requirements alignment over standard pi RPC; no GUI bridge or widget dependency.
 *
 * 首版曾把整个对齐阶段设为"只读"并禁用全部 bash；2026-10 的方案 §8 取消了这道
 * 额外禁令：模型需要 anydoc 之类的命令去读懂 Word/PDF 材料，而"任何字符串都不像
 * 写操作"这种正则保证本身也不成立。现在**沿用用户原有的 Pi 权限控制**，只额外
 * 挡住内建写工具、未知 MCP 与编排工具，并且不再宣称沙箱或绝对只读：
 * 对齐阶段的写入约束是流程约束，不是操作系统隔离。
 *
 * Snapshots are branch-scoped. briefId carries its session identity so a fork or
 * imported public message cannot silently inherit another session's approval.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ALIGNMENT_MARKER, ALIGNMENT_SNAPSHOT_TYPE, ALIGNMENT_STATE_TYPE, briefIsReady, decodeAlignment, decodeBrief, decodeTools, isRecord, type AlignmentState } from "./pi-deck-alignment-state";
import { documentWorkApprovalRefusal } from "./pi-deck-document-work-binding";

/**
 * 对齐阶段允许的工具集合。
 *
 * `bash` 在 2026-10 方案里被明确放开（材料读取需要转换命令），它按用户既有 Pi 权限
 * 执行；仍然拦住的 write/edit 是内建写工具，以及未知 MCP/编排工具——这是受控入口的
 * 流程约束，不代表操作系统级隔离。
 */
const ALIGNMENT_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "alignment_brief"]);
const CONTEXT_TYPE = "pi-deck-alignment-context";
const EXECUTE_TYPE = "pi-deck-alignment-execute";
const text = () => Type.String({ maxLength: 4000 });
const list = () => Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 40 });
const BRIEF_PARAMS = Type.Object({ goal: text(), scope: list(), materials: list(), deliverable: text(), preserve: list(), acceptance: list(), questions: list() }, { additionalProperties: false });

export default function piDeckAlignmentModeExtension(pi: ExtensionAPI): void {
	let state: AlignmentState | undefined;
	let sessionId: string | undefined;
	let toolsBeforeAlignment: string[] | undefined;
	let executing = false;
	let executionStarted = false;
	let busy = false;
	/** Session provenance fits the host's ASCII 80-character ID contract without exposing a path. */
	function sessionPrefix(id: string): string {
		return `${createHash("sha256").update(id).digest("hex").slice(0, 24)}_`;
	}

	function readOnly(): boolean {
		return state?.phase === "clarifying" || state?.phase === "ready";
	}

	/** Restore exactly the captured loadout, including a deliberately empty one. */
	function restoreTools(): void {
		if (toolsBeforeAlignment !== undefined) pi.setActiveTools(toolsBeforeAlignment);
		toolsBeforeAlignment = undefined;
	}

	function restrictTools(): void {
		if (toolsBeforeAlignment === undefined) toolsBeforeAlignment = [...pi.getActiveTools()];
		pi.setActiveTools([...new Set([...toolsBeforeAlignment.filter((name) => ALIGNMENT_ALLOWED_TOOLS.has(name)), "alignment_brief"])]);
	}

	/** Private snapshot is synchronous authority; public messages can be deferred by pi until turn end. */
	function publish(): void {
		if (!state) return;
		const alignment = decodeAlignment(state);
		if (!alignment) throw new Error("Invalid alignment transition");
		pi.appendEntry(ALIGNMENT_SNAPSHOT_TYPE, { sessionId, alignment, toolsBeforeAlignment });
		pi.sendMessage({ customType: ALIGNMENT_STATE_TYPE, content: "", display: false, details: { alignment } }, { triggerTurn: false });
	}

	/** A failed persistence write cannot leave a newer in-memory brief eligible for approval. */
	function transition(next: AlignmentState): void {
		const previous = state;
		state = next;
		try {
			publish();
		} catch (error) {
			state = previous;
			throw error;
		}
	}

	function freshState(ctx: ExtensionContext): AlignmentState {
		return { schemaVersion: 1, briefId: `${sessionPrefix(ctx.sessionManager.getSessionId())}${randomUUID()}`, revision: 0, phase: "clarifying" };
	}

	/** Restore only this branch; approved work always needs a new explicit confirmation after reopen. */
	function restoreSession(ctx: ExtensionContext): void {
		restoreTools();
		state = undefined;
		executing = false;
		executionStarted = false;
		busy = false;
		sessionId = ctx.sessionManager.getSessionId();
		let lastPrivate: Record<string, unknown> | undefined;
		let hasPrivate = false;
		let foreignPrivate = false;
		let lastPublic: unknown;
		let hasPublic = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ALIGNMENT_SNAPSHOT_TYPE) {
				hasPrivate = true;
				foreignPrivate = isRecord(entry.data) && typeof entry.data.sessionId === "string" && entry.data.sessionId !== sessionId;
				// Foreign private snapshots identify a fork/import, and must not be inherited.
				lastPrivate = isRecord(entry.data) && entry.data.sessionId === sessionId ? entry.data : undefined;
			}
			if (entry.type === "custom_message" && entry.customType === ALIGNMENT_STATE_TYPE) {
				hasPublic = true;
				lastPublic = isRecord(entry.details) ? entry.details.alignment : undefined;
			}
		}
		const data = hasPrivate ? lastPrivate?.alignment : lastPublic;
		state = decodeAlignment(data);
		if (state && !state.briefId.startsWith(sessionPrefix(sessionId))) state = undefined;
		const foreignPublic = isRecord(lastPublic) && typeof lastPublic.briefId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(lastPublic.briefId) && !lastPublic.briefId.startsWith(sessionPrefix(sessionId));
		// Invalid own latest data cannot revive older ready/approved authority.
		if (!state && !foreignPrivate && (hasPrivate || (hasPublic && !foreignPublic))) {
			state = freshState(ctx);
			toolsBeforeAlignment = [];
		}
		const restoredApproved = state?.phase === "approved";
		if (restoredApproved && state) state = { ...state, phase: "clarifying", revision: state.revision + 1 };
		if (readOnly()) {
			toolsBeforeAlignment ??= lastPrivate ? (decodeTools(lastPrivate.toolsBeforeAlignment) ?? (restoredApproved ? [...pi.getActiveTools()] : [])) : [...pi.getActiveTools()];
			restrictTools();
		}
		if (state) publish();
	}

	function ensureSession(ctx: ExtensionContext): void {
		if (sessionId !== ctx.sessionManager.getSessionId()) restoreSession(ctx);
	}

	/** New user information invalidates the previous exact revision, preserving its source constraints. */
	function clarify(ctx: ExtensionContext): void {
		ensureSession(ctx);
		if (!state || state.phase === "cancelled" || state.phase === "complete") state = freshState(ctx);
		else state = { ...state, phase: "clarifying", briefRevision: state.brief ? (state.briefRevision ?? state.revision) : undefined, revision: state.revision + 1, lastStopReason: undefined };
		executing = false;
		executionStarted = false;
		restrictTools();
		publish();
	}

	function cancel(clear = false): void {
		if (!state) return;
		// A cancelled state must be durable before the write loadout is restored.
		transition({ ...state, phase: "cancelled", revision: state.revision + 1, ...(clear ? { brief: undefined, briefRevision: undefined } : {}) });
		executing = false;
		executionStarted = false;
		restoreTools();
	}

	pi.registerTool({
		name: "alignment_brief",
		label: "Requirements alignment brief",
		description: "Publish the complete requirements brief using only inspected material and user statements. Supply every field; questions lists only missing information. This tool cannot approve or execute work.",
		parameters: BRIEF_PARAMS,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ensureSession(ctx);
			if (!readOnly() || !state) throw new Error("Alignment mode is not clarifying or ready");
			const brief = decodeBrief(params);
			if (!brief) throw new Error("Brief must contain all bounded fields and no extra fields (maximum 48000 text characters)");
			transition({ ...state, revision: state.revision + 1, briefRevision: state.revision + 1, brief, lastStopReason: undefined, phase: briefIsReady(brief) ? "ready" : "clarifying" });
			return { content: [{ type: "text", text: `${state.phase}; briefId=${state.briefId}; revision=${state.revision}. Wait for explicit user approval; do not execute.` }], details: { alignment: decodeAlignment(state) } };
		},
	});

	pi.registerCommand("align", {
		description: "Requirements alignment: on | off | clear | approve <briefId> <revision> | revise <briefId> <revision>",
		handler: async (args, ctx) => {
			ensureSession(ctx);
			const [action, id, revision, ...extra] = args.trim().split(/\s+/);
			if (action === "off" || action === "clear" || action === "cancel") {
				// Restoring tools mid-round could let an already-planning model write without approval.
				if (busy || !ctx.isIdle() || ctx.hasPendingMessages()) {
					ctx.ui.notify("Stop or finish the current response and clear queued input before leaving alignment.", "warning");
					return;
				}
				cancel(action === "clear");
				return;
			}
			if (action === "on" && !id) {
				if (!readOnly()) clarify(ctx);
				else {
					restrictTools();
					publish();
				}
				return;
			}
			if ((action !== "approve" && action !== "revise") || extra.length || !revision || !/^(0|[1-9]\d*)$/.test(revision) || !state || id !== state.briefId || Number(revision) !== state.revision || (state.phase !== "ready" && !(action === "revise" && state.phase === "clarifying"))) {
				ctx.ui.notify("Alignment command rejected: use on/off, or the exact ready briefId and revision.", "warning");
				return;
			}
			if (action === "revise") {
				clarify(ctx);
				return;
			}
			if (busy || !ctx.isIdle() || ctx.hasPendingMessages() || state.lastStopReason || (state.briefRevision !== undefined && state.briefRevision !== state.revision) || !state.brief || !briefIsReady(state.brief)) {
				ctx.ui.notify("Approval rejected: runtime must be idle with no queued input and no unanswered questions.", "warning");
				return;
			}
			// Persist before restoring tools; a failed approval write must keep the runtime restricted.
			const refusal = documentWorkApprovalRefusal(id, Number(revision));
			if (refusal) {
				ctx.ui.notify(refusal, "warning");
				return;
			}
			transition({ ...state, phase: "approved" });
			executing = true;
			executionStarted = false;
			restoreTools();
			pi.sendMessage({ customType: EXECUTE_TYPE, content: `Execute only this explicitly confirmed requirements brief under the EXISTING permissions. Preserve its constraints; do not expand scope.\n${JSON.stringify(state.brief)}`, display: false, details: { briefId: state.briefId, revision: state.revision } }, { triggerTurn: true });
		},
	});

	pi.on("input", async (event, ctx) => {
		ensureSession(ctx);
		const marked = event.text.startsWith(ALIGNMENT_MARKER);
		if (marked || ((event.source === "interactive" || event.source === "rpc") && (readOnly() || state?.phase === "approved"))) clarify(ctx);
		// A single line separator belongs to the hidden envelope; preserve all visible whitespace otherwise.
		if (marked) return { action: "transform", text: event.text.slice(ALIGNMENT_MARKER.length).replace(/^\r?\n/, ""), images: event.images };
	});

	pi.on("tool_call", async (event, ctx) => {
		ensureSession(ctx);
		if (readOnly() && !ALIGNMENT_ALLOWED_TOOLS.has(event.toolName)) return { block: true, reason: "Requirements alignment keeps the guided flow read-only: write and edit tools, orchestration and unknown MCP tools are blocked until explicit approval. Bash follows your existing pi permissions; this is a workflow constraint, not a sandbox." };
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		ensureSession(ctx);
		if (!readOnly()) return;
		restrictTools();
		return { message: { customType: CONTEXT_TYPE, display: false, content: `Requirements alignment only: inspect with read/grep/find/ls and reason; no writes, edits, execution, orchestration tools or approval. Shell commands run under your existing pi permissions, so use them for reading materials (for example converting a Word or PDF material with the anydoc tool) and keep them side-effect free. Read the actual supplied materials before discussing their contents. Never claim a path was read unless a successful read occurred; if a conversion fails, report that limitation honestly instead of quoting file contents you did not read. Preserve all original user constraints and facts; invent nothing. Ask only for missing information, using normal conversation. Update every brief field with the latest user answers and changes; an explicit new format or scope replaces the superseded one. Remove answered questions and retain only genuinely missing decisions. Ask only material blocking questions; do not re-ask choices the user already made or delegated. Publish the updated complete fields via alignment_brief. The user confirms through the desktop confirmation button; never ask them to type /align commands. Do not duplicate the full brief in conversation: the desktop confirmation sheet displays it. Even ready means wait for the exact approval control; model prose is never approval.\nCurrent brief: ${JSON.stringify(state?.brief ?? null)}` } };
	});
	pi.on("context", async (event) => {
		// Keep the current injected instructions through tool follow-ups; remove obsolete modes and executions.
		let latestContext = -1;
		for (let index = 0; index < event.messages.length; index++) {
			const message: unknown = event.messages[index];
			if (isRecord(message) && message.customType === CONTEXT_TYPE) latestContext = index;
		}
		function keepMessage(message: unknown, index: number): boolean {
			if (!isRecord(message)) return true;
			if (message.customType === ALIGNMENT_STATE_TYPE) return false;
			if (message.customType === CONTEXT_TYPE) return readOnly() && index === latestContext;
			if (message.customType === EXECUTE_TYPE) return executing && isRecord(message.details) && message.details.briefId === state?.briefId && message.details.revision === state?.revision;
			return true;
		}
		return { messages: event.messages.filter(keepMessage) };
	});
	pi.on("agent_start", async () => {
		busy = true;
		if (executing) executionStarted = true;
	});
	pi.on("agent_end", async (event, ctx) => {
		ensureSession(ctx);
		busy = false;
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (!executing || !executionStarted || state?.phase !== "approved") {
			// A partial model answer must not leave a ready draft presented as successfully completed.
			if (readOnly() && state && last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) {
				transition({ ...state, phase: "clarifying", revision: state.revision + 1, lastStopReason: last.stopReason });
			}
			return;
		}
		// Interrupted or failed executions need fresh user confirmation, and must never auto-run on restore.
		if (last?.role === "assistant" && (last.stopReason === "aborted" || last.stopReason === "error")) {
			clarify(ctx);
			return;
		}
		state = { ...state, phase: "complete" };
		executing = false;
		executionStarted = false;
		restoreTools();
		publish();
	});
	pi.on("session_start", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSession(ctx));
	pi.on("session_shutdown", async () => {
		restoreTools();
		executing = false;
		executionStarted = false;
		busy = false;
		state = undefined;
		sessionId = undefined;
	});
}
