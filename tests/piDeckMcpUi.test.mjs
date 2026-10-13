import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (v) => JSON.parse(JSON.stringify(v));
const state = { enabled: false, running: false, projectIds: [], projects: [{ id: "p1", name: "Project" }] };
function harness(api) {
	const host = quickMessageHookHost();
	const { usePiDeckMcp } = loadTsCommonJs("src/renderer/src/hooks/usePiDeckMcp.ts", { stubs: { react: host.react, "../desktopApi": { desktopApi: { piDeckMcp: api } } } });
	return { render: () => host.render(usePiDeckMcp), unmount: host.unmount };
}

test("MCP consent hook keeps scope drafts explicit and prevents duplicate same-frame mutations", async () => {
	let finish;
	const calls = [];
	const h = harness({
		getState: async () => ({ ok: true, value: state }),
		setAccess: (input) => {
			calls.push(plain(input));
			return new Promise((r) => {
				finish = r;
			});
		},
	});
	h.render();
	await flush();
	h.render().setProjectIds(["p1"]);
	const view = h.render();
	const first = view.apply(true);
	await view.apply(true);
	assert.deepEqual(calls, [{ enabled: true, projectIds: ["p1"] }]);
	assert.equal(h.render().busy, true);
	finish({ ok: true, value: { ...state, enabled: true, running: true, projectIds: ["p1"] } });
	await first;
	assert.equal(h.render().state.running, true);
});

test("MCP export fetched after unmount cannot run a config write or clipboard action", async () => {
	let finish;
	const actions = [];
	const h = harness({
		getState: async () => ({ ok: true, value: state }),
		connection: () =>
			new Promise((r) => {
				finish = r;
			}),
	});
	h.render();
	await flush();
	const pending = h.render().withConnection(async (value) => {
		actions.push(value);
		return true;
	});
	h.unmount();
	finish({ ok: true, value: { mcpServers: { pideck: { enabled: false } } } });
	assert.equal(await pending, false);
	assert.deepEqual(actions, []);
});

test("failed host update refreshes actual running state and exposes the error", async () => {
	let calls = 0;
	const h = harness({ getState: async () => ({ ok: true, value: ++calls === 1 ? { ...state, running: true } : state }), setAccess: async () => ({ ok: false, code: "config-write-failed" }) });
	h.render();
	await flush();
	await h.render().apply(false);
	assert.equal(h.render().state.running, false);
	assert.equal(h.render().error, "config-write-failed");
	assert.equal(h.render().busy, false);
});

test("connection handoff merges without overwriting existing local/inherited services and stays disabled", () => {
	const { addPiDeckMcpDefinition } = loadTsCommonJs("src/renderer/src/config/piDeckMcpConfigMerge.ts");
	const current = { autoEnableCodemode: false, custom: { preserved: true }, mcpServers: { other: { command: "other", custom: true } } };
	const definition = { url: "http://127.0.0.1:1234/mcp", headers: { Authorization: "Bearer test" }, enabled: true };
	const next = plain(addPiDeckMcpDefinition(current, new Set(["other"]), definition));
	assert.deepEqual(next, { ...current, mcpServers: { ...current.mcpServers, pideck: { ...definition, enabled: false } } });
	assert.equal(addPiDeckMcpDefinition(current, new Set(["pideck"]), definition), null);
	assert.equal(addPiDeckMcpDefinition(next, new Set(), definition), null);
	assert.equal(current.mcpServers.pideck, undefined);
});

test("saved consent remains revocable when its listener could not start", async () => {
	const host = quickMessageHookHost();
	const updates = [];
	const control = (name) => ({ [name]: () => null });
	const { PiDeckMcpPanel } = loadTsCommonJs("src/renderer/src/config/PiDeckMcpPanel.tsx", {
		stubs: {
			react: { ...host.react, useId: () => "mcp" },
			"../i18n": { t: (key) => key },
			"../desktopApi": {
				desktopApi: {
					piDeckMcp: {
						getState: async () => ({ ok: true, value: { ...state, enabled: true, running: false, error: "listen-failed" } }),
						setAccess: async (access) => {
							updates.push(plain(access));
							return { ok: true, value: state };
						},
					},
				},
			},
			"../components/ui-shadcn/button": control("Button"),
			"../components/ui-shadcn/checkbox": control("Checkbox"),
			"../components/ui-shadcn/label": control("Label"),
		},
	});
	const render = () => host.render(() => PiDeckMcpPanel({ existingNames: new Set(), disabled: false, onAdd: async () => true }));
	const nodes = (element) => (Array.isArray(element) ? element.flatMap(nodes) : element?.props ? [element, ...nodes(element.props.children)] : []);
	render();
	await flush();
	const disable = nodes(render()).find((node) => node.props.children === "config.mcp.pideck.disable").props;
	assert.equal(disable.disabled, false);
	disable.onClick();
	await flush();
	assert.deepEqual(updates, [{ enabled: false, projectIds: [] }]);
	host.unmount();
});

test("PiDeck catalog uses dedicated consent panel, native logo and localized controls; no remote management fallback", () => {
	const read = (path) => readFileSync(path, "utf8");
	assert.match(read("src/renderer/src/config/McpTab.tsx"), /selectedTemplateDefinition\?\.id\s*===\s*"pideck"\s*\?\s*\(\s*<PiDeckMcpPanel/);
	// 上游新增 logoStyle 品牌切换（自定义图优先，其次 pi-tui 专属三色标，否则 LogoMark）：契约断言都算「原生 logo」，不把品牌开关误判为回退
	const mcpViews = read("src/renderer/src/config/McpResourceViews.tsx");
	assert.match(mcpViews, /entry\.id\s*===\s*"pideck"\s*&&\s*customLogo\s*\?\s*\(?\s*<img src=\{customLogo\}/, "pideck 目录条目必须优先用自定义品牌图");
	assert.match(mcpViews, /entry\.id\s*===\s*"pideck"\s*&&\s*logoStyle\s*===\s*"pi-tui"\s*\?\s*\(?\s*<PiTuiLogoMark/, "pideck 目录条目在 pi-tui 风格下用官方三色标");
	const preview = read("src/renderer/src/previewApi.ts");
	assert.match(preview, /piDeckMcp:\s*\{[\s\S]*?getState:\s*async\s*\(\)\s*=>\s*\(\{\s*ok:\s*false,\s*code:\s*"desktop-only"/);
	for (const locale of ["zh-CN", "en-US", "zh-TW"]) assert.match(read(`src/renderer/src/i18n/rendererCopy.${locale}.ts`), /"config\.mcp\.pideck\.warning"\s*:/);
});
