/**
 * 改稿意图链路与内置扩展登记。
 *
 * 意图来源是扩展声明的，但授权仍是那一轮真实用户指令：主进程重新核对最新用户轮的
 * 正文指纹，指纹不符或同一轮重放都不会启动第二轮。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const { createDocumentWorkDomain, parseRevisionIntent } = loadTsCommonJs(`${ROOT}/src/main/document-work/index.ts`);
const { decodeBindingPayload } = loadTsCommonJs(`${ROOT}/src/shared/documentWork.ts`);
const { BUILT_IN_EXTENSIONS, isBuiltInExtensionName } = loadTsCommonJs(`${ROOT}/src/main/extensions/builtInExtensions.ts`);

const SESSION_ID = "session-a";
const AGENT_ID = "agent-a";
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function waitFor(predicate, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const tick = () => {
			if (predicate()) return resolve(true);
			if (Date.now() > deadline) return resolve(false);
			setTimeout(tick, 10);
		};
		tick();
	});
}

/** 复用服务测试的最小运行时端口：只实现文稿域真正调用的四个能力。 */
function createDomain(input) {
	const listeners = { pi: new Set() };
	const runtime = {
		status: "idle",
		flags: {},
		generation: 1,
		messages: [{ id: "turn-1", role: "user", text: "把标题改短一点", agentId: AGENT_ID, timestamp: 1 }],
		dispatched: [],
	};
	const port = {
		readRuntime: async (sessionId) => (sessionId === SESSION_ID ? { target: { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: runtime.generation }, status: runtime.status, state: { ...runtime.flags }, messages: runtime.messages } : undefined),
		dispatch: async (input) => {
			runtime.dispatched.push(input.message);
			return { accepted: true, unknown: false };
		},
		abort: async () => ({ accepted: true, unknown: false }),
		hasDispatchInFlight: () => false,
		subscribeOutputs: () => () => {},
		subscribePiEvents: (listener) => {
			listeners.pi.add(listener);
			return () => listeners.pi.delete(listener);
		},
	};
	const domain = createDocumentWorkDomain({
		userDataPath: input.userDataPath,
		runtimePort: port,
		materials: { isAllowed: async () => false },
		onChanged: () => {},
		logger: { info: () => {}, warn: () => {} },
		bindTimeoutMs: 300,
		startTimeoutMs: 200,
		settleTimeoutMs: 200,
	});
	return {
		domain,
		runtime,
		emitIntent: (intent) => {
			for (const listener of listeners.pi) listener(AGENT_ID, { type: "message_end", sessionId: SESSION_ID, message: { role: "custom", customType: "pi-deck-document-revision-intent", details: { documentWorkIntent: intent } } });
		},
	};
}

