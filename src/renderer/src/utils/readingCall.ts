/**
 * 阅读契约调用的兜底（域内安全调用，不是通用架构）。
 *
 * 为什么需要：渲染层所有阅读能力都经 IPC（`ipcRenderer.invoke`）。handler 抛错、主进程重启、
 * 窗口正在关闭时，这个 Promise 会 reject。若调用点直接 await，就会出现两种坏结果：
 * 加载态永远停在 true（用户看到永远转圈），以及未处理的 Promise 拒绝。
 * 这里把拒绝归一成契约里的结构化错误，调用方沿用既有的 `ok/error` 分支收尾即可——
 * 不需要在每个 hook 里各写一遍 try/catch，也不会把失败吞掉（失败仍是可见状态）。
 *
 * 边界：只处理「调用抛错」这一件事；不做重试、不做轮询、不缓存、不改写成功结果。
 */
import type { ReadingErrorInfo } from "../../../shared/types/reading";

/** 兜底文案上界：内部错误文本只用于诊断，不承载服务端原文或凭据。 */
const MAX_MESSAGE_CHARS = 200;

/** 把任意抛出物归一成结构化错误：换行与制表折叠，超长截断，空文本给通用说明。 */
export function readingCallError(error: unknown): ReadingErrorInfo {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const cleaned = raw
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim()
		.slice(0, MAX_MESSAGE_CHARS);
	return { code: "internalError", message: cleaned.length > 0 ? cleaned : "阅读接口调用失败" };
}

/** 成功时原样返回契约结果；拒绝时返回等价形状的 `ok:false`，调用方的错误分支照常生效。 */
export type ReadingCallOutcome<T> = T | { ok: false; error: ReadingErrorInfo };

export async function callReading<T extends { ok: boolean }>(run: () => Promise<T>): Promise<ReadingCallOutcome<T>> {
	try {
		return await run();
	} catch (error) {
		return { ok: false, error: readingCallError(error) };
	}
}
