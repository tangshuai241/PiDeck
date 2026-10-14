/**
 * 个人工作台 P01 导航：打开/返回/收起的状态流转、会话身份变化守卫、侧栏分组折叠态与功能页目录契约。
 *
 * 全部从公开行为断言：加载真实生产模块（hook + atoms + 目录），只把 React 与 jotai 的
 * 挂载层替换成可以「手动重渲染」的替身，因此测的是「点了之后状态与副作用是什么」，
 * 不是源码长什么样（不写源码字符串扫描断言）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const HOOK_PATH = "src/renderer/src/hooks/usePersonalWorkbench.ts";
const ATOMS_PATH = "src/renderer/src/atoms/personal-workbench-atoms.ts";
const NAV_PATH = "src/renderer/src/utils/personalWorkbenchNav.ts";
const PAGES_PATH = "src/renderer/src/components/personal-workbench/personalWorkbenchPages.ts";

/**
 * React 替身：hook 槽位按「组件实例 + 调用序号」复用，模拟「同一个挂载点的多次渲染」。
 * useEffect 立即执行（守卫/水合逻辑都靠 ref 自己保证只生效一次）；
 * useRef 的槽位跨渲染保留，否则守卫的「上一帧身份」永远读不到。
 * 槽位按组件名隔离：侧栏分组、覆盖层、独立导航 hook 是三个实例，ref 不能串台。
 */
function createReactStub() {
	const slotsByComponent = new Map();
	let currentSlots = [];
	let index = 0;
	return {
		beginRender(component) {
			if (!slotsByComponent.has(component)) slotsByComponent.set(component, []);
			currentSlots = slotsByComponent.get(component);
			index = 0;
		},
		stub: {
			useRef: (initial) => {
				const slot = currentSlots[index] ?? { current: initial };
				currentSlots[index] = slot;
				index += 1;
				return slot;
			},
			useCallback: (fn) => {
				index += 1;
				return fn;
			},
			useState: (initial) => {
				const slot = currentSlots[index] ?? { current: initial };
				currentSlots[index] = slot;
				index += 1;
				return [slot.current, (next) => (slot.current = next)];
			},
			useEffect: (fn) => {
				index += 1;
				fn();
			},
		},
	};
}

/** vm 沙箱里造的对象与宿主不是同一个 realm，断言结构前先过 JSON 往返把它们带回宿主。 */
function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorage(initial = {}) {
	const saved = new Map(Object.entries(initial));
	return {
		getItem: (key) => (saved.has(key) ? saved.get(key) : null),
		setItem: (key, value) => saved.set(key, value),
	};
}

/** 一个 harness = 一个组件实例（导航 hook 或分组 hook 二选一）。 */
function createHarness() {
	const store = createStore();
	const openCalls = [];
	const react = createReactStub();
	const load = createTsSandbox({
		stubs: {
			jotai: {
				atom,
				useAtom: (target) => {
					const value = store.get(target);
					return [value, (update) => store.set(target, typeof update === "function" ? update(store.get(target)) : update)];
				},
				useSetAtom: (target) => (update) => store.set(target, typeof update === "function" ? update(store.get(target)) : update),
			},
			react: react.stub,
		},
	});
	const atoms = load(ATOMS_PATH);
	const nav = load(NAV_PATH);
	const { usePersonalWorkbenchNavigation, usePersonalWorkbenchScopeGuard, usePersonalWorkbenchSection } = load(HOOK_PATH);

	const render = (component, fn) => {
		react.beginRender(component);
		return fn();
	};

	return {
		store,
		atoms,
		openCalls,
		/** 渲染一次「会话区覆盖层」：守卫 + 导航 hook 按同一实例顺序调用。 */
		renderOverlay: (scope, openSession) =>
			render("overlay", () => {
				usePersonalWorkbenchScopeGuard(scope);
				return usePersonalWorkbenchNavigation({ openSession: openSession ?? ((projectId, sessionId) => openCalls.push([projectId, sessionId])) });
			}),
		/** 只渲染导航 hook（不带身份守卫，对应侧栏入口那个实例）：用于单独验证返回决策。 */
		renderNav: (openSession) => render("nav", () => usePersonalWorkbenchNavigation({ openSession: openSession ?? ((projectId, sessionId) => openCalls.push([projectId, sessionId])) })),
		renderSection: (options) => render("section", () => usePersonalWorkbenchSection(options)),
		pageId: () => store.get(atoms.personalWorkbenchPageAtom),
		returnTarget: () => store.get(atoms.personalWorkbenchReturnTargetAtom),
		sectionCollapsed: () => store.get(atoms.personalWorkbenchSectionCollapsedAtom),
	};
}

