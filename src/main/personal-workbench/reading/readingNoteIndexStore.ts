/**
 * 笔记注册索引（P03）：把 DeepRead 返回的 noteId/revision 投影到本地，供「只由已登记数据定位」与
 * 离线展示上次已知列表使用；笔记正文主账仍在 DeepRead，本模块不缓存也不改写正文。
 *
 * 文件：`<userData>/personal-workbench/reading/notes-index/<workId>.json`
 * 形状：`{version:1, workId, updatedAt, notes:[ReadingNoteSummary]}`
 * 损坏同位置存储纪律：隔离原件 + 结构化 issue；隔离失败禁止再写。
 */

import type { ReadingNoteSummary } from "../../../shared/types/reading";
import { readingNoteIndexFile, type ReadingPaths } from "./readingPaths";
import type { ReadingStoreIssue } from "./readingJsonStore";
import { handleReadingCorrupt, readReadingJsonBounded, writeReadingJsonAtomic, READING_STORE_MAX_BYTES } from "./readingJsonStore";

export type ReadingNoteIndex = { version: 1; workId: string; updatedAt: string; notes: ReadingNoteSummary[] };

function parseNoteSummary(raw: unknown): ReadingNoteSummary | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record: object = raw;
	const text = (key: string, max: number): string | null => {
		const value = Reflect.get(record, key);
		return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
	};
	const noteId = text("noteId", 128);
	const name = text("name", 512);
	if (!noteId || !name) return null;
	const chapterLabel = text("chapterLabel", 512);
	const linkStatusRaw = Reflect.get(record, "linkStatus");
	return {
		noteId,
		source: "deepread",
		name,
		chapterLabel,
		revision: text("revision", 128),
		updatedAt: text("updatedAt", 64),
		unlocated: Reflect.get(record, "unlocated") === true || chapterLabel === null,
		linkStatus: linkStatusRaw === "linked" || linkStatusRaw === "pending" ? linkStatusRaw : null,
	};
}

export function parseNoteIndex(raw: unknown): ReadingNoteIndex | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record: object = raw;
	const workIdRaw = Reflect.get(record, "workId");
	const updatedAtRaw = Reflect.get(record, "updatedAt");
	if (typeof workIdRaw !== "string" || !workIdRaw || workIdRaw.length > 128) return null;
	if (typeof updatedAtRaw !== "string" || !updatedAtRaw) return null;
	const rawNotes = Reflect.get(record, "notes");
	const notes: ReadingNoteSummary[] = [];
	if (Array.isArray(rawNotes)) {
		for (const entry of rawNotes) {
			const note = parseNoteSummary(entry);
			if (note) notes.push(note);
		}
	}
	return { version: 1, workId: workIdRaw, updatedAt: updatedAtRaw, notes };
}

export type ReadingNoteIndexStoreDeps = { paths: ReadingPaths; now?: () => Date; maxBytes?: number; log?: (message: string, details?: Record<string, unknown>) => void };

export class ReadingNoteIndexStore {
	private readonly deps: ReadingNoteIndexStoreDeps;
	private readonly blocked = new Set<string>();

	constructor(deps: ReadingNoteIndexStoreDeps) {
		this.deps = deps;
	}

	async load(workId: string): Promise<{ value: ReadingNoteIndex | null; issue: ReadingStoreIssue | null }> {
		const filePath = readingNoteIndexFile(this.deps.paths, workId);
		const outcome = await readReadingJsonBounded(filePath, this.deps.maxBytes ?? READING_STORE_MAX_BYTES);
		if (outcome.status === "missing") return { value: null, issue: null };
		if (outcome.status === "issue") {
			const issue = await handleReadingCorrupt(filePath, outcome.code, this.deps.now ?? (() => new Date()));
			if (issue.blocked) this.blocked.add(filePath);
			return { value: null, issue };
		}
		const value = parseNoteIndex(outcome.value);
		if (!value) {
			const issue = await handleReadingCorrupt(filePath, "invalidStructure", this.deps.now ?? (() => new Date()));
			if (issue.blocked) this.blocked.add(filePath);
			return { value: null, issue };
		}
		return { value, issue: null };
	}

	async save(index: ReadingNoteIndex): Promise<{ ok: true } | { ok: false; reason: "writeFailed" | "blocked" }> {
		const filePath = readingNoteIndexFile(this.deps.paths, index.workId);
		if (this.blocked.has(filePath)) return { ok: false, reason: "blocked" };
		const written = await writeReadingJsonAtomic(filePath, index);
		return written.ok ? { ok: true } : { ok: false, reason: "writeFailed" };
	}

	/** 该 workId 下已登记 noteId；写 update/append 前用它把关「只由已登记数据定位」。 */
	async hasNote(workId: string, noteId: string): Promise<boolean> {
		const loaded = await this.load(workId);
		return loaded.value?.notes.some((note) => note.noteId === noteId) ?? false;
	}

	async getNote(workId: string, noteId: string): Promise<ReadingNoteSummary | null> {
		const loaded = await this.load(workId);
		return loaded.value?.notes.find((note) => note.noteId === noteId) ?? null;
	}

	async upsert(workId: string, note: ReadingNoteSummary, nowIso: string): Promise<{ ok: true } | { ok: false; reason: "writeFailed" | "blocked" }> {
		const loaded = await this.load(workId);
		const notes = [...(loaded.value?.notes ?? [])];
		const index = notes.findIndex((entry) => entry.noteId === note.noteId);
		if (index >= 0) notes[index] = note;
		else notes.push(note);
		return this.save({ version: 1, workId, updatedAt: nowIso, notes });
	}

	async replaceAll(workId: string, notes: ReadingNoteSummary[], nowIso: string): Promise<{ ok: true } | { ok: false; reason: "writeFailed" | "blocked" }> {
		return this.save({ version: 1, workId, updatedAt: nowIso, notes });
	}
}
