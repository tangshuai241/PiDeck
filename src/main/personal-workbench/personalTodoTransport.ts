/**
 * 待办 HTTP transport（P02）：只做网络与 JSON 边界，不做队列/缓存/账号逻辑。
 *
 * 边界与 cloudMemoryClient 一致：
 * - origin 由服务层从已认证身份取出（https 或回环 http 已在连接阶段校验），请求固定 origin + 固定路径，
 *   `redirect: "manual"`（跟随重定向会绕开 origin 校验）；
 * - 响应流式有界：逐块累加字节数，超上限立即 cancel；解码失败/超限都归为固定分类；
 * - 超时、无重试、无排队、无轮询：重试策略由服务层按回执决定；
 * - 错误只暴露固定分类与安全 detail（field/reason/current/item_id），不回显服务端 message。
 *
 * 契约来源：execution/P02/wire-contract.md（前缀 `/api/cloud/personal-todos/v1`）。
 */

import type { PersonalTodo, PersonalTodoErrorCode, PersonalTodoErrorDetail, PersonalTodoOrder } from "../../shared/types/personalTodo";
import { mapWireError, parseWireItemPayload, parseWireListPage, parseWireMutateSuccess, parseWireRequestStatus, type WireListPage, type WireMutateSuccess, type WireRequestStatus } from "./personalTodoWire";

export const PERSONAL_TODO_BASE_PATH = "/api/cloud/personal-todos/v1";
export const PERSONAL_TODO_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type PersonalTodoTransportResponse = {
	status: number;
	text?: () => Promise<string>;
	body?: {
		getReader: () => {
			read: () => Promise<{ done: boolean; value?: Uint8Array }>;
			cancel: () => Promise<void>;
		};
	} | null;
};

export type PersonalTodoFetch = (input: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "manual"; signal: AbortSignal }) => Promise<PersonalTodoTransportResponse>;

export type PersonalTodoLease = { origin: string; token: string };

export type PersonalTodoTransportFailure = {
	code: PersonalTodoErrorCode;
	message: string;
	wireCode: string | null;
	httpStatus: number | null;
	detail?: PersonalTodoErrorDetail;
	conflictCurrent: string | null;
	clientRefItemId: string | null;
};

export type PersonalTodoTransportResult<T> = { ok: true; value: T } | { ok: false; failure: PersonalTodoTransportFailure };

export type PersonalTodoListRequest = {
	lease: PersonalTodoLease;
	cursor: string | null;
	limit: number;
	order: PersonalTodoOrder;
};

export type PersonalTodoGetRequest = { lease: PersonalTodoLease; id: string };
export type PersonalTodoMutateRequest = { lease: PersonalTodoLease; body: Record<string, unknown> };
export type PersonalTodoReceiptRequest = { lease: PersonalTodoLease; requestId: string; operation?: string };
export type PersonalTodoReceiptResult = { state: "applied" | "pending" | "other"; itemId: string | null; subId: string | null; result: WireMutateSuccess | null /** 耐久回执记录的 post-op 整族 revision；旧回执为 null（不可猜）。 */; rootRevisionAfter: string | null; notFound: boolean };

export type PersonalTodoTransport = {
	list(request: PersonalTodoListRequest): Promise<PersonalTodoTransportResult<WireListPage>>;
	get(request: PersonalTodoGetRequest): Promise<PersonalTodoTransportResult<PersonalTodo>>;
	mutate(request: PersonalTodoMutateRequest): Promise<PersonalTodoTransportResult<WireMutateSuccess>>;
	receipt(request: PersonalTodoReceiptRequest): Promise<PersonalTodoTransportResult<PersonalTodoReceiptResult>>;
};

type Outcome = { ok: true; status: number; json: unknown } | { ok: false; failure: PersonalTodoTransportFailure };

function failureFrom(error: PersonalTodoTransportFailure): { ok: false; failure: PersonalTodoTransportFailure } {
	return { ok: false, failure: error };
}