const SCOPE_A = { projectId: "p1", sessionId: "s1" };

test("打开功能页：记下打开时的会话身份作为返回目标", () => {
	const h = createHarness();
	const nav = h.renderNav();
	nav.openPage("reading", SCOPE_A);
	assert.equal(h.pageId(), "reading");
	assert.deepEqual(plain(h.returnTarget()), SCOPE_A);

	// 打开时没有当前会话（空态/引导页）：不记录目标，返回时退化为直接收起
	h.renderNav().closePage();
	h.renderNav().openPage("todo", {});
	assert.equal(h.pageId(), "todo");
	assert.equal(h.returnTarget(), null);
});

test("返回原会话：当前会话已变时重新打开目标会话一次", () => {
	const h = createHarness();
	h.renderNav().openPage("reading", SCOPE_A);
	h.renderNav().returnToSession({ projectId: "p2", sessionId: "s2" });
	assert.deepEqual(h.openCalls, [["p1", "s1"]]);
	assert.equal(h.pageId(), null);
	assert.equal(h.returnTarget(), null);
});

test("返回原会话：会话未变时只收起覆盖层，不重复打开会话", () => {
	const h = createHarness();
	h.renderNav().openPage("todo", SCOPE_A);
	h.renderNav().returnToSession(SCOPE_A);
	assert.deepEqual(h.openCalls, []);
	assert.equal(h.pageId(), null);
});

test("点侧栏入口：已打开的那个返回聊天，另一个切页且返回目标不变", () => {
	const h = createHarness();
	h.renderNav().openPage("reading", SCOPE_A);
	h.renderNav().selectEntry("todo", SCOPE_A);
	assert.equal(h.pageId(), "todo");
	assert.deepEqual(plain(h.returnTarget()), SCOPE_A, "切页不该改动返回目标：用户返回的仍是打开功能页时的会话");

	h.renderNav().selectEntry("todo", SCOPE_A);
	assert.equal(h.pageId(), null, "再点当前入口应返回聊天");
	assert.equal(h.returnTarget(), null);
	assert.deepEqual(h.openCalls, [], "会话未变时不重复打开会话");
});

test("点当前入口返回聊天：期间会话已变时先恢复打开时的会话", () => {
	const h = createHarness();
	h.renderNav().openPage("todo", SCOPE_A);
	h.renderNav().selectEntry("todo", { projectId: "p2", sessionId: "s2" });
	assert.equal(h.pageId(), null);
	assert.deepEqual(h.openCalls, [["p1", "s1"]], "侧栏入口与页面返回键必须走同一条返回路径");
});

test("会话身份变化收起功能页；首次挂载只记录身份", () => {
	const h = createHarness();
	h.renderOverlay(SCOPE_A);
	h.renderNav().openPage("todo", SCOPE_A);

	// 同一会话重渲染：不收起（滚动/草稿等内存态原样保留）
	h.renderOverlay(SCOPE_A);
	assert.equal(h.pageId(), "todo");

	// 用户点了侧栏另一个会话：覆盖层收起，露出他刚选的会话
	h.renderOverlay({ projectId: "p1", sessionId: "s2" });
	assert.equal(h.pageId(), null);
	assert.equal(h.returnTarget(), null);
});

test("守卫挂载时不会把初始会话当成切换", () => {
	const h = createHarness();
	h.store.set(h.atoms.personalWorkbenchPageAtom, "reading");
	h.renderOverlay(SCOPE_A);
	assert.equal(h.pageId(), "reading");
});

