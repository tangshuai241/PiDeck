// 模式选择器可见性纯函数测试（useComposerModeAvailability 抽出的 computeVisibleModes；
// 选择器已常驻底栏，2026-10 外移自「+」菜单）：生图不是可切模式（imagegen 是独立后端）；
// imagegen 会话或 legacy 含生图消息的 pi 会话（isImageGen=true）选择器为空，走专用生图底栏；
// plan/goal 受扩展开关控制。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadHookModule() {
	const source = readFileSync("src/renderer/src/hooks/useComposerModeAvailability.ts", "utf8");
	// 只对纯函数求值：hook 的 React/desktopApi 是外部依赖，mock 掉副作用路径，
	// 仅转译后取 computeVisibleModes 导出做断言（行为不依赖真实扩展列表）。
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.includes("react")) return { useCallback: () => {}, useEffect: () => {}, useState: () => [] };
			if (id.includes("desktopApi")) return {};
			throw new Error(`unexpected require: ${id}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "useComposerModeAvailability.ts" });
	return sandbox.exports;
}

const { computeVisibleModes } = loadHookModule();

// 底栏触发器 ghost 外观（2026-10 用户反馈）：shadcn SelectTrigger 基底自带 bg-bg-input，
// 底栏按钮一旦不显式 bg-transparent 就会被染成实心块，与同排「+」等 ghost 按钮不齐；
// 模式选择器还自带一个 chevron（图标+箭头并排 → 图标偏左、视觉多一个小按钮）。
const COMPOSER_TRIGGER_FILES = ["src/renderer/src/components/session/ComposerComponents.tsx", "src/renderer/src/components/session/ComposerImageGenOptions.tsx"];

function composerSelectTriggerClassNames() {
	const result = [];
	for (const file of COMPOSER_TRIGGER_FILES) {
		const source = readFileSync(file, "utf8");
		// 空白容忍：[^>]* 跨行匹配属性，避免行序/缩进变化让断言失效。
		for (const match of source.matchAll(/<SelectTrigger\b[^>]*className="([^"]*)"/g)) {
			if (match[1].includes("composer-bar-btn")) result.push([file, match[1]]);
		}
	}
	return result;
}

test("底栏 SelectTrigger 保持 ghost 透明底（不被 shadcn 基底的实心底染色）", () => {
	const triggers = composerSelectTriggerClassNames();
	assert.ok(triggers.length >= 3, `应扫到底栏触发器（mode/backend/imagegen），实际 ${triggers.length}`);
	for (const [file, className] of triggers) {
		assert.ok(className.includes("bg-transparent"), `${file} 的底栏 SelectTrigger 必须显式 bg-transparent：${className}`);
	}
});

test("模式选择器隐藏自带 chevron，与后端选择器/「+」同族", () => {
	const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	const modeTrigger = composer.match(/"composer-bar-btn[\s]+mode[^"]*"/)?.[0];
	assert.ok(modeTrigger, "模式选择器应带 composer-bar-btn mode 语义 class（e2e 定位依赖）");
	assert.ok(modeTrigger.includes("[&_[data-slot='select-icon']]:hidden"), `模式选择器需隐藏自带 chevron：${modeTrigger}`);
});

test("pi 全扩展可用：菜单只有 普通/目标/规划，不再出现生图", () => {
	const result = [...computeVisibleModes({ isImageGen: false, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, ["normal", "goal", "plan"]);
});

test("pi 关闭 plan/goal 扩展：对应模式从菜单消失，仅保留普通", () => {
	const result = [...computeVisibleModes({ isImageGen: false, planModeAvailable: false, goalModeAvailable: false })];
	assert.deepEqual(result, ["normal"]);
});

test("imagegen 会话（backend=imagegen）：模式菜单为空，不走 LLM 模式", () => {
	const result = [...computeVisibleModes({ isImageGen: true, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, []);
});

test("legacy 含生图消息的 pi 会话（isImageGen=true）：同样锁定为空菜单（防误切回 LLM）", () => {
	const result = [...computeVisibleModes({ isImageGen: true, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, []);
});

// 2026-10 外移：模式选择器常驻底栏（不再藏「+」菜单），且受设置 → 外观 → 功能模块的
// composerModes 隐藏控制；隐藏时特殊模式仍由退出×兑底，不锁死用户。
test("模式选择器已常驻底栏并可被功能模块设置隐藏（源码形状）", () => {
	const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	// 常驻条件：至少两个可选模式且未被隐藏（只剩 normal 的单选项下拉不渲染——
	// ACP 会话无 pi 扩展/plan+goal 都被关时不占位，ACP 模式等价物走 configOptions）
	assert.match(composer, /visibleModes\.length > 1 && !modesHidden/, "常驻条件：至少两个可选模式且未被隐藏");
	assert.match(composer, /composerModesHiddenAtom/, "读取 composerModes 隐藏开关");
	assert.match(composer, /aria-label=\{t\(MODE_LABEL\[props\.composerAgentMode\]\)\}/, "选择器 aria-label 携带当前模式全名（normal 态只显图标，可访问性靠它）");
	assert.doesNotMatch(composer, /composerAddMode/, "「+」菜单不再承载模式分组");
	const modules = readFileSync("src/renderer/src/components/app/settings/ModuleVisibilitySection.tsx", "utf8");
	assert.match(modules, /composerModes:/, "功能模块设置页列出模式选择器开关");
});
