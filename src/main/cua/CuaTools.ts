/**
 * CUA MCP tool registration — shared by the in-process HTTP host (Plan A) and
 * the legacy standalone stdio server.
 *
 * 坐标契约（C0 实测后定稿，见 `E:\A PI\cache\TPA-charts-20261017\C0-截图与坐标实测.md`）：
 * - 截图返回几何：图像像素尺寸、屏幕物理矩形、原生捕获尺寸、`frameId`、`coordinateSpace`。
 * - `cua_click` / `cua_scroll` 传 `frameId` 时，`x`/`y` 是**该帧的图像像素**，宿主换算后注入；
 *   不传 `frameId` 时保持旧的**绝对屏幕物理坐标**语义，不做任何缩放（旧调用兼容）。
 * - `cua_zoom` 从该帧的原生捕获图裁剪，不放大已缩小的交付图；子帧几何可继续用于点击。
 *
 * 结果文本里带 `tpaCua` 记录（schemaVersion/action/frame/input/target/receipt/effect），
 * 由 `src/shared/cuaDecode.ts` 解码进轨迹；截图本体单独落盘，记录只存 `screenshotRef`。
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CuaEngine } from "./CuaEngine";
import type { CuaGate } from "./CuaGate";
import type { CuaScreen } from "./CuaScreen";
import { describeFrameGeometry } from "./CuaGeometry";
import { CUA_ACTION_SCHEMA_VERSION, type CuaActionRecord, type CuaToolResultPayload } from "../../shared/types/cua";
import { asPoint, failureRecord, frameRecord, resolveInputPoint, summarizeWindows, targetRecord, textResult } from "./CuaToolSupport";

/**
 * Register the CUA tools on an McpServer instance.
 *
 * Read-only tools (cua_capture / cua_zoom / cua_list_windows / cua_get_state) do not
 * pass through the gate. Write tools (cua_click / cua_type / cua_scroll) route through
 * engine methods that check the gate (kill switch + approval).
 */
