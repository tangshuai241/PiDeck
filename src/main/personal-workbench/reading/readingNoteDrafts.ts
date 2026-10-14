/**
 * 未确认笔记草稿存储（P03）：服务端确认前把「原 operation + 原 requestId」原子落盘。
 *
 * 规则（对应 DeepRead wire 的两阶段 intent→note→ACK）：
 * - 「已保存」只认服务端 `state:"applied"` + note revision；pending/unknown 一律算未确认；
 * - 按服务 origin + user（P03 固定 default）隔离：不同服务的草稿互不可见、互不覆盖；
 * - 草稿身份是 requestId（不是 note）：同一笔记的多份未确认 intent 都保留可查看，
 *   未知结果后改内容再提交不会覆盖旧 intent；只有同载荷同 requestId 才是同一次提交；
 * - 重试必须复用同一 requestId + 完全相同的 payload（服务端按文件 hash 恢复/去重）；
 * - 字段校验失败不清稿；文件损坏先隔离原件再以空状态继续，隔离失败则暂停写入——
 *   任何情况下都不静默丢掉用户输入；落盘失败时内存副本仍保留并上报 issue。
 */

import type { ReadingErrorInfo, ReadingNoteDraft } from "../../../shared/types/reading";
import { handleReadingCorrupt, readReadingJsonBounded, writeReadingJsonAtomic } from "./readingJsonStore";
import { READING_STORE_MAX_BYTES } from "./readingJsonStore";
import type { ReadingPaths } from "./readingPaths";

const DRAFTS_VERSION = 1;

/** 当前读取范围：一个服务 origin 下的一个 user。 */
export type ReadingNoteDraftScope = { origin: string; user: string };

function sameScope(draft: ReadingNoteDraft, scope: ReadingNoteDraftScope): boolean {
	// origin 为空的历史记录视为「未归属」，任何 origin 下都可见（不静默丢输入）
	return draft.user === scope.user && (draft.origin === scope.origin || draft.origin === "");
}

function isDraft(value: unknown): value is ReadingNoteDraft {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.requestId === "string" && typeof record.workId === "string" && typeof record.editionId === "string" && typeof record.op === "string" && typeof record.content === "string" && typeof record.updatedAt === "string" && typeof record.operation === "object" && record.operation !== null;
}

/** 旧记录缺 origin/user 时补默认值（不丢输入，也不把它归给别的 user）。 */
function withDefaults(value: unknown): ReadingNoteDraft | null {
	if (!isDraft(value)) return null;
	const rawOrigin = Reflect.get(value, "origin");
	const origin = typeof rawOrigin === "string" ? rawOrigin : "";
	const rawUser = Reflect.get(value, "user");
	const user = typeof rawUser === "string" ? rawUser : "default";
	return { ...value, origin, user };
}

export class ReadingNoteDraftStore {
	private readonly filePath: string;
	private drafts = new Map<string, ReadingNoteDraft>();
	private loaded = false;
	private issue: ReadingErrorInfo | null = null;

	constructor(paths: ReadingPaths) {
		this.filePath = paths.noteDraftsFile;
	}

	/** 懒加载一次；损坏文件隔离后以空状态继续（issue 通过 list 暴露给界面）。 */
	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		const read = await readReadingJsonBounded(this.filePath, READING_STORE_MAX_BYTES);
		if (read.status === "ok") {
			const raw = read.value as Record<string, unknown>;
			const entries = Array.isArray(raw.drafts) ? raw.drafts : [];
			for (const entry of entries) {
				const draft = withDefaults(entry);
				if (draft) this.drafts.set(draft.requestId, draft);
			}
		} else if (read.status === "issue") {
			const issue = await handleReadingCorrupt(this.filePath, read.code, () => new Date());
			this.issue = { code: read.code === "tooLarge" ? "invalidInput" : "internalError", message: issue.message, detail: { reason: read.code, path: issue.path, quarantine: issue.quarantinePath ?? "", blocked: String(issue.blocked) } };
		}
		this.loaded = true;
	}

	/** 当前 origin/user 下的草稿（含同 user 的历史未归属记录）。 */
	async list(scope: ReadingNoteDraftScope): Promise<{ drafts: ReadingNoteDraft[]; issue: ReadingErrorInfo | null }> {
		await this.ensureLoaded();
		const visible = [...this.drafts.values()].filter((draft) => sameScope(draft, scope));
		return { drafts: visible.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), issue: this.issue };
	}

	async get(requestId: string, scope: ReadingNoteDraftScope): Promise<ReadingNoteDraft | null> {
		await this.ensureLoaded();
		const draft = this.drafts.get(requestId) ?? null;
		return draft && sameScope(draft, scope) ? draft : null;
	}

	/** 同一 note 下「同签名」的未确认草稿（用于幂等复用 requestId）。 */
	async findReusable(scope: ReadingNoteDraftScope, signature: string, signatureOf: (draft: ReadingNoteDraft) => string): Promise<ReadingNoteDraft | null> {
		await this.ensureLoaded();
		const candidates = [...this.drafts.values()].filter((draft) => sameScope(draft, scope) && signatureOf(draft) === signature);
		if (candidates.length === 0) return null;
		return candidates.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
	}

	/** 先落盘再更新内存；落盘失败也保留内存副本（不丢输入），并把 issue 暴露给界面。 */
	async put(draft: ReadingNoteDraft): Promise<{ persisted: boolean; issue: ReadingErrorInfo | null }> {
		await this.ensureLoaded();
		const next = new Map(this.drafts);
		next.set(draft.requestId, draft);
		return this.commit(next);
	}

	async remove(requestId: string): Promise<{ persisted: boolean; issue: ReadingErrorInfo | null }> {
		await this.ensureLoaded();
		const next = new Map(this.drafts);
		next.delete(requestId);
		return this.commit(next);
	}

	private async commit(next: Map<string, ReadingNoteDraft>): Promise<{ persisted: boolean; issue: ReadingErrorInfo | null }> {
		const write = await writeReadingJsonAtomic(this.filePath, { version: DRAFTS_VERSION, drafts: [...next.values()] });
		this.drafts = next;
		if (write.ok) {
			this.issue = null;
			return { persisted: true, issue: null };
		}
		const issue: ReadingErrorInfo = { code: "writeFailed", message: "未确认笔记草稿暂时无法落盘（内存中已保留）", detail: { reason: "noteDraftsWriteFailed" } };
		this.issue = issue;
		return { persisted: false, issue };
	}
}
