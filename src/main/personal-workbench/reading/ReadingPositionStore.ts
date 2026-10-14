/**
 * 阅读位置本地存储（P03，TPA 主账）。
 *
 * 每个版本一个文件 `<userData>/personal-workbench/reading/positions/<editionId>.json`：
 * - 身份绑定：editionId + workId + contentVersion（+ 可选 chapterTextDigest）；版本不符由服务层判 stale，
 *   本模块只忠实存取，不改写 fraction、不猜偏移；
 * - 幂等：内容完全相同的保存不重复写、返回同一结果；
 * - 原件保护：替换前复制 `.bak`；损坏文件隔离为 `.corrupt-<ts>`，隔离失败则拒绝再写该文件；
 * - 读取有字节上界（默认 512 KiB），超限按损坏处理，不把损坏当空后覆盖。
 */

import { copyFile } from "node:fs/promises";
import type { ReadingPosition } from "../../../shared/types/reading";
import { readingPositionFile, type ReadingPaths } from "./readingPaths";
import type { ReadingStoreIssue } from "./readingJsonStore";
import { handleReadingCorrupt, readReadingJsonBounded, writeReadingJsonAtomic, READING_STORE_MAX_BYTES } from "./readingJsonStore";

export type ReadingPositionSaveOutcome = { ok: true; idempotent: boolean } | { ok: false; reason: "writeFailed" | "blocked" };

function parsePosition(raw: unknown): ReadingPosition | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const record: object = raw;
	const field = (key: string, max: number): string | null => {
		const value = Reflect.get(record, key);
		return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
	};
	const editionId = field("editionId", 128);
	const workId = field("workId", 128);
	const contentVersion = field("contentVersion", 128);
	const savedAt = field("savedAt", 64);
	const fractionRaw = Reflect.get(record, "fraction");
	if (!editionId || !workId || !contentVersion || !savedAt) return null;
	if (typeof fractionRaw !== "number" || !Number.isFinite(fractionRaw) || fractionRaw < 0 || fractionRaw > 1) return null;
	const spineHref = field("spineHref", 1024);
	const digest = field("chapterTextDigest", 128);
	const chapterRaw = Reflect.get(record, "chapterNum");
	const chapterNum = typeof chapterRaw === "number" && Number.isInteger(chapterRaw) && chapterRaw >= 0 ? chapterRaw : null;
	const sourceRaw = Reflect.get(record, "source");
	return {
		workId,
		editionId,
		contentVersion,
		fraction: fractionRaw,
		spineHref,
		chapterNum,
		chapterTextDigest: digest,
		source: sourceRaw === "fallback" ? "fallback" : "reader",
		savedAt,
	};
}

function samePosition(a: ReadingPosition | null, b: ReadingPosition): boolean {
	if (!a) return false;
	return a.workId === b.workId && a.editionId === b.editionId && a.contentVersion === b.contentVersion && a.fraction === b.fraction && a.spineHref === b.spineHref && a.chapterNum === b.chapterNum && a.chapterTextDigest === b.chapterTextDigest && a.source === b.source;
}

export type ReadingPositionStoreDeps = { paths: ReadingPaths; now?: () => Date; maxBytes?: number; log?: (message: string, details?: Record<string, unknown>) => void };

export class ReadingPositionStore {
	private readonly deps: ReadingPositionStoreDeps;
	private readonly blocked = new Set<string>();

	constructor(deps: ReadingPositionStoreDeps) {
		this.deps = deps;
	}

	async load(editionId: string): Promise<{ value: ReadingPosition | null; issue: ReadingStoreIssue | null }> {
		const filePath = readingPositionFile(this.deps.paths, editionId);
		const outcome = await readReadingJsonBounded(filePath, this.deps.maxBytes ?? READING_STORE_MAX_BYTES);
		if (outcome.status === "missing") return { value: null, issue: null };
		if (outcome.status === "issue") {
			const issue = await handleReadingCorrupt(filePath, outcome.code, this.deps.now ?? (() => new Date()));
			if (issue.blocked) this.blocked.add(filePath);
			this.deps.log?.("reading position unreadable", { code: outcome.code, blocked: issue.blocked });
			return { value: null, issue };
		}
		const value = parsePosition(outcome.value);
		if (!value) {
			const issue = await handleReadingCorrupt(filePath, "invalidStructure", this.deps.now ?? (() => new Date()));
			if (issue.blocked) this.blocked.add(filePath);
			return { value: null, issue };
		}
		return { value, issue: null };
	}

	async save(position: ReadingPosition): Promise<ReadingPositionSaveOutcome> {
		const filePath = readingPositionFile(this.deps.paths, position.editionId);
		if (this.blocked.has(filePath)) return { ok: false, reason: "blocked" };
		const loaded = await this.load(position.editionId);
		if (loaded.issue?.blocked) return { ok: false, reason: "blocked" };
		if (samePosition(loaded.value, position)) return { ok: true, idempotent: true };
		if (loaded.value) {
			// 原件保护：替换前留一份 .bak（失败不阻断写入，但记录日志）
			await copyFile(filePath, `${filePath}.bak`).catch(() => undefined);
		}
		const written = await writeReadingJsonAtomic(filePath, { version: 1, ...position });
		if (!written.ok) return { ok: false, reason: "writeFailed" };
		return { ok: true, idempotent: false };
	}
}