test("侧栏分组折叠态：点选写 localStorage 与 settings，迟到 settings 不回盖用户选择", () => {
	const h = createHarness();
	const storage = createStorage();
	const persisted = [];
	const section = h.renderSection({ settingsLoaded: false, settingsCollapsed: false, persistCollapsed: (next) => persisted.push(next), storage });
	assert.equal(section.collapsed, false, "缺省展开：用户第一次要看到入口");

	h.renderSection({ settingsLoaded: false, settingsCollapsed: false, persistCollapsed: (next) => persisted.push(next), storage }).toggleCollapsed();
	assert.equal(h.sectionCollapsed(), true);
	assert.equal(storage.getItem("pid:personal-workbench-collapsed"), "true");
	assert.deepEqual(persisted, [true]);

	// 用户点完之后 settings 才回来（值仍是旧的展开）：不得回盖
	const afterToggle = h.renderSection({ settingsLoaded: true, settingsCollapsed: false, persistCollapsed: (next) => persisted.push(next), storage });
	assert.equal(afterToggle.collapsed, true);
});

test("侧栏分组折叠态：settings.json 是权威来源，首次拿到时覆盖 localStorage 首屏值", () => {
	const h = createHarness();
	const storage = createStorage();
	const persist = () => {};
	const first = h.renderSection({ settingsLoaded: false, settingsCollapsed: true, persistCollapsed: persist, storage });
	assert.equal(first.collapsed, false, "settings 未就绪前先用 localStorage/默认值");
	const hydrated = h.renderSection({ settingsLoaded: true, settingsCollapsed: true, persistCollapsed: persist, storage });
	assert.equal(h.sectionCollapsed(), true, "settings.json 是权威来源");
	assert.equal(storage.getItem("pid:personal-workbench-collapsed"), "true", "水合结果同步回首屏缓存");
	// useEffect 里的写入要到下一帧才反映回 hook 读值（真实 React 下由重渲染体现，替身里手动再渲染一次）
	const nextFrame = h.renderSection({ settingsLoaded: true, settingsCollapsed: true, persistCollapsed: persist, storage });
	assert.equal(nextFrame.collapsed, true);
	assert.equal(hydrated.collapsed, false, "本帧快照仍是水合前的值，不得倒推成已生效");
});

test("导航策略：返回目标判定只认身份相同才算「无需恢复」", () => {
	const nav = loadTsCommonJs(NAV_PATH);
	assert.deepEqual(plain(nav.resolvePersonalWorkbenchReturn({ target: null, currentProjectId: "p1", currentSessionId: "s1" })), { kind: "close" });
	assert.deepEqual(plain(nav.resolvePersonalWorkbenchReturn({ target: { projectId: "p1", sessionId: "s1" }, currentProjectId: "p1", currentSessionId: "s1" })), { kind: "close" });
	assert.deepEqual(plain(nav.resolvePersonalWorkbenchReturn({ target: { projectId: "p1", sessionId: "s1" }, currentProjectId: "p2", currentSessionId: "s1" })), { kind: "restore", projectId: "p1", sessionId: "s1" });
	assert.deepEqual(plain(nav.resolvePersonalWorkbenchReturn({ target: { projectId: "p1", sessionId: "s1" }, currentProjectId: "p1", currentSessionId: "s2" })), { kind: "restore", projectId: "p1", sessionId: "s1" });
	assert.deepEqual(plain(nav.resolvePersonalWorkbenchReturn({ target: { projectId: "p1", sessionId: "s1" } })), { kind: "restore", projectId: "p1", sessionId: "s1" });
});