/** 有界读取：超过上限立即 cancel，不把整个 body 读进内存再判长度。 */
async function readBoundedBody(response: PersonalTodoTransportResponse): Promise<string | null> {
	const reader = response.body?.getReader();
	if (!reader) {
		const text = (await response.text?.()) ?? "";
		return Buffer.byteLength(text, "utf8") > PERSONAL_TODO_MAX_RESPONSE_BYTES ? null : text;
	}
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > PERSONAL_TODO_MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

export function createHttpPersonalTodoTransport(deps: { fetchImpl: PersonalTodoFetch; timeoutMs?: number }): PersonalTodoTransport {
	const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;

	async function request(lease: PersonalTodoLease, path: string, init: { method: string; body?: unknown }): Promise<Outcome> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await deps.fetchImpl(`${lease.origin}${PERSONAL_TODO_BASE_PATH}${path}`, {
				method: init.method,
				headers: { "content-type": "application/json", authorization: `Bearer ${lease.token}` },
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				redirect: "manual",
				signal: controller.signal,
			});
			let text: string | null;
			try {
				text = await readBoundedBody(response);
			} catch {
				return failureFrom({ code: "offline", message: "读取云端响应失败", wireCode: null, httpStatus: null, conflictCurrent: null, clientRefItemId: null });
			}
			if (text === null) {
				return failureFrom({ code: "internalError", message: "云端响应超出上限", wireCode: null, httpStatus: response.status, conflictCurrent: null, clientRefItemId: null });
			}
			let json: unknown = null;
			try {
				json = text ? JSON.parse(text) : null;
			} catch {
				json = null;
			}
			if (response.status < 200 || response.status >= 300) {
				const mapped = mapWireError(response.status, json);
				return failureFrom({ code: mapped.code, message: mapped.message, wireCode: mapped.wireCode, httpStatus: response.status, detail: mapped.detail, conflictCurrent: mapped.conflictCurrent, clientRefItemId: mapped.clientRefItemId });
			}
			return { ok: true, status: response.status, json };
		} catch {
			// 超时中止、DNS 失败、连接被拒都归为 offline：可能已生效也可能没发出，服务层按未知处理。
			return failureFrom({ code: "offline", message: "云端不可达", wireCode: null, httpStatus: null, conflictCurrent: null, clientRefItemId: null });
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		async list({ lease, cursor, limit, order }) {
			const params = new URLSearchParams({ view: "roots", include_subtodos: "true", order, limit: String(limit) });
			if (cursor) params.set("cursor", cursor);
			const outcome = await request(lease, `/items?${params.toString()}`, { method: "GET" });
			if (!outcome.ok) return outcome;
			const page = parseWireListPage(outcome.json);
			if (!page) return failureFrom({ code: "internalError", message: "云端列表响应格式不正确", wireCode: null, httpStatus: outcome.status, conflictCurrent: null, clientRefItemId: null });
			return { ok: true, value: page };
		},

		async get({ lease, id }) {
			const outcome = await request(lease, `/items/${encodeURIComponent(id)}`, { method: "GET" });
			if (!outcome.ok) return outcome;
			const item = parseWireItemPayload(outcome.json);
			if (!item) return failureFrom({ code: "internalError", message: "云端单条响应格式不正确", wireCode: null, httpStatus: outcome.status, conflictCurrent: null, clientRefItemId: null });
			return { ok: true, value: item };
		},

		async mutate({ lease, body }) {
			const outcome = await request(lease, "/mutate", { method: "POST", body });
			if (!outcome.ok) return outcome;
			const success = parseWireMutateSuccess(outcome.json);
			if (!success) return failureFrom({ code: "internalError", message: "云端写入响应格式不正确", wireCode: null, httpStatus: outcome.status, conflictCurrent: null, clientRefItemId: null });
			return { ok: true, value: success };
		},

		async receipt({ lease, requestId }) {
			const outcome = await request(lease, `/requests/${encodeURIComponent(requestId)}`, { method: "GET" });
			if (!outcome.ok) {
				const notFound = outcome.failure.httpStatus === 404 || outcome.failure.wireCode === "REQUEST_NOT_FOUND";
				return outcome;
			}
			const status = parseWireRequestStatus(outcome.json);
			if (!status) return failureFrom({ code: "internalError", message: "云端回执响应格式不正确", wireCode: null, httpStatus: outcome.status, conflictCurrent: null, clientRefItemId: null });
			return { ok: true, value: { ...status, notFound: false } satisfies PersonalTodoReceiptResult };
		},
	};
}
