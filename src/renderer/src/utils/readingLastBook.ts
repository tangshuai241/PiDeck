/** 阅读选择缓存只保存版本身份，按服务地址隔离；正文与位置仍由既有主进程接口管理。 */
export type ReadingLastBook = { workId: string; editionId: string };
export type ReadingSelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage 被禁用时安静降级，不能影响阅读和普通聊天。 */
function resolveStorage(storage?: ReadingSelectionStorage): ReadingSelectionStorage | null {
	try {
		return storage ?? (typeof window === "undefined" ? null : window.localStorage);
	} catch {
		return null;
	}
}

/** 读取有界且验证过的选择；损坏缓存不构造书籍身份。 */
export function readReadingLastBook(baseUrl: string, storage?: Pick<Storage, "getItem">): ReadingLastBook | null {
	try {
		const target = storage ?? resolveStorage();
		const raw = target?.getItem(`pideck:reading-last-book:${baseUrl}`);
		if (!raw || raw.length > 4096) return null;
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || !("workId" in value) || !("editionId" in value)) return null;
		const { workId, editionId } = value;
		const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256 && !/[\s\u0000-\u001f]/.test(id);
		return validId(workId) && validId(editionId) ? { workId, editionId } : null;
	} catch {
		return null;
	}
}

/** 用户选择后存身份，清选择时移除；没有服务地址时不写跨服务的全局缓存。 */
export function writeReadingLastBook(baseUrl: string | null, book: ReadingLastBook | null, storage?: ReadingSelectionStorage): void {
	if (!baseUrl) return;
	try {
		const target = resolveStorage(storage);
		const key = `pideck:reading-last-book:${baseUrl}`;
		if (book === null) target?.removeItem(key);
		else target?.setItem(key, JSON.stringify(book));
	} catch {
		// 选择缓存失败只影响下一次自动恢复，当前阅读仍继续。
	}
}
