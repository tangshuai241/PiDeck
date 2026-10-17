import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ===== beui AnimatedBadge 组件拷贝 =====

test("animated-badge component copied with official markers", () => {
	const source = readFileSync("src/renderer/src/components/motion/animated-badge.tsx", "utf8");
	assert.match(source, /beui\.dev[\s\S]*animated-badge/);
	assert.match(source, /export type AnimatedBadgeStatus =[\s\S]*?\| "loading";/);
	assert.match(source, /export type AnimatedBadgeSize = "sm" \| "md"/);
	// 依赖：motion/react + 项目既有 @/lib/ease + @/lib/utils
	assert.match(source, /from "motion\/react"/);
	assert.match(source, /from "@\/lib\/ease"/);
	assert.match(source, /from "@\/lib\/utils"/);
	// 关键行为：loading 旋转、状态图标滚动、脉冲层
	// loading 旋转收敛到共享 spinner token（animate-pideck-spin，reduced-motion 下继续转），
	// 替代官方 rotate:360 写法——与 spinnerUtility.test.mjs 的 title-tab badge 断言一致（PR #171 统一 spinner）
	assert.match(source, /status === "loading" && !icon[\s\S]*?className="inline-flex animate-pideck-spin"/);
	assert.match(source, /ICON_ROLL_VARIANTS/);
	assert.match(source, /pulse = status === "loading"/);
	// 与官方 API 对齐：showIcon / contentKey / size + PiDeck bare 扩展
	assert.match(source, /showIcon = true/);
	assert.match(source, /contentKey/);
	assert.match(source, /bare\?: boolean;/);
	assert.match(source, /bare && "h-auto gap-0 rounded-none border-0 bg-transparent p-0"/);
});

test("motion dependency and ease helpers available", () => {
	const pkg = readFileSync("package.json", "utf8");
	assert.match(pkg, /"motion": "\^13\.0\.0"/);
	const ease = readFileSync("src/renderer/src/lib/ease.ts", "utf8");
	assert.match(ease, /export const EASE_OUT/);
});

// ===== 会话 Tab 栏接入 =====

