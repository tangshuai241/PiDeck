/**
 * 首次建档的标题边界（真实验收缺陷回归）：正式 brief 的 goal 很长时，建档仍必须走得通。
 *
 * 缺陷背景（真实验收）：会话 4aad9111 的 ready brief goal 有 219 字（原生 schema 允许 4000 字）。
 * 卡片正常出现、提示「为本次文稿选择保存位置」，用户点「选择保存目录」后却弹出
 * 「请求参数不合法，已拒绝执行。」——因为首次建档把整段 goal 原样当作显示标题，
 * 而公开 IPC `documentWorkCreate` 的标题上界是 120 字（title_too_long），工作记录根本没建出来。
 * 用户不该为了让系统能建档，反过来要求模型把一份合法、完整的需求摘要写短。
 *
 * 这个测试刻意不测「派生函数返回了什么字符串」，而是把渲染层 hook 直接接到生产 IPC handler 上：
 * 同一条链路上验证「来源侧编码出的标题」能过「公开 IPC 契约」，并且 brief 原文与用户轮身份不变。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { alignmentSnapshot, createDocumentWorkHarness, runtimeSnapshot, userMessage } from "./helpers/documentWorkHookHarness.mjs";

/** 真实验收里那条正式需求摘要的同等形态：219 字，原生 schema 允许到 4000。 */
const LIVE_GOAL =
	"桥梁监测安排 正式 Word 报告（DOCX）交付：全文只含四段。一级标题“一、项目背景”；正文逐字“桥梁监测样例，长度 120 米。此为合成材料，不含真实项目数据。”；一级标题“二、实施安排”；正文逐字“先布设传感器，再进行每日检查。”。标题用 Word Heading 1，正文宋体 12 磅，不加额外标题、段落、表格、图片、页眉页脚，成品名桥梁监测安排.docx，无需外部材料，输出目录由用户在卡片上选定，不另行搜索外部材料与模板。";
const LIVE_USER_TEXT = "请制作《桥梁监测安排》正式 Word 报告（DOCX）。所有材料均在本条消息内，无外部材料，不用搜索目录。成品文件名为桥梁监测安排.docx。没有待决定项，请先整理确认单，等待我点击确认后再制作文件。";
const LIVE_BRIEF = { goal: LIVE_GOAL, scope: [], materials: [], deliverable: "Word 文档（DOCX）", preserve: [], acceptance: ["四个段落逐字一致"], questions: [] };
/** 公开 IPC 契约：title 最长 120；共享 sanitizeWorkTitle 策略截到 80。 */
const IPC_TITLE_LIMIT = 120;

/** 生产 IPC 边界：electron 桩捕获 handler 表，假服务记录真正被接受的 createWork 入参。 */
function createIpcBoundary() {
	const handlers = new Map();
	const accepted = [];
	const load = createTsSandbox({
		stubs: {
			electron: {
				ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
				dialog: { showOpenDialog: async () => ({ filePaths: [] }) },
			},
		},
	});
	const { registerDocumentWorkIpc } = load("src/main/ipc/documentWorkIpc.ts");
	const { ipcChannels } = load("src/shared/ipc.ts");
	const { sanitizeWorkTitle } = load("src/shared/documentWork.ts");
	registerDocumentWorkIpc({
		service: {
			createWork: async (input) => {
				accepted.push(input);
				// 主进程行为：标题按共享策略归一后再落记录（这里照实模拟，便于断言最终显示标题）。
				return { ok: true, value: { workId: "dw_live", sessionId: input.sessionId, revision: 1, title: sanitizeWorkTitle(input.title, "文稿工作"), outputRootLabel: "文稿", requirementsSummary: "", active: null, versions: [], revisionReady: false } };
			},
			getView: async () => ({ ok: true, value: null }),
			listForSession: async () => [],
			prepare: async () => ({ ok: true, value: null }),
			start: async () => ({ ok: true, value: null }),
			cancel: async () => ({ ok: true, value: null }),
			getOperation: async () => ({ ok: true, value: null }),
		},
		getWindow: () => null,
		registerChatMaterials: async () => [],
		registerOutputRoot: async (realPath) => ({ outputRootId: "or_1", label: "文稿", path: realPath, addedAt: 1 }),
	});
	return { accepted, sanitizeWorkTitle, invoke: async (payload) => handlers.get(ipcChannels.documentWorkCreate)({}, payload) };
}

/** 真实链路：hook 挂载（空状态）→ Pi 状态与用户轮到达 → 卡片出现 → 选择目录 → 建档。 */
async function mountAndCreate(harness) {
	harness.render();
	assert.equal(harness.controls.needsOutputRoot, false, "状态未到达时不该出现待建卡");
	return harness;
}

