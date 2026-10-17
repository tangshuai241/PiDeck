/**
 * CUA 动作记录：解码 → 历史投影 → 轨迹账本。
 *
 * 夹具用 pi 真实持久化形状（toolResult 的 content 文本；MCP 工具的 details 会被 pi
 * 覆盖成 {server, tool}，所以记录只能来自文本），并断言记录里没有 base64 图片。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { decodeCuaToolResult, isCuaToolName, normalizeCuaToolName } = loadTsCommonJs("src/shared/cuaDecode.ts");
const { buildTrajectory } = loadTsCommonJs("src/renderer/src/components/session/trajectory/buildTrajectory.ts");

const SCREENSHOT_REF = `${"a".repeat(64)}.jpg`;

const clickRecord = {
	schemaVersion: 1,
	action: "click",
	at: 1790000000123,
	durationMs: 42,
	frame: {
		frameId: "frame-1",
		displayId: "3907019210",
		sourceId: "screen:1:0",
		screenRect: { x: 0, y: 0, width: 2560, height: 1440 },
		imageWidth: 1280,
		imageHeight: 720,
		sourceWidth: 2560,
		sourceHeight: 1440,
		coordinateSpace: "image",
		rotation: 0,
		capturedAtMs: 1790000000000,
		screenshotRef: SCREENSHOT_REF,
	},
	input: { coordinateSpace: "image", imagePoint: { x: 640, y: 360 }, screenPoint: { x: 1280, y: 720 }, button: "left", double: false },
	target: { title: "TPA CUA 坐标测试页", hwnd: 1234, rect: { x: 100, y: 100, width: 900, height: 700 } },
	receipt: { sent: 3, gate: "allowed", error: null },
	effect: "unverified",
};

function toolResultMessage(record, toolName = "mcp__pideck-cua__cua_click", text = JSON.stringify({ sent: 3, error: null, gate: "allowed", tpaCua: record })) {
	return { role: "toolResult", toolCallId: "call-1", toolName, content: [{ type: "text", text }], details: { server: "pideck-cua", tool: "cua_click" }, timestamp: 1790000000200 };
}

function createProjector() {
	const { AgentMessageProjector } = loadTsCommonJs(join(process.cwd(), "src/main/pi/AgentMessageProjector.ts"), {
		stubs: {
			"./messageContent": {
				extractMessageText: (content) =>
					Array.isArray(content)
						? content
								.filter((item) => item?.type === "text")
								.map((item) => item.text ?? "")
								.join("\n")
						: typeof content === "string"
							? content
							: "",
			},
		},
	});
	return new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
}

test("tool names are matched by their last segment (pi MCP prefix differences)", () => {
	assert.strictEqual(normalizeCuaToolName("mcp__pideck-cua__cua_click"), "cua_click");
	assert.strictEqual(normalizeCuaToolName("cua_capture"), "cua_capture");
	assert.strictEqual(isCuaToolName("mcp__pideck-cua__cua_zoom"), true);
	assert.strictEqual(isCuaToolName("mcp__other__cua_click"), true);
	assert.strictEqual(isCuaToolName("bash"), false);
});

test("decodes a full CUA record from the tool text result", () => {
	const record = decodeCuaToolResult("mcp__pideck-cua__cua_click", toolResultMessage(clickRecord));
	assert.ok(record);
	assert.strictEqual(record.action, "click");
	assert.strictEqual(record.frame.frameId, "frame-1");
	assert.strictEqual(record.frame.screenshotRef, SCREENSHOT_REF);
	assert.deepStrictEqual(JSON.parse(JSON.stringify(record.input.imagePoint)), { x: 640, y: 360 });
	assert.deepStrictEqual(JSON.parse(JSON.stringify(record.input.screenPoint)), { x: 1280, y: 720 });
	assert.strictEqual(record.receipt.sent, 3);
	assert.strictEqual(record.receipt.gate, "allowed");
	assert.strictEqual(record.effect, "unverified");
	assert.strictEqual(record.target.title, "TPA CUA 坐标测试页");
});

test("rejects records it cannot trust without touching the tool text", () => {
	// 非 CUA 工具
	assert.strictEqual(decodeCuaToolResult("bash", toolResultMessage(clickRecord)), undefined);
	// 不是 JSON
	assert.strictEqual(decodeCuaToolResult("cua_click", { content: [{ type: "text", text: "sent 3 events" }] }), undefined);
	// 版本不符
	assert.strictEqual(decodeCuaToolResult("cua_click", toolResultMessage({ ...clickRecord, schemaVersion: 2 })), undefined);
	// action 非法
	assert.strictEqual(decodeCuaToolResult("cua_click", toolResultMessage({ ...clickRecord, action: "drag" })), undefined);
	// 缺 at
	assert.strictEqual(decodeCuaToolResult("cua_click", toolResultMessage({ ...clickRecord, at: undefined })), undefined);
});

test("invalid optional fields are dropped, not fatal; a bad screenshot ref is not rendered", () => {
	const record = decodeCuaToolResult("cua_capture", toolResultMessage({ ...clickRecord, action: "capture", frame: { ...clickRecord.frame, screenshotRef: "../../etc/passwd" } }, "cua_capture"));
	assert.ok(record);
	assert.strictEqual(record.frame.screenshotRef, undefined);
	assert.strictEqual(record.action, "capture");
});

test("history projection attaches the record to the tool message", () => {
	const projector = createProjector();
	const messages = projector.convert("agent-1", [toolResultMessage(clickRecord)]);
	assert.strictEqual(messages.length, 1);
	assert.strictEqual(messages[0].role, "tool");
	assert.strictEqual(messages[0].cua.action, "click");
	assert.strictEqual(messages[0].cua.frame.screenshotRef, SCREENSHOT_REF);
});

test("trajectory keeps the CUA record on the tool ledger entry", () => {
	const projector = createProjector();
	const messages = projector.convert("agent-1", [{ role: "user", content: [{ type: "text", text: "点一下按钮" }], timestamp: 1 }, toolResultMessage(clickRecord)]);
	const model = buildTrajectory(messages, 1790000001000);
	const toolRecord = model.records.find((entry) => entry.kind === "tool");
	assert.ok(toolRecord);
	assert.strictEqual(toolRecord.cua.action, "click");
	assert.strictEqual(toolRecord.cua.frame.screenshotRef, SCREENSHOT_REF);
	assert.strictEqual(toolRecord.cua.input.screenPoint.x, 1280);
	assert.strictEqual(toolRecord.cua.receipt.sent, 3);
});

test("records never carry image bytes or base64 into the trajectory", () => {
	const projector = createProjector();
	const messages = projector.convert("agent-1", [toolResultMessage(clickRecord)]);
	const model = buildTrajectory(messages, 1790000001000);
	const serialized = JSON.stringify(model);
	assert.ok(!/base64/i.test(serialized), "no base64 field in the trajectory model");
	assert.ok(!serialized.includes("data:image"), "no data URL in the trajectory model");
	assert.ok(serialized.includes(SCREENSHOT_REF), "screenshot is referenced, not embedded");
});

test("the renderer has no IPC channel that could re-execute a CUA action", () => {
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const block = preload.slice(preload.indexOf("\tcua: {"), preload.indexOf("\t}", preload.indexOf("\tcua: {")));
	assert.ok(block.length > 0, "preload CUA block found");
	// 回看只能读审批状态；不存在能触发 cua_capture/click/scroll/type 的调用。
	assert.ok(!/cua_capture|cua_click|cua_scroll|cua_type|cua_zoom/.test(block), "no tool-execution channel in preload");
	assert.ok(/getState|onApprovalRequest|sendApprovalResponse/.test(block));
});
