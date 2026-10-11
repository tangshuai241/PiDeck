import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
const customType = "pi-deck-alignment-state";
const state = { schemaVersion: 1, briefId: "brief", revision: 1, phase: "ready", brief: { goal: "goal", scope: [], materials: [], deliverable: "report", preserve: [], acceptance: ["verified"], questions: [] } };
const entry = (id, parentId, alignment = state) => ({ type: "custom_message", id, parentId, customType, display: false, content: "", details: { alignment } });
const message = (id, parentId, role = "user") => ({ type: "message", id, parentId, message: { role, content: id } });

/** Exercise the real index and targeted file reads, with no pi process. */
async function fixture(run) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-alignment-"));
	const path = join(directory, "session.jsonl");
	const reader = new SessionHistoryReader({ toHostPath: (value) => value, convertMessages: (_agent, messages) => messages, trimMessages: (messages) => messages, translate: () => "summary" });
	const write = (entries) => writeFile(path, `${entries.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n")}\n`);
	try {
		await run({ reader, path, write });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("alignment history restores state outside the visible message window without consuming message indexes", () =>
	fixture(async ({ reader, path, write }) => {
		const entries = [{ type: "session", id: "session" }, entry("alignment", "session")];
		let parent = "alignment";
		for (let index = 0; index < 100; index++) {
			entries.push(message(`m${index}`, parent, index % 2 === 0 ? "user" : "assistant"));
			parent = `m${index}`;
		}
		await write(entries);
		assert.equal((await reader.readAlignmentState(path)).briefId, "brief");
		assert.equal(await reader.getActiveEntryCount(path), 100);
		assert.equal((await reader.getRecentActiveEntryIds(path, 2)).join(","), "m98,m99");
		assert.ok(!(await reader.readRecentMessages(path, 3)).data.messages.some((item) => item.customType === customType));
	}));

test("alignment history follows the leaf parent chain and excludes abandoned forks", () =>
	fixture(async ({ reader, path, write }) => {
		await write([{ type: "session", id: "session" }, entry("base", "session"), entry("abandoned", "base", { ...state, briefId: "abandoned" }), message("leaf", "base")]);
		assert.equal((await reader.readAlignmentState(path)).briefId, "brief");
		await appendFile(path, `${JSON.stringify(entry("new", "leaf", { ...state, briefId: "new" }))}\n`);
		assert.equal((await reader.readAlignmentState(path)).briefId, "new");
	}));

for (const [name, latest] of [
	["malformed", { phase: "ready" }],
	["future", { ...state, schemaVersion: 2 }],
	["clear", null],
]) {
	test(`alignment history ${name} latest snapshot clears instead of reviving older state`, () =>
		fixture(async ({ reader, path, write }) => {
			await write([{ type: "session", id: "session" }, entry("old", "session"), entry("latest", "old", latest)]);
			assert.equal(await reader.readAlignmentState(path), null);
		}));
}

test("alignment history reads only the latest matching bounded line after index metadata filtering", () =>
	fixture(async ({ reader, path, write }) => {
		await write([{ type: "session", id: "session" }, entry("old", "session"), { ...entry("other", "old"), customType: "another-extension", content: "x".repeat(500000) }, entry("latest", "other", { ...state, revision: 2 })]);
		await reader.getActiveEntryCount(path);
		const original = reader.readIndexedRawLines.bind(reader);
		const reads = [];
		reader.readIndexedRawLines = (host, entries) => {
			reads.push(entries.map((item) => item.id));
			return original(host, entries);
		};
		assert.equal((await reader.readAlignmentState(path)).revision, 2);
		assert.deepEqual(
			reads.map((ids) => [...ids]),
			[["latest"]],
		);
	}));

test("alignment history rejects oversized latest state without reading its body or reviving older state", () =>
	fixture(async ({ reader, path, write }) => {
		await write([{ type: "session", id: "session" }, entry("old", "session"), { ...entry("huge", "old"), content: "x".repeat(300000) }]);
		await reader.getActiveEntryCount(path);
		reader.readIndexedRawLines = () => {
			throw new Error("oversized state must not be reread");
		};
		assert.equal(await reader.readAlignmentState(path), null);
	}));

test("alignment history retains a malformed latest alignment line as a fail-closed branch barrier", () =>
	fixture(async ({ reader, path, write }) => {
		await write([{ type: "session", id: "session" }, entry("old", "session"), '{"type":"custom_message","id":"broken","parentId":"old","customType":"pi-deck-alignment-state","details":', message("leaf", "broken")]);
		assert.equal(await reader.readAlignmentState(path), null);
		assert.equal(await reader.getActiveEntryCount(path), 1);
	}));
