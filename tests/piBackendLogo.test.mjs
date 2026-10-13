import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { atom, createStore, Provider, useAtomValue } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 保留真实 React/Jotai 订阅，只隔离设置镜像与无关的文案、别名解析。
const logoStyleAtom = atom("pi-tui");
const customLogoAtom = atom("");
const { PiLogo, DshLogo, SessionSourceBadge } = loadTsCommonJs("src/renderer/src/components/session/SessionSourceBadge.tsx", {
	stubs: {
		// VM 用 CJS require，测试用 ESM import；共用同一个 Jotai hook，避免两个 Provider context。
		jotai: { useAtomValue },
		"../../atoms/app-ui-atoms": { logoStyleAtom, customLogoAtom },
		"../../i18n": { t: (key) => key },
		"@/lib/utils": { cn: (...classes) => classes.filter(Boolean).join(" ") },
	},
});

/** 从公开组件渲染 HTML，各用例独立持有设置 store，不接触真实用户配置。 */
function renderLogo(component, props = {}, store = createStore()) {
	return renderToStaticMarkup(createElement(Provider, { store }, createElement(component, props)));
}

/** 官方三色位图：4×4 方形，10 个有色格，不可回落旧单色路径。 */
function assertPiTuiLogo(html) {
	assert.match(html, /viewBox="0 0 4 4"/u);
	assert.equal((html.match(/<rect\b/gu) ?? []).length, 10);
	for (const color of ["#E48A7A", "#4F8EB3", "#EAB65D"]) {
		assert.ok(html.includes(`fill="${color}"`), `缺少官方品牌色 ${color}`);
	}
	assert.doesNotMatch(html, /viewBox="140 140 520 520"/u);
}

test("pi 后端标识默认显示新的官方三色 logo", () => {
	const html = renderLogo(PiLogo);
	assertPiTuiLogo(html);
	assert.match(html, /aria-hidden="true"/u);
	assert.match(html, /class="size-3\.5"/u);
});

test("显式选择经典风格时 pi 后端标识保留旧单色 logo", () => {
	const store = createStore();
	store.set(logoStyleAtom, "classic");
	const html = renderLogo(PiLogo, {}, store);
	assert.match(html, /viewBox="140 140 520 520"/u);
	assert.equal((html.match(/<path\b/gu) ?? []).length, 2);
	assert.match(html, /fill="currentColor"/u);
	assert.doesNotMatch(html, /<rect\b/u);
});

test("pi 后端标识读取同一设置镜像，风格往返切换后渲染一致", () => {
	const store = createStore();
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));
	store.set(logoStyleAtom, "classic");
	assert.match(renderLogo(PiLogo, {}, store), /viewBox="140 140 520 520"/u);
	store.set(logoStyleAtom, "pi-tui");
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));
});

test("新 pi 后端 logo 保留输入框、下拉项与头像各自的尺寸类", () => {
	for (const className of ["size-[15px] shrink-0", "size-3.5 shrink-0", "size-4"]) {
		const html = renderLogo(PiLogo, { className });
		assertPiTuiLogo(html);
		assert.ok(html.includes(`class="${className}"`));
	}
});

test("pi 会话来源徽标复用同一设置，避免另一份旧 SVG 不跟随", () => {
	const store = createStore();
	assertPiTuiLogo(renderLogo(SessionSourceBadge, { source: "pi" }, store));
	store.set(logoStyleAtom, "classic");
	assert.match(renderLogo(SessionSourceBadge, { source: "pi" }, store), /viewBox="140 140 520 520"/u);
});

test("自定义 logo 风格：来源徽标渲染用户图片，风格切回内置标后不再渲染图片", () => {
	const store = createStore();
	store.set(logoStyleAtom, "custom");
	store.set(customLogoAtom, "data:image/png;base64,AAAA");
	const html = renderLogo(PiLogo, {}, store);
	assert.match(html, /<img src="data:image\/png;base64,AAAA"/u);
	assert.match(html, /class="size-3\.5 object-contain"/u, "自定义图沿用调用方给的尺寸类");

	// 选了 custom 但还没传图（或图被清掉）：回落内置标，不能渲染空 img
	store.set(customLogoAtom, "");
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));

	store.set(logoStyleAtom, "pi-tui");
	store.set(customLogoAtom, "data:image/png;base64,AAAA");
	// 非 custom 风格下即使镜像里残留图片也不渲染它
	assertPiTuiLogo(renderLogo(PiLogo, {}, store));
});

test("切换 pi logo 风格不改变 DSH 或其他会话来源品牌", () => {
	const store = createStore();
	const cases = [[DshLogo, {}], ...["codex", "claude", "qoder", "opencode", "zcode", "workbuddy", "cursor"].map((source) => [SessionSourceBadge, { source }])];
	for (const [component, props] of cases) {
		store.set(logoStyleAtom, "classic");
		const classic = renderLogo(component, props, store);
		store.set(logoStyleAtom, "pi-tui");
		assert.equal(renderLogo(component, props, store), classic);
	}
});

test("输入框后端选择、下拉选项和锁定按钮全部复用统一 PiLogo", () => {
	const source = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	assert.match(source, /import\s*\{[^}]*\bPiLogo\b[^}]*\}\s*from\s*["']\.\/SessionSourceBadge["']/u);
	assert.equal((source.match(/<PiLogo\b/gu) ?? []).length, 3);
	assert.doesNotMatch(source, /viewBox\s*=\s*["']140 140 520 520["']/u);
});