test("正式 brief 的 219 字 goal：卡片出现后选目录，生产 IPC 边界接受且只建一次记录", async () => {
	const boundary = createIpcBoundary();
	const harness = createDocumentWorkHarness({ createImpl: (input) => boundary.invoke(input) });
	try {
		// 夹具对齐真实验收的 brief 规模：goal 219 字（原生 schema 上限 4000），远大于 IPC 标题上界 120。
		assert.equal(LIVE_GOAL.length, 219);
		await mountAndCreate(harness);

		const alignment = alignmentSnapshot({ revision: 3, briefRevision: 3, brief: LIVE_BRIEF });
		const runtime = runtimeSnapshot(alignment);
		harness.setMessages([userMessage(LIVE_USER_TEXT, "turn-live-1")]);
		harness.setRuntime(runtime);
		await harness.flush();
		harness.render();

		// 卡片出现：正是真实验收里点「选择保存目录」的那一刻。
		assert.equal(harness.controls.needsOutputRoot, true);
		assert.equal(boundary.accepted.length, 0, "卡片出现本身不该建档");

		const created = await harness.controls.createForSession();
		await harness.flush();
		harness.render();

		// 边界接受：这是缺陷的正面反例（修复前这里是 INVALID_INPUT/title_too_long，accepted 为空）。
		assert.equal(boundary.accepted.length, 1, "选定目录后必须恰好建成一条记录");
		assert.equal(harness.calls.create.length, 1, "渲染层只发起一次建档调用");
		const input = boundary.accepted[0];
		assert.equal(input.sourceTurnId, "turn-live-1", "建档必须绑定发起这一轮的用户轮身份");
		assert.ok(typeof input.title === "string" && input.title.length > 0, "正式 brief 应当派生出显示标题");
		assert.ok(input.title.length <= IPC_TITLE_LIMIT, `标题必须满足公开 IPC 上界，实际 ${input.title.length}`);
		// 来源侧编码与公开契约一致：显示标题就是共享策略的结果，而不是整段 goal 的切片。
		assert.equal(input.title, boundary.sanitizeWorkTitle(LIVE_GOAL, ""));
		assert.equal(input.title.length, 80, "共享策略截断到 80 字");
		assert.ok(LIVE_GOAL.startsWith(input.title), "显示标题必须是需求摘要的前缀，不得改写、重排或另起内容");
		// 原文与身份不变：brief 仍是完整 219 字，create 入参里没有承载需求正文的字段。
		assert.equal(runtime.state.alignment.brief.goal, LIVE_GOAL);
		assert.equal(runtime.state.alignment.brief.goal.length, 219);
		assert.deepEqual(Object.keys(input).sort(), ["outputRootId", "requestId", "sessionId", "sourceTurnId", "title"].sort());
		// 建档成功后的界面状态：卡片收起、显示归一后的标题。
		assert.ok(created);
		assert.equal(harness.controls.needsOutputRoot, false);
		assert.equal(harness.controls.view?.title, input.title);
	} finally {
		harness.unmount();
	}
});

test("恶意超长原始标题仍在 IPC 被拒，边界没有被放宽", async () => {
	const boundary = createIpcBoundary();
	const base = { requestId: "req-1", sessionId: "s1", sourceTurnId: "turn-live-1", outputRootId: "or_1" };
	const rejected = await boundary.invoke({ ...base, title: LIVE_GOAL });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.error.code, "INVALID_INPUT");
	assert.equal(boundary.accepted.length, 0, "被拒的入参不得进入服务层");
	// 上界本身没变：120 字接受，121 字拒绝。
	assert.equal((await boundary.invoke({ ...base, title: "桥".repeat(IPC_TITLE_LIMIT) })).ok, true);
	assert.equal((await boundary.invoke({ ...base, title: "桥".repeat(IPC_TITLE_LIMIT + 1) })).ok, false);
});

