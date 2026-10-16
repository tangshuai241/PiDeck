import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadStats() {
	const t = (key, params = {}) => {
		const table = {
			"composerStats.counts": "{turns} 轮 · {steps} 步",
			"composerStats.turns": "{turns} 轮",
			"composerStats.llm": "LLM {duration}",
			"composerStats.toolCall": "工具调用 {duration}",
			"composerStats.ttftAverage": "首 token 平均 {duration}",
			"composerStats.streamingTps": "流式 {throughput} tok/s",
			"composerStats.endToEndTps": "端到端 {throughput} tok/s",
			"composerStats.cacheHit": "缓存命中 {percent}%",
			"composerStats.tokens": "输入 {input} tok · 输出 {output} tok",
			"composerStats.ttft": "首 token {duration}",
			"composerStats.reply": "回复 {duration}",
		};
		return (table[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
	};
	return loadTsCommonJs("src/renderer/src/components/session/ComposerStatsLine.tsx", {
		stubs: {
			react: { Fragment: "Fragment", memo: (fn) => fn, useLayoutEffect: () => undefined, useRef: () => ({ current: null }), useState: (v) => [v, () => undefined] },
			"../../i18n": { t },
			"../i18n": { t },
			"./TimelineFormat": { formatDuration: (ms) => `${ms}ms` },
			"./SessionContextMeter": { formatTokens: (n) => String(n) },
		},
	});
}

test("pi last-reply metrics fill the strip when sessionStats is absent", () => {
	const { buildComposerStatsGroups } = loadStats();
	const groups = buildComposerStatsGroups({
		ttftMs: 210,
		totalMs: 4300,
		tps: 31,
		inputTokens: 800,
		outputTokens: 90,
	});
	assert.equal(groups[0], "首 token 210ms · 回复 4300ms · 流式 31 tok/s");
	assert.equal(groups[1], "输入 800 tok · 输出 90 tok");
});

test("segments carry per-metric hints without changing the visible text", () => {
	// 每个指标带悬停说明：字符串拼接结果与旧版一致，hint 指向对应计算口径文案。
	const { buildComposerStatsSegments } = loadStats();
	const pi = buildComposerStatsSegments({ ttftMs: 210, totalMs: 4300, tps: 31, inputTokens: 800, outputTokens: 90, cacheHitPercent: 91 }, 4);
	assert.deepEqual(JSON.parse(JSON.stringify(pi.map((parts) => parts.map((part) => part.text)))), [["4 轮"], ["首 token 210ms", "回复 4300ms", "流式 31 tok/s"], ["缓存命中 91%"], ["输入 800 tok · 输出 90 tok"]]);
	assert.equal(pi[0][0].hint, "composerStats.turnsHint");
	assert.equal(pi[1][0].hint, "ctx.detail.ttftHint");
	assert.equal(pi[1][2].hint, "ctx.detail.tpsHint");
	assert.equal(pi[2][0].hint, "ctx.detail.hitLatestHint");
	// 组件渲染：每个数字 span 都挂 title={part.hint}，不影响布局
	const stats = readFileSync("src/renderer/src/components/session/ComposerStatsLine.tsx", "utf-8");
	assert.match(stats, /<span title=\{part\.hint\}>\{part\.text\}<\/span>/);
});

test("saved display mode selects Pi reply rates without falling back", () => {
	const { buildComposerStatsSegments } = loadStats();
	const pi = { totalMs: 15000, tps: 100, endToEndTps: 1000 / 15 };
	const piPart = (mode) => buildComposerStatsSegments(pi, 0, mode)[0].at(-1);
	assert.equal(piPart("streaming").text, "流式 100 tok/s");
	assert.equal(piPart("endToEnd").text, "端到端 67 tok/s");
	assert.equal(piPart("endToEnd").hint, "ctx.detail.endToEndTpsHint");
	assert.equal(buildComposerStatsSegments({ tps: 100 }, 0, "endToEnd")[0][0].text, "端到端 — tok/s");
});

test("empty runtime produces no stats groups", () => {
	const { buildComposerStatsGroups } = loadStats();
	assert.equal(buildComposerStatsGroups(undefined).length, 0);
	assert.equal(buildComposerStatsGroups({}).length, 0);
});

test("composer area mounts the stats strip under the input card", () => {
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	const stats = readFileSync("src/renderer/src/components/session/ComposerStatsLine.tsx", "utf8");
	assert.match(area, /import \{ ComposerStatsLine \} from "\.\/ComposerStatsLine"/);
	assert.match(area, /statsLine=\{\s*<ComposerStatsLine\s+state=\{composer\.runtime\?\.state\}\s+turnCount=\{props\.turnCount\}\s+contextMeter=/);
	assert.match(area, /\{props\.statsLine\}/);
	// footer 固定保留 8px 底部留白；ComposerMeasuredExtras 会把它计入总高度，
	// StatsLine 自身仍只在有数字时渲染。
	assert.match(area, /className="composer[^"]*px-0 pb-2"/);
	assert.match(stats, /if \(segments\.length === 0\) return null/);
	assert.match(stats, /px-1 pb-0 pt-1/);
	assert.match(stats, /min-w-0 truncate text-center/);
});

test("stats copy exists in both locales", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const key of ["composerStats.counts", "composerStats.llm", "composerStats.toolCall", "composerStats.ttftAverage", "composerStats.streamingTps", "composerStats.endToEndTps", "composerStats.cacheHit", "composerStats.tokens", "composerStats.ttft", "composerStats.reply", "composerStats.turnsHint"]) {
		assert.match(zh, new RegExp(`"${key.replace(".", "\\.")}"`));
		assert.match(en, new RegExp(`"${key.replace(".", "\\.")}"`));
	}
});
