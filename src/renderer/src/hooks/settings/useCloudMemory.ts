/**
 * 云端记忆设置域状态（设置 → 云端记忆 tab 的唯一 owner）。
 *
 * 边界：
 * - 只经 desktopApi.cloudMemory 访问桌面能力，不 import Node/Electron；
 * - 密码只存在于组件本地 state，提交后不在渲染层保存、不回填（主进程只回 hint）；
 * - 所有动作以后端返回的 status 为准（后端是状态真源），失败保留上一次 status 并给错误原因。
 */

import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../../desktopApi";
import type { CloudMemoryConnectInput, CloudMemoryErrorInfo, CloudMemoryStatus } from "../../../../shared/types/cloudMemory";

export type CloudMemoryBusyAction = "connect" | "logout" | "toggle" | "sync-toggle" | "refresh";

export function useCloudMemory() {
	const [status, setStatus] = useState<CloudMemoryStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<CloudMemoryBusyAction | null>(null);
	const [error, setError] = useState<CloudMemoryErrorInfo | null>(null);

	const refresh = useCallback(async () => {
		try {
			const result = await desktopApi.cloudMemory.getStatus();
			if (result.ok) {
				setStatus(result.status);
				setError(null);
			} else {
				setError(result.error);
			}
		} catch {
			setError({ code: "internalError", message: "无法读取云端记忆状态" });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// 主进程推送（连接完成后的后台人格刷新、原生状态、登出等）→ 重拉状态；
	// 卸载即退订（preload 返回 unsubscribe），不在渲染层猜状态。
	useEffect(() => {
		const unsubscribe = desktopApi.cloudMemory.onStatusChanged(() => {
			void refresh();
		});
		return unsubscribe;
	}, [refresh]);

	// 兜底轮询：只在设置页挂载期间跑，4s 一次只读主进程快照（getStatus 不发网络请求）；
	// in-flight 防重叠、卸载清理；静默更新状态、不清掉最近一次动作的错误提示。
	useEffect(() => {
		let disposed = false;
		let inFlight = false;
		const timer = setInterval(() => {
			if (inFlight || disposed) return;
			inFlight = true;
			void desktopApi.cloudMemory
				.getStatus()
				.then((result) => {
					if (!disposed && result.ok) setStatus(result.status);
				})
				.catch(() => undefined)
				.finally(() => {
					inFlight = false;
				});
		}, 4000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, []);

	/** 统一动作包装：只把 ok=true 的 status 写回；失败时保留错误并重拉一次后端状态（不留下「伪 connected」的旧状态）。 */
	const run = useCallback(async (action: CloudMemoryBusyAction, task: () => Promise<{ ok: true; status: CloudMemoryStatus } | { ok: false; error: CloudMemoryErrorInfo }>) => {
		setBusy(action);
		try {
			const result = await task();
			if (result.ok) {
				setStatus(result.status);
				setError(null);
			} else {
				setError(result.error);
				// 动作可能已部分生效（如已保存凭据但投影写失败）：以后端状态为准，但保留上面的错误提示
				try {
					const latest = await desktopApi.cloudMemory.getStatus();
					if (latest.ok) setStatus(latest.status);
				} catch {
					// 状态重拉失败不影响错误提示
				}
			}
			return result;
		} catch {
			const failure: CloudMemoryErrorInfo = { code: "internalError", message: "操作失败" };
			setError(failure);
			return { ok: false as const, error: failure };
		} finally {
			setBusy(null);
		}
	}, []);

	return {
		status,
		loading,
		busy,
		error,
		refresh,
		connect: useCallback((input: CloudMemoryConnectInput) => run("connect", () => desktopApi.cloudMemory.connect(input)), [run]),
		logout: useCallback(() => run("logout", () => desktopApi.cloudMemory.logout()), [run]),
		setEnabled: useCallback((enabled: boolean) => run("toggle", () => desktopApi.cloudMemory.setEnabled(enabled)), [run]),
		setSyncEnabled: useCallback((syncEnabled: boolean) => run("sync-toggle", () => desktopApi.cloudMemory.setSyncEnabled(syncEnabled)), [run]),
		refreshPersona: useCallback(() => run("refresh", () => desktopApi.cloudMemory.refreshPersona()), [run]),
		clearError: useCallback(() => setError(null), []),
	};
}