export function registerCuaTools(server: McpServer, engine: CuaEngine, gate: CuaGate, screen: CuaScreen): void {
	// -------------------------------------------------------------------------
	// cua_capture — full screen capture (read-only)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_capture",
		{
			description: "Capture one display as a JPEG and return its geometry. Coordinates for cua_click/cua_scroll/zoom are image pixels of this frame; use the returned frameId to reference it. screenRect is in physical screen pixels and may have a negative origin on multi-monitor desktops.",
			inputSchema: {
				displayId: z.string().optional().describe("Electron display id from cua_get_state/displays; omit for primary."),
				maxLongEdge: z.number().int().min(16).max(8192).default(1280).describe("Resize the delivered image so its longer edge <= this (16-8192)."),
				quality: z.number().int().min(1).max(100).default(75).describe("JPEG quality 1-100."),
				sessionId: z.string().optional().describe("PiDeck session id (attribution only; capture is read-only)."),
			},
		},
		async (args) => {
			const started = Date.now();
			const outcome = await screen.capture({
				displayId: args.displayId,
				maxLongEdge: args.maxLongEdge,
				quality: args.quality,
				sessionId: args.sessionId,
			});
			const { frame, geometry, screenshotRef } = outcome;
			const record: CuaActionRecord = {
				schemaVersion: CUA_ACTION_SCHEMA_VERSION,
				action: "capture",
				at: frame.timestampMs,
				durationMs: Date.now() - started,
				frame: frameRecord(geometry, screenshotRef),
				receipt: { sent: 0, gate: "read-only" },
				effect: "unverified",
			};
			const payload: CuaToolResultPayload = {
				// 旧字段保持：width/height/displayId 仍是交付图与显示 id。
				width: frame.width,
				height: frame.height,
				displayId: frame.displayId,
				sourceId: frame.sourceId,
				base64Length: frame.base64.length,
				timestampMs: frame.timestampMs,
				durationMs: record.durationMs,
				// 几何放顶层，模型不必先理解 tpaCua 也能直接换算。
				...describeFrameGeometry(geometry),
				...(screenshotRef ? { screenshotRef } : {}),
				tpaCua: record,
			};
			return {
				content: [
					{ type: "image" as const, data: frame.base64, mimeType: frame.mimeType },
					{ type: "text" as const, text: JSON.stringify(payload) },
				],
				isError: false,
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_zoom — crop detail from the native capture of a frame (read-only)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_zoom",
		{
			description:
				"Crop a region of a previously captured frame from its native capture (never by upscaling the downscaled JPEG). region is in image pixels of that frame. Returns a new frameId whose image pixels map back to the same screen area, so clicks can use either frame. The delivered crop may be downscaled to maxLongEdge, but sourceWidth/sourceHeight always report the native crop size, and a later cua_zoom on this frame still crops native pixels.",
			inputSchema: {
				frameId: z.string().describe("frameId returned by cua_capture or a previous cua_zoom."),
				x: z.number().describe("Region left edge in the frame's image pixels."),
				y: z.number().describe("Region top edge in the frame's image pixels."),
				width: z.number().positive().describe("Region width in image pixels."),
				height: z.number().positive().describe("Region height in image pixels."),
				maxLongEdge: z.number().int().min(32).max(4096).default(1600).describe("Cap the crop's longer edge (never upscales)."),
				quality: z.number().int().min(1).max(100).default(85).describe("JPEG quality 1-100."),
				sessionId: z.string().optional().describe("PiDeck session id (attribution only)."),
			},
		},
		async (args) => {
			const started = Date.now();
			const outcome = await screen.zoom({
				frameId: args.frameId,
				region: { x: args.x, y: args.y, width: args.width, height: args.height },
				maxLongEdge: args.maxLongEdge,
				quality: args.quality,
				sessionId: args.sessionId,
			});
			if (!outcome.ok) {
				return textResult(
					{
						error: `${outcome.reason}: ${outcome.message}`,
						tpaCua: {
							schemaVersion: CUA_ACTION_SCHEMA_VERSION,
							action: "zoom",
							at: Date.now(),
							durationMs: Date.now() - started,
							receipt: { sent: 0, gate: "read-only", error: outcome.reason },
							effect: "unverified",
						},
					},
					true,
				);
			}
			const record: CuaActionRecord = {
				schemaVersion: CUA_ACTION_SCHEMA_VERSION,
				action: "zoom",
				at: outcome.geometry.capturedAtMs,
				durationMs: Date.now() - started,
				frame: frameRecord(outcome.geometry, outcome.screenshotRef),
				receipt: { sent: 0, gate: "read-only" },
				effect: "unverified",
			};
			const base64 = outcome.data.toString("base64");
			const payload: CuaToolResultPayload = {
				width: outcome.width,
				height: outcome.height,
				displayId: outcome.geometry.displayId,
				sourceId: outcome.geometry.sourceId,
				base64Length: base64.length,
				timestampMs: outcome.geometry.capturedAtMs,
				durationMs: record.durationMs,
				parentFrameId: outcome.parentFrameId,
				...describeFrameGeometry(outcome.geometry),
				...(outcome.screenshotRef ? { screenshotRef: outcome.screenshotRef } : {}),
				tpaCua: record,
			};
			return {
				content: [
					{ type: "image" as const, data: base64, mimeType: "image/jpeg" },
					{ type: "text" as const, text: JSON.stringify(payload) },
				],
				isError: false,
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_list_windows — list visible top-level windows (read-only)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_list_windows",
		{
			description: "List visible top-level windows with Z-order and geometry (physical screen pixels).",
			inputSchema: {
				includeInvisible: z.boolean().default(false),
			},
		},
		async (args) => {
			const summary = summarizeWindows(engine.listWindows(args.includeInvisible));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(summary, null, 2),
					},
				],
			};
		},
	);

	// -------------------------------------------------------------------------
	// cua_click — click (write, gated)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_click",
		{
			description: "Click. With frameId: x/y are image pixels of that frame and are mapped to the screen. Without frameId: x/y are absolute physical screen coordinates (legacy behaviour, no scaling). Returns the injected screen point and whether the input was sent — not whether the target reacted.",
			inputSchema: {
				x: z.number().describe("Image X when frameId is given, otherwise absolute screen X (physical pixels)."),
				y: z.number().describe("Image Y when frameId is given, otherwise absolute screen Y (physical pixels)."),
				frameId: z.string().optional().describe("Frame from cua_capture/cua_zoom; makes x/y image coordinates."),
				button: z.enum(["left", "right", "middle"]).default("left"),
				double: z.boolean().default(false),
				activateTarget: z.string().optional().describe("Optional target window title substring to activate before clicking."),
				sessionId: z.string().describe("PiDeck session ID for approval gate."),
				agentId: z.string().optional().describe("PiDeck agent id (approval attribution)."),
				runtimeGeneration: z.number().int().optional().describe("Session runtime generation (approval attribution)."),
			},
		},
		async (args) => {
			const started = Date.now();
			const resolved = resolveInputPoint(screen, args.frameId, args.x, args.y);
			if (!resolved.ok) return textResult({ error: resolved.error, tpaCua: failureRecord("click", started, resolved.error) }, true);

			const meta = { agentId: args.agentId, runtimeGeneration: args.runtimeGeneration };
			// Double click routes to a dedicated engine method so the whole gesture
			// is covered by ONE approval (see CuaEngine.doubleClick).
			const result = args.double ? await engine.doubleClick(args.sessionId, resolved.screen.x, resolved.screen.y, args.button, { activateTarget: args.activateTarget, meta }) : await engine.click(args.sessionId, resolved.screen.x, resolved.screen.y, args.button, { activateTarget: args.activateTarget, meta });

			const record: CuaActionRecord = {
				schemaVersion: CUA_ACTION_SCHEMA_VERSION,
				action: "click",
				at: Date.now(),
				durationMs: Date.now() - started,
				...(resolved.frame ? { frame: frameRecord(resolved.frame.geometry, resolved.frame.screenshotRef) } : {}),
				input: {
					coordinateSpace: resolved.coordinateSpace,
					...(resolved.image ? { imagePoint: asPoint(resolved.image) } : {}),
					screenPoint: asPoint(resolved.screen),
					button: args.button,
					double: args.double,
				},
				...(targetRecord(result.target) ? { target: targetRecord(result.target) } : {}),
				receipt: { sent: result.sent, gate: result.gateDecision, error: result.error ?? null },
				effect: "unverified",
			};
			const payload: CuaToolResultPayload = {
				sent: result.sent,
				error: result.error ?? null,
				gate: result.gateDecision,
				coordinateSpace: resolved.coordinateSpace,
				screenPoint: asPoint(resolved.screen),
				...(resolved.image ? { imagePoint: asPoint(resolved.image) } : {}),
				durationMs: record.durationMs,
				tpaCua: record,
			};
			return textResult(payload, Boolean(result.error));
		},
	);

	// -------------------------------------------------------------------------
	// cua_type — keyboard input (write, gated)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_type",
		{
			description: "Type a text string or press key combinations.",
			inputSchema: {
				text: z.string().max(4000).optional().describe("Text to type (Unicode supported, max 4000 chars)."),
				key: z.string().optional().describe("Key name: enter, tab, escape, backspace, delete, space, arrows, home, end, pageup, pagedown."),
				modifiers: z
					.array(z.enum(["ctrl", "alt", "shift", "win"]))
					.optional()
					.describe("Modifiers for key combos."),
				sessionId: z.string().describe("PiDeck session ID for approval gate."),
				agentId: z.string().optional().describe("PiDeck agent id (approval attribution)."),
				runtimeGeneration: z.number().int().optional().describe("Session runtime generation (approval attribution)."),
			},
		},
		async (args) => {
			const started = Date.now();
			const result = await engine.type(
				args.sessionId,
				{
					text: args.text,
					key: args.key,
					modifiers: args.modifiers,
				},
				{ meta: { agentId: args.agentId, runtimeGeneration: args.runtimeGeneration } },
			);

			const record: CuaActionRecord = {
				schemaVersion: CUA_ACTION_SCHEMA_VERSION,
				action: "type",
				at: Date.now(),
				durationMs: Date.now() - started,
				input: {
					...(args.key ? { key: args.key } : {}),
					...(args.text ? { textLength: args.text.length } : {}),
				},
				...(targetRecord(result.target) ? { target: targetRecord(result.target) } : {}),
				receipt: { sent: result.sent, gate: result.gateDecision, error: result.error ?? null },
				effect: "unverified",
			};
			const payload: CuaToolResultPayload = {
				sent: result.sent,
				error: result.error ?? null,
				gate: result.gateDecision,
				durationMs: record.durationMs,
				tpaCua: record,
			};
			return textResult(payload, Boolean(result.error));
		},
	);

	// -------------------------------------------------------------------------
	// cua_scroll — mouse wheel scroll (write, gated)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_scroll",
		{
			description: "Scroll the mouse wheel. With frameId: x/y are image pixels of that frame. Without frameId: x/y are absolute physical screen coordinates. Windows wheel convention: positive deltaY scrolls up, negative scrolls down.",
			inputSchema: {
				x: z.number().describe("Image X when frameId is given, otherwise absolute screen X (physical pixels)."),
				y: z.number().describe("Image Y when frameId is given, otherwise absolute screen Y (physical pixels)."),
				frameId: z.string().optional().describe("Frame from cua_capture/cua_zoom; makes x/y image coordinates."),
				deltaY: z.number().int().min(-2400).max(2400).default(-120).describe("Windows wheel convention: positive=scroll up, negative=scroll down (default: one notch down)."),
				deltaX: z.number().int().min(-2400).max(2400).default(0).describe("Horizontal wheel: positive=right, negative=left."),
				sessionId: z.string().describe("PiDeck session ID for approval gate."),
				agentId: z.string().optional().describe("PiDeck agent id (approval attribution)."),
				runtimeGeneration: z.number().int().optional().describe("Session runtime generation (approval attribution)."),
			},
		},
		async (args) => {
			const started = Date.now();
			const resolved = resolveInputPoint(screen, args.frameId, args.x, args.y);
			if (!resolved.ok) return textResult({ error: resolved.error, tpaCua: failureRecord("scroll", started, resolved.error) }, true);

			const result = await engine.scroll(args.sessionId, resolved.screen.x, resolved.screen.y, args.deltaY, args.deltaX, {
				meta: { agentId: args.agentId, runtimeGeneration: args.runtimeGeneration },
			});

			const record: CuaActionRecord = {
				schemaVersion: CUA_ACTION_SCHEMA_VERSION,
				action: "scroll",
				at: Date.now(),
				durationMs: Date.now() - started,
				...(resolved.frame ? { frame: frameRecord(resolved.frame.geometry, resolved.frame.screenshotRef) } : {}),
				input: {
					coordinateSpace: resolved.coordinateSpace,
					...(resolved.image ? { imagePoint: asPoint(resolved.image) } : {}),
					screenPoint: asPoint(resolved.screen),
					deltaX: args.deltaX,
					deltaY: args.deltaY,
				},
				...(targetRecord(result.target) ? { target: targetRecord(result.target) } : {}),
				receipt: { sent: result.sent, gate: result.gateDecision, error: result.error ?? null },
				effect: "unverified",
			};
			const payload: CuaToolResultPayload = {
				sent: result.sent,
				error: result.error ?? null,
				gate: result.gateDecision,
				coordinateSpace: resolved.coordinateSpace,
				screenPoint: asPoint(resolved.screen),
				...(resolved.image ? { imagePoint: asPoint(resolved.image) } : {}),
				durationMs: record.durationMs,
				tpaCua: record,
			};
			return textResult(payload, Boolean(result.error));
		},
	);

	// -------------------------------------------------------------------------
	// cua_get_state — read CUA state (read-only)
	// -------------------------------------------------------------------------
	server.registerTool(
		"cua_get_state",
		{
			description: "Read the current CUA state: displays (physical rects + DIP bounds + scale), gate status, foreground window.",
			inputSchema: {
				sessionId: z.string().optional().describe("PiDeck session ID to check session-level gate."),
				includeDisplays: z.boolean().default(true).describe("Include the display list (physical pixels vs DIP)."),
			},
		},
		async (args) => {
			const display = engine.getDisplay();
			const fg = engine.getForegroundWindow();
			const gateEnabled = gate.isEnabled();
			const sessionEnabled = args.sessionId ? gate.isSessionEnabled(args.sessionId) : gateEnabled;

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							display,
							...(args.includeDisplays ? { displays: screen.listDisplays() } : {}),
							gateEnabled,
							sessionEnabled,
							// 免审批状态一并上报：Agent/用户可据此判断是否还会弹审批框。
							autoApprove: gate.isAutoApprove(),
							foregroundWindow: fg
								? {
										hwnd: fg.window.hwnd,
										title: fg.window.title,
										pid: fg.window.pid,
										rect: fg.window.rect,
									}
								: null,
						}),
					},
				],
			};
		},
	);
}