test("短标题与无 brief 的正式要求：标题形态不变，仍能建档", async () => {
	const boundary = createIpcBoundary();
	// 短 goal：显示标题应当是原文，不被归一改写成别的内容。
	const shortHarness = createDocumentWorkHarness({ createImpl: (input) => boundary.invoke(input) });
	try {
		shortHarness.setMessages([userMessage(LIVE_USER_TEXT, "turn-short")]);
		shortHarness.setRuntime(runtimeSnapshot(alignmentSnapshot({ revision: 1, brief: { ...LIVE_BRIEF, goal: "季度监测报告" } })));
		await shortHarness.flush();
		shortHarness.render();
		assert.equal(shortHarness.controls.needsOutputRoot, true);
		assert.ok(await shortHarness.controls.createForSession());
		assert.equal(boundary.accepted[0].title, "季度监测报告");
		assert.equal(boundary.accepted[0].sourceTurnId, "turn-short");
	} finally {
		shortHarness.unmount();
	}

	// 还没有 brief（只有用户正式要求）：不带 title 建档，标题回退由主进程决定。
	const bareHarness = createDocumentWorkHarness({ createImpl: (input) => boundary.invoke(input) });
	try {
		bareHarness.setMessages([userMessage(LIVE_USER_TEXT, "turn-bare")]);
		bareHarness.setRuntime(runtimeSnapshot(alignmentSnapshot({ revision: 1, brief: null })));
		await bareHarness.flush();
		bareHarness.render();
		assert.equal(bareHarness.controls.needsOutputRoot, true);
		assert.ok(await bareHarness.controls.createForSession());
		assert.equal(boundary.accepted.length, 2);
		assert.equal("title" in boundary.accepted[1], false, "没有 brief 时不编造标题");
	} finally {
		bareHarness.unmount();
	}
});

test("编码轮与空模式：不出现卡片、不建档（普通会话行为不变）", async () => {
	const boundary = createIpcBoundary();
	for (const scenario of [
		{ name: "编码轮", userText: "重构 Word 报告生成接口，把 docx 管线的类型拆开", alignment: alignmentSnapshot({ revision: 1, brief: { ...LIVE_BRIEF, goal: "重构 docx 管线类型" } }) },
		{ name: "空模式", userText: LIVE_USER_TEXT, alignment: alignmentSnapshot({ revision: 0, brief: null }) },
	]) {
		const harness = createDocumentWorkHarness({ createImpl: (input) => boundary.invoke(input) });
		try {
			harness.setMessages([userMessage(scenario.userText, `turn-${scenario.name}`)]);
			harness.setRuntime(runtimeSnapshot(scenario.alignment));
			await harness.flush();
			harness.render();
			assert.equal(harness.controls.needsOutputRoot, false, `${scenario.name} 不该出现待建卡`);
			assert.equal(await harness.controls.createForSession(), null, `${scenario.name} 不该建档`);
			assert.equal(harness.calls.create.length, 0);
		} finally {
			harness.unmount();
		}
	}
	assert.equal(boundary.accepted.length, 0);
});

test("标题编码走完整共享策略：换行与文件名非法字符归一后仍过边界", async () => {
	const boundary = createIpcBoundary();
	const messyGoal = `桥梁监测安排 正式 Word 报告\n\t交付：正文宋体 12 磅 <>:"/\|?* 不加页眉页脚，${"补足交付细节，".repeat(24)}共四段。`;
	const harness = createDocumentWorkHarness({ createImpl: (input) => boundary.invoke(input) });
	try {
		harness.setMessages([userMessage(LIVE_USER_TEXT, "turn-messy")]);
		harness.setRuntime(runtimeSnapshot(alignmentSnapshot({ revision: 2, brief: { ...LIVE_BRIEF, goal: messyGoal } })));
		await harness.flush();
		harness.render();
		assert.equal(harness.controls.needsOutputRoot, true);
		assert.ok(await harness.controls.createForSession());
		const input = boundary.accepted[0];
		// 归一同时清掉换行/制表、文件名非法字符，并截断；结果必须仍是同一段需求摘要的前缀。
		assert.equal(input.title, boundary.sanitizeWorkTitle(messyGoal, ""));
		assert.ok(messyGoal.length > IPC_TITLE_LIMIT, "夹具本身要长到足以触发截断");
		assert.ok(input.title.length <= IPC_TITLE_LIMIT && input.title.length <= 80);
		assert.equal(/[\r\n\t<>:"/\|?*]/.test(input.title), false, "展示标题不得带换行或文件名非法字符");
	} finally {
		harness.unmount();
	}

	// 只剩非法字符的 goal：归一后没有可展示文本，宁可不带标题建档，也不塞脏值过边界。
	const dirtyHarness = createDocumentWorkHarness({ createImpl: (input) => boundary.invoke(input) });
	try {
		dirtyHarness.setMessages([userMessage(LIVE_USER_TEXT, "turn-dirty")]);
		dirtyHarness.setRuntime(runtimeSnapshot(alignmentSnapshot({ revision: 2, brief: { ...LIVE_BRIEF, goal: '<>:"/\|?*\t\n" ' } })));
		await dirtyHarness.flush();
		dirtyHarness.render();
		assert.equal(dirtyHarness.controls.needsOutputRoot, true);
		assert.ok(await dirtyHarness.controls.createForSession());
		assert.equal(boundary.accepted.length, 2);
		assert.equal("title" in boundary.accepted[1], false);
	} finally {
		dirtyHarness.unmount();
	}
});
