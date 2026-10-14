/**
 * 阅读 HTTP 客户端共享类型（P03）：请求/响应形状与结果分类。
 *
 * 独立成文件的原因：wire 适配与服务都依赖这些形状，但客户端本身不解析业务字段
 * （snake_case→camelCase 只在 readingWire）。
 */

import type { ReadingErrorInfo, ReadingHistorySourceName } from "../../../shared/types/reading";

export type ReadingWireFeature = "notes" | "history" | null;

export type ReadingHttpResponse = {
	status: number;
	text?: () => Promise<string>;
	headers?: { get: (name: string) => string | null };
	body?: {
		getReader: () => {
			read: () => Promise<{ done: boolean; value?: Uint8Array }>;
			cancel: () => Promise<void>;
		};
	} | null;
};

export type ReadingFetch = (input: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "manual"; signal: AbortSignal }) => Promise<ReadingHttpResponse>;

export type ReadingHttpSuccess = { ok: true; status: number; json: unknown; text: string; setCookie: string | null };

export type ReadingHttpResult = ReadingHttpSuccess | { ok: false; status: number | null; error: ReadingErrorInfo };

export type ReadingHistoryPageQuery = { source: ReadingHistorySourceName; cursor: string | null; limit: number };

export type ReadingRequestOptions = { feature?: ReadingWireFeature; maxBytes?: number };
