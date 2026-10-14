/**
 * 「作品版本 → Pi 会话」绑定 controller（P04 hook）。
 *
 * 职责边界：
 * - 绑定读写全部经 IPC（主进程 `reading:*-binding`），渲染层不碰会话文件、不自行决定会话是否存在；
 * - 作用域（workId+editionId）切换时旧请求的迟到结果一律丢弃（scope epoch 守卫），
 *   不把 A 书的绑定写进当前 B 书的界面状态；
 * - stale（绑定还在但会话已不在）不静默新建/替换：控制器只如实回报，由界面提示用户显式重绑；
 * - 不创建会话：新建会话仍走既有 catalog/create 与 runtimeCoordinator 路径（在界面层完成后再 bind）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi as api } from "../desktopApi";
import type { ReadingBindingRef, ReadingBindingResolveReason, ReadingErrorInfo, ReadingSessionBinding } from "../../../shared/types/reading";

export type ReadingSessionBindingState = {
	loading: boolean;
	binding: ReadingSessionBinding | null;
	sessionExists: boolean;
	stale: boolean;
	reason: ReadingBindingResolveReason | null;
	error: ReadingErrorInfo | null;
};

export type ReadingBindingBindResult = { ok: true; binding: ReadingSessionBinding } | { ok: false; error: ReadingErrorInfo };
export type ReadingBindingUnbindResult = { ok: true; removed: boolean } | { ok: false; error: ReadingErrorInfo };

export type ReadingSessionBindingController = {
	state: ReadingSessionBindingState;
	refresh: () => Promise<void>;
	/** 显式绑定/重绑：ref 缺省用当前作用域；会话存在性由主进程校验。 */
	bind: (input: { sessionId: string; projectId: string; ref?: ReadingBindingRef }) => Promise<ReadingBindingBindResult>;
	/** 解绑：只删绑定关系，不清会话内容/草稿。 */
	unbind: (ref?: ReadingBindingRef) => Promise<ReadingBindingUnbindResult>;
};

const IDLE: ReadingSessionBindingState = { loading: false, binding: null, sessionExists: false, stale: false, reason: null, error: null };

function scopeKey(ref: ReadingBindingRef | null | undefined): string {
	return ref ? `${ref.workId}\u0000${ref.editionId}` : "";
}

/** IPC 拒绝（主进程重启/窗口关闭）归一成结构化错误：不吞掉失败、不假装成功。 */
function bindingCallError(error: unknown): ReadingErrorInfo {
	const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const cleaned = raw
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim()
		.slice(0, 200);
	return { code: "internalError", message: cleaned.length > 0 ? cleaned : "阅读绑定接口调用失败" };
}

export function useReadingSessionBinding(scope: ReadingBindingRef | null): ReadingSessionBindingController {
	const [state, setState] = useState<ReadingSessionBindingState>(IDLE);
	// 最新作用域与 epoch：所有异步回包只在两者都与发起时一致时应用。
	const scopeRef = useRef<ReadingBindingRef | null>(scope);
	scopeRef.current = scope;
	const epochRef = useRef(0);
	const key = scopeKey(scope);

	const load = useCallback(async (target: ReadingBindingRef) => {
		const epoch = ++epochRef.current;
		setState({ ...IDLE, loading: true });
		let outcome: Awaited<ReturnType<typeof api.reading.resolveBinding>>;
		try {
			outcome = await api.reading.resolveBinding(target);
		} catch (error) {
			outcome = { ok: false, error: bindingCallError(error) };
		}
		// 迟到丢弃：作用域已切换或又有更新的请求时，本次结果不写状态。
		if (epoch !== epochRef.current || scopeKey(scopeRef.current) !== scopeKey(target)) return;
		if (!outcome.ok) {
			setState({ ...IDLE, error: outcome.error });
			return;
		}
		setState({ loading: false, binding: outcome.binding, sessionExists: outcome.sessionExists, stale: outcome.stale, reason: outcome.reason, error: null });
	}, []);

	const refresh = useCallback(async () => {
		const target = scopeRef.current;
		if (!target) {
			epochRef.current += 1;
			setState(IDLE);
			return;
		}
		await load(target);
	}, [load]);

	// 作用域变化 → 重新解析；旧请求的回包由 epoch/scope 守卫丢弃。
	useEffect(() => {
		void refresh();
	}, [key, refresh]);

	const bind = useCallback(async (input: { sessionId: string; projectId: string; ref?: ReadingBindingRef }): Promise<ReadingBindingBindResult> => {
		const target = input.ref ?? scopeRef.current;
		if (!target) return { ok: false, error: { code: "invalidInput", message: "当前没有可绑定的阅读版本", detail: { field: "editionId" } } };
		const epoch = ++epochRef.current;
		try {
			const outcome = await api.reading.bindSession({ workId: target.workId, editionId: target.editionId, sessionId: input.sessionId, projectId: input.projectId });
			if (epoch === epochRef.current && scopeKey(scopeRef.current) === scopeKey(target)) {
				if (outcome.ok) setState({ loading: false, binding: outcome.binding, sessionExists: true, stale: false, reason: "none", error: null });
				else setState((prev) => ({ ...prev, loading: false, error: outcome.error }));
			}
			return outcome;
		} catch (error) {
			const normalized = bindingCallError(error);
			if (epoch === epochRef.current && scopeKey(scopeRef.current) === scopeKey(target)) setState((prev) => ({ ...prev, loading: false, error: normalized }));
			return { ok: false, error: normalized };
		}
	}, []);

	const unbind = useCallback(async (ref?: ReadingBindingRef): Promise<ReadingBindingUnbindResult> => {
		const target = ref ?? scopeRef.current;
		if (!target) return { ok: false, error: { code: "invalidInput", message: "当前没有可解绑的阅读版本", detail: { field: "editionId" } } };
		const epoch = ++epochRef.current;
		try {
			const outcome = await api.reading.unbindSession(target);
			if (epoch === epochRef.current && scopeKey(scopeRef.current) === scopeKey(target)) {
				if (outcome.ok) setState({ ...IDLE, reason: "missing" });
				else setState((prev) => ({ ...prev, loading: false, error: outcome.error }));
			}
			return outcome;
		} catch (error) {
			const normalized = bindingCallError(error);
			if (epoch === epochRef.current && scopeKey(scopeRef.current) === scopeKey(target)) setState((prev) => ({ ...prev, loading: false, error: normalized }));
			return { ok: false, error: normalized };
		}
	}, []);

	return { state, refresh, bind, unbind };
}