test("导航策略：入口点击语义与身份键", () => {
	const nav = loadTsCommonJs(NAV_PATH);
	assert.equal(nav.resolvePersonalWorkbenchEntryAction({ openPageId: "todo", entryPageId: "todo" }), "return");
	assert.equal(nav.resolvePersonalWorkbenchEntryAction({ openPageId: "reading", entryPageId: "todo" }), "open");
	assert.equal(nav.resolvePersonalWorkbenchEntryAction({ openPageId: null, entryPageId: "reading" }), "open");

	assert.equal(nav.personalWorkbenchScopeKey({ projectId: "p1", sessionId: "s1" }), "p1|s1");
	assert.equal(nav.personalWorkbenchScopeKey({}), "|");
	assert.equal(nav.shouldClosePersonalWorkbenchOnScopeChange(undefined, "p1|s1"), false, "首次挂载记录身份，不算切换");
	assert.equal(nav.shouldClosePersonalWorkbenchOnScopeChange("p1|s1", "p1|s1"), false);
	assert.equal(nav.shouldClosePersonalWorkbenchOnScopeChange("p1|s1", "p1|s2"), true);
	assert.equal(nav.shouldClosePersonalWorkbenchOnScopeChange("p1|s1", "p2|s1"), true);
});

test("覆盖层互斥：只与页面式插件面板互斥，后打开的一方赢得会话区", () => {
	const nav = loadTsCommonJs(NAV_PATH);
	const decide = (pageOpen, hostPluginPageOpen, previousPageOpen, previousHostPluginPageOpen) => nav.resolveOverlayPageMutex({ pageOpen, hostPluginPageOpen, previousPageOpen, previousHostPluginPageOpen });

	// 不同时开时不动作（包括只开一边）
	assert.equal(decide(false, false, false, false), "none");
	assert.equal(decide(false, true, false, false), "none");

	// modal / popover 插件面板（hostPluginPageOpen=false）允许盖在功能页上：
	// 不得被当成页面式面板收掉，否则关掉弹窗后就回不到原功能页
	assert.equal(decide(true, false, false, false), "none");
	assert.equal(decide(true, false, true, false), "none");
	assert.equal(decide(true, false, false, true), "none");

	// 功能页刚打开（插件页早就在开）→ 收插件页；方向反了就会出现「点了入口看不到反应」
	assert.equal(decide(true, true, false, true), "close-host-plugin-page");
	// 插件页刚打开（功能页早就在开）→ 收功能页
	assert.equal(decide(true, true, true, false), "close-personal-workbench");
	// 两边都同时新开（同一帧内不可能来自两次用户操作）→ 以功能页可见为准
	assert.equal(decide(true, true, false, false), "close-host-plugin-page");
	// 已同时开着（不变量被破坏）→ 同样保功能页
	assert.equal(decide(true, true, true, true), "close-host-plugin-page");
});

test("折叠态缓存：settings 布尔与 localStorage 字符串都认，脏值回落未设置", () => {
	const nav = loadTsCommonJs(NAV_PATH);
	assert.equal(nav.parsePersonalWorkbenchCollapsed(true), true);
	assert.equal(nav.parsePersonalWorkbenchCollapsed(false), false);
	assert.equal(nav.parsePersonalWorkbenchCollapsed("true"), true);
	assert.equal(nav.parsePersonalWorkbenchCollapsed("false"), false);
	assert.equal(nav.parsePersonalWorkbenchCollapsed("yes"), null);
	assert.equal(nav.parsePersonalWorkbenchCollapsed(undefined), null);

	assert.equal(nav.readPersonalWorkbenchCollapsed(undefined), null, "没有 localStorage 时不猜值");
	assert.equal(nav.readPersonalWorkbenchCollapsed(createStorage({ "pid:personal-workbench-collapsed": "broken" })), null);
	assert.equal(nav.readPersonalWorkbenchCollapsed(createStorage({ "pid:personal-workbench-collapsed": "true" })), true);

	const storage = createStorage();
	nav.writePersonalWorkbenchCollapsed(storage, true);
	assert.equal(storage.getItem("pid:personal-workbench-collapsed"), "true");
	nav.writePersonalWorkbenchCollapsed(storage, false);
	assert.equal(storage.getItem("pid:personal-workbench-collapsed"), "false");
});