test("session tab uses the shared status indicator (running spins, waiting stays static)", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	const indicator = readFileSync("src/renderer/src/components/session/SessionActivityIndicator.tsx", "utf8");
	const presentation = readFileSync("src/renderer/src/utils/sessionStatusPresentation.ts", "utf8");
	// Tab 不再自建徽章映射：与侧栏/项目列表共用 SessionActivityIndicator。
	assert.match(source, /import \{ SessionActivityIndicator \} from "\.\/SessionActivityIndicator";/);
	assert.match(source, /<SessionActivityIndicator status=\{status\} sessionId=\{sessionId\} busy=\{/);
	assert.doesNotMatch(source, /sessionStatusBadge/);
	assert.doesNotMatch(source, /<AnimatedBadge/);
	// 统一规则：运行优先 → 待回答 → 未读结果；待回答不渲染旋转图标。
	assert.match(presentation, /export function presentSessionStatus/);
	assert.match(presentation, /kind: "running"/);
	assert.match(presentation, /kind: "waiting"/);
	assert.match(presentation, /kind: "unread"/);
	assert.match(indicator, /presentSessionStatus\(/);
	assert.match(indicator, /presentation\.kind === "running"[\s\S]*?LoaderCircle/);
	assert.match(indicator, /presentation\.kind === "waiting"[\s\S]*?bg-warning/);
	// 激活指示条（tab 下方弧形横条）已移除
	assert.doesNotMatch(source, /session-tabs-indicator/);
	assert.doesNotMatch(source, /measureIndicator/);
	assert.doesNotMatch(source, /INDICATOR_BASE_WIDTH/);
});

test("session tab active background is instant (no shared-layout slide between tabs)", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	// 用户明确要求去掉切 Tab 时「选中底色从旧 Tab 滑到新 Tab」的移动动画：栏内不再引入
	// motion 共享投影（layoutId/layoutRoot），底色改为激活 Tab 自身的普通 span，切换瞬时出现。
	assert.doesNotMatch(source, /from "motion\/react"/);
	assert.doesNotMatch(source, /layoutId=\{/);
	assert.doesNotMatch(source, /layoutRoot/);
	// 三种 Tab（会话 / 文件 / 插件伪 Tab）各自保留一处静态选中底色，且只在激活时渲染。
	const backgrounds = source.match(/pointer-events-none\s+absolute\s+inset-0\s+rounded-md\s+bg-accent/g) ?? [];
	assert.equal(backgrounds.length, 3, "会话/文件/插件伪 Tab 各保留一处静态选中底色");
	assert.match(source, /\{active &&\s*<span\s+aria-hidden="true"\s+className="pointer-events-none absolute inset-0 rounded-md bg-accent"/);
	assert.match(source, /\{tab\.active &&\s*<span\s+aria-hidden="true"\s+className="pointer-events-none absolute inset-0 rounded-md bg-accent"/);
});

test("sidebar SessionTree shares the same status indicator as tabs", () => {
	const source = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
	assert.match(source, /import \{ SessionActivityIndicator \} from "\.\.\/session\/SessionActivityIndicator";/);
	assert.match(source, /<SessionActivityIndicator status=\{runtime\?\.status\} sessionId=\{session\.id\} \/>/);
	assert.doesNotMatch(source, /sessionStatusDotClass/);
});

test("tab dropdown menu: no switch-to item, state-based disable with visible gray", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	// “切换到此会话”已移除（点击 Tab 本体即切换，菜单项冗余）
	assert.doesNotMatch(source, /tabs\.switchTo/);
	assert.doesNotMatch(source, /MousePointerClick/);
	// 运行控制已上收右上角 ⋯ 更多操作菜单（当前会话分组）：
	// 全状态可用——菜单项不再按 live/终态分两套渲染，能力统一走策略函数，
	// 置灰用内联 style（特异性最高，置灰可见）。
	assert.match(source, /function RunControlItems\(/);
	assert.match(source, /canRunSessionAction\(capabilities, "start"\)/);
	// 「停止回答」= abort（只中断当前回合，进程保留）；杀进程的入口是「关闭 Agent」菜单项
	assert.match(source, /canRunSessionAction\(capabilities, "abort"\)/);
	assert.match(source, /canRunSessionAction\(capabilities, "reload"\)/);
	assert.match(source, /\? \{ opacity: 0\.4 \} : undefined/);
	// 主控项按状态切换文案：未启动/失败/已关闭 → 启动 Agent；live → 重启
	assert.match(source, /capabilities\.primaryAction === "start"/);
	assert.match(source, /t\("tabs\.startAgent"\)/);
	// ⋯ 菜单按功能分组：当前会话 / 工具（分组只做标签显示）
	assert.match(source, /DropdownMenuLabel>\{t\("tabs\.currentSessionGroup"\)\}/);
	assert.match(source, /DropdownMenuLabel>\{t\("tabs\.toolsGroup"\)\}/);
	// Tab 级菜单为右键 ContextMenu（固定/关闭等），下拉触发按钮已移除
	assert.match(source, /ContextMenuTrigger asChild/);
	assert.doesNotMatch(source, /role="tab-menu"/);
	// App 侧不再用 isLiveRuntimeStatus 挡状态：能力和动作都收敛到 runControl 对象
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /runControl: currentSessionId\n\s*\? \{/);
	assert.match(app, /getSessionRunCapabilities\(currentSessionId\)/);
	assert.match(app, /onAction: \(action: SessionRunAction\) => void runSessionControl\(currentSessionId, action\)/);
	// i18n key 同步删除
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.doesNotMatch(zh, /tabs\.switchTo/);
	assert.doesNotMatch(en, /tabs\.switchTo/);
});