test("改稿意图只在最新用户轮指纹匹配时准备并绑定；指纹不符或重放都不启动", async () => {
	const rootDir = mkdtempSync(join(tmpdir(), "pideck-docwork-intent-"));
	const outputRoot = join(rootDir, "out");
	mkdirSync(outputRoot, { recursive: true });
	const { domain, runtime, emitIntent } = createDomain({ userDataPath: join(rootDir, "userData") });
	try {
		const root = await domain.store.registerOutputRoot(outputRoot, "文稿");
		const created = await domain.service.createWork({ requestId: "req-create", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: "季度报告" });
		assert.equal(created.ok, true);
		const workId = created.value.workId;

		// 造一个「已归档且检查通过」的版本：直接写版本记录 + 公开文件，避免重复驱动完整归档。
		const workFolder = readdirSync(outputRoot).find((name) => name.startsWith("dw_"));
		const versionDirectory = join(outputRoot, workFolder, "versions", "v0001");
		mkdirSync(versionDirectory, { recursive: true });
		const body = "# 季度报告\n\n正文\n";
		writeFileSync(join(versionDirectory, "out.md"), body, "utf8");
		await domain.store.saveVersion({
			schemaVersion: 1,
			versionId: "v_seed",
			ordinal: 1,
			workId,
			kind: "create_document",
			title: "季度报告",
			directory: "v0001",
			artifacts: [{ relativePath: "out.md", role: "primary", digest: sha256(body), bytes: Buffer.byteLength(body) }],
			snapshotDirectory: join(domain.artifacts.directory, "snapshots", workId, "v_seed"),
			modelRisks: [],
			userAcceptance: "not_collected",
			inspection: {
				schemaVersion: 1,
				inspectionId: "ins_1",
				versionId: "v_seed",
				status: "passed",
				items: [{ id: "file_readable", status: "passed" }],
				coverage: { format: "markdown", bytesRead: 10, bytesTotal: 10, textDigest: sha256(body), formatDigest: sha256(body), truncated: false },
				byteBudget: 1024,
				durationMs: 1,
				inspectorVersion: "markdown-1",
				createdAt: 1,
			},
			createdAt: 1,
		});
		const withVersion = await domain.store.mutateRecord(workId, created.value.revision, (current) => ({ ...current, versionIds: ["v_seed"] }));
		assert.equal(withVersion.ok, true);
		const view = plain((await domain.service.getView(workId, SESSION_ID)).value);
		assert.equal(view.revisionReady, true);

		const intent = { workId, instruction: "把标题改短", sections: [], preserve: [], sourceTurnId: "turn-1", sourceTurnHash: sha256(runtime.messages[0].text) };

		// 指纹不符：不准备，也不分发。
		emitIntent({ ...intent, sourceTurnHash: "b".repeat(64) });
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(runtime.dispatched.length, 0, "指纹不符的意图不得启动制作");

		// 匹配：绑定载荷必须带本轮准备身份，且不重复分发对齐批准。
		emitIntent(intent);
		const bound = await waitFor(() => runtime.dispatched.some((message) => message.startsWith("/tpa-work bind ")));
		assert.equal(bound, true, "匹配的意图必须绑定本轮准备");
		const bind = runtime.dispatched.find((message) => message.startsWith("/tpa-work bind "));
		const payload = decodeBindingPayload(bind.slice("/tpa-work bind ".length));
		assert.equal(payload.kind, "revise_document");
		assert.equal(payload.base.versionId, "v_seed", "改稿必须冻结实际基稿");
		assert.match(payload.base.path, /v0001/, "冻结副本来自公开版本目录");
		assert.equal(
			runtime.dispatched.some((message) => message.startsWith("/align approve")),
			false,
			"改稿轮不得分发对齐批准",
		);

		// 同一轮指令重放不产生第二轮。
		const before = runtime.dispatched.length;
		emitIntent(intent);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(runtime.dispatched.length, before, "同一轮指令不得重复授权");
	} finally {
		await domain.dispose();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("意图解析拒绝缺字段、越界与伪造指纹", () => {
	const base = { workId: "dw_1", instruction: "改标题", sections: [], preserve: [], sourceTurnId: "turn-1", sourceTurnHash: "a".repeat(64) };
	assert.equal(parseRevisionIntent(base)?.instruction, "改标题");
	assert.equal(parseRevisionIntent({ ...base, workId: "../x" }), undefined);
	assert.equal(parseRevisionIntent({ ...base, instruction: "" }), undefined);
	assert.equal(parseRevisionIntent({ ...base, sourceTurnHash: "zz" }), undefined);
	assert.equal(parseRevisionIntent({ ...base, sections: Array.from({ length: 25 }, () => "s") }), undefined);
});

test("两个文稿扩展都登记为内置扩展，并出现在资源清单里", () => {
	for (const name of ["pi-deck-document-work.ts", "pi-deck-document-materials.ts"]) {
		assert.equal(isBuiltInExtensionName(name), true, name);
		assert.equal(plain(BUILT_IN_EXTENSIONS).includes(name), true, name);
	}
	const manifest = JSON.parse(readFileSync(join(ROOT, "resources/extensions/extensions-manifest.json"), "utf8"));
	const names = manifest.files.map((file) => file.name);
	// 扩展内部相对 import 的镜像文件也必须随包分发，否则 jiti 解析失败。
	for (const name of ["pi-deck-document-work.ts", "pi-deck-document-materials.ts", "pi-deck-document-work-types.ts"]) {
		assert.equal(names.includes(name), true, `${name} 必须在资源清单中`);
	}
	const record = manifest.files.find((file) => file.name === "pi-deck-document-work.ts");
	const bytes = readFileSync(join(ROOT, "resources/extensions/pi-deck-document-work.ts"));
	assert.equal(record.bytes, bytes.byteLength);
	assert.equal(record.sha256, createHash("sha256").update(bytes).digest("hex"), "清单指纹必须与磁盘一致");
	assert.equal(manifest.fileCount, manifest.files.length);
});