test("功能页目录：只有阅读与待办；两个页面都已实现，静态 ready 不等于服务在线（不得显示成已迁移）", () => {
	const pages = loadTsCommonJs(PAGES_PATH);
	assert.deepEqual(plain(pages.PERSONAL_WORKBENCH_PAGES.map((page) => page.id)), ["reading", "todo"]);
	for (const page of pages.PERSONAL_WORKBENCH_PAGES) {
		assert.equal(pages.personalWorkbenchPageById(page.id), page, `${page.id} 按身份查回同一份描述符`);
	}
	// 阅读已实现（P03）：静态 ready 只说明页面存在；是否有书库、要不要密码由打开页面后的运行期状态给出
	const reading = pages.personalWorkbenchPageById("reading");
	assert.equal(reading.availability, "ready", "P03 已实现阅读页，静态值表示页面已实现");
	assert.equal(pages.personalWorkbenchBadgeKey(reading.availability), null, "已实现的页面不显示未接入角标");
	assert.equal(pages.personalWorkbenchStatusKeys(reading.availability), null, "已实现的页面不回落目录说明，运行期状态由页面自己说明");
	// 待办已实现（P02）：同样的口径
	const todo = pages.personalWorkbenchPageById("todo");
	assert.equal(todo.availability, "ready", "P02 已实现待办页，静态值表示页面已实现");
	assert.equal(pages.personalWorkbenchBadgeKey(todo.availability), null, "已实现的页面不显示未接入角标");
	// 可用/不可用状态各自的文案映射：ready 不显示角标与横幅（正文由页面实现给出）
	assert.equal(pages.personalWorkbenchStatusKeys("ready"), null);
	assert.equal(pages.personalWorkbenchBadgeKey("unavailable"), "personalWorkbench.badgeUnavailable");
	assert.equal(pages.personalWorkbenchStatusKeys("unavailable").titleKey, "personalWorkbench.unavailableTitle");
});

test("功能页目录文案：中英两份词典都有非空条目（繁体由生成器派生）", () => {
	const pages = loadTsCommonJs(PAGES_PATH);
	const zhCN = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const enUS = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	const keys = [
		"personalWorkbench.title",
		"personalWorkbench.expand",
		"personalWorkbench.collapse",
		"personalWorkbench.backToSession",
		"personalWorkbench.badgeNotConnected",
		"personalWorkbench.badgeUnavailable",
		"personalWorkbench.notConnectedTitle",
		"personalWorkbench.notConnectedBody",
		"personalWorkbench.unavailableTitle",
		"personalWorkbench.unavailableBody",
	];
	for (const page of pages.PERSONAL_WORKBENCH_PAGES) {
		keys.push(page.titleKey, page.summaryKey);
		// ready 页面没有角标；未接入页面必须有角标。两种状态都要有可用性说明文案
		const badgeKey = pages.personalWorkbenchBadgeKey(page.availability);
		if (page.availability !== "ready") assert.ok(badgeKey, `${page.id} 需要角标文案 key`);
		if (badgeKey) keys.push(badgeKey);
		keys.push(pages.personalWorkbenchStatusKeys("unavailable").titleKey, pages.personalWorkbenchStatusKeys("unavailable").bodyKey);
	}
	for (const key of keys) {
		assert.equal(typeof zhCN[key], "string", `zh-CN 缺 ${key}`);
		assert.equal(typeof enUS[key], "string", `en-US 缺 ${key}`);
		assert.ok(zhCN[key].length > 0 && enUS[key].length > 0, `${key} 文案不能为空`);
	}
});

test("功能页身份解析：未知值与非法类型不落进状态", () => {
	const shared = loadTsCommonJs("src/shared/types/personalWorkbench.ts");
	assert.equal(shared.parsePersonalWorkbenchPageId("todo"), "todo");
	assert.equal(shared.parsePersonalWorkbenchPageId("reading"), "reading");
	assert.equal(shared.parsePersonalWorkbenchPageId("workbench"), null);
	assert.equal(shared.parsePersonalWorkbenchPageId(undefined), null);
	assert.equal(shared.isPersonalWorkbenchPageId("todo"), true);
	assert.equal(shared.isPersonalWorkbenchPageId(42), false);
	assert.deepEqual(plain([...shared.PERSONAL_WORKBENCH_PAGE_IDS]), ["reading", "todo"]);
});
