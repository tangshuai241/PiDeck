/**
 * 会话列 + 个人工作台页面容器的组合体（App 只挂这一处）。
 *
 * 为什么需要一个组合组件而不是在 App 里并排写两层：
 * - 被功能页盖住时，会话列必须置 `inert` + `aria-hidden`：否则 Tab 仍能进被遮的 composer/控件，
 *   用户会往看不见的输入框里打字（与会话内折叠面板同款处理，见 SessionView 的底部输入栏）。
 *   inert 只隔离交互，不卸载任何东西——草稿、滚动位置、终端与正在进行的流式回复都原样保留。
 * - 焦点交接需要同时知道「被遮会话列容器」「页面容器里的返回按钮」和「会话内最后被聚焦的元素」
 *   （通常是 composer），放在同一个组件里才能保证顺序：先记下开页前焦点，再抢到返回按钮。
 *
 * 只服务个人工作台页面：页面式插件面板的 inert 不在本次修正范围（既有行为保持原样）。
 *
 * z-index 约定：功能页 20 < 页面式插件页 30，只作防御性排序；两者由互斥规则保证不会同时呈现。
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { personalWorkbenchPageAtom } from "../../atoms/personal-workbench-atoms";
import { PersonalWorkbenchPageOverlay } from "./PersonalWorkbenchPageOverlay";

export function PersonalWorkbenchStage(props: {
	/** 会话列内容（`chatPaneSessionNode`），页面打开时整体置 inert */
	children: ReactNode;
	projectId?: string;
	sessionId?: string;
	onRestoreSession?: (projectId: string, sessionId: string) => void | Promise<void>;
}) {
	const pageOpen = useAtomValue(personalWorkbenchPageAtom) !== null;
	const sessionHostRef = useRef<HTMLElement | null>(null);
	// 会话内最后被聚焦的元素（打字现场：composer、时间线里的按钮…）。覆盖层打开期间会话列是
	// inert，焦点进不去，所以这里记的始终是「开页前用户的落点」，正是关闭时要还回去的位置。
	const lastSessionFocusRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		const host = sessionHostRef.current;
		if (!host) return;
		const rememberFocus = (event: FocusEvent) => {
			if (event.target instanceof HTMLElement) lastSessionFocusRef.current = event.target;
		};
		host.addEventListener("focusin", rememberFocus);
		return () => host.removeEventListener("focusin", rememberFocus);
	}, []);

	/**
	 * 关闭功能页时焦点交给谁：优先开页前的落点（若它仍在会话列内），其次会话内最后聚焦的元素，
	 * 最后兜底会话列容器本身——保证焦点留在用户刚回到的可见会话里，不残留在刚卸载的覆盖层上。
	 */
	const resolveSessionFocusTarget = useCallback((remembered: HTMLElement | null) => {
		const host = sessionHostRef.current;
		if (!host) return null;
		for (const candidate of [remembered, lastSessionFocusRef.current]) {
			if (candidate?.isConnected && host.contains(candidate)) return candidate;
		}
		return host;
	}, []);

	return (
		<>
			{/* tabIndex=-1：仅程序化聚焦（关闭功能页后的焦点兜底），不进 Tab 序；outline-none 防整列焦点环 */}
			<div
				ref={(node) => {
					sessionHostRef.current = node;
				}}
				className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
				tabIndex={-1}
				inert={pageOpen || undefined}
				aria-hidden={pageOpen || undefined}
			>
				{props.children}
			</div>
			<PersonalWorkbenchPageOverlay projectId={props.projectId} sessionId={props.sessionId} onRestoreSession={props.onRestoreSession} resolveSessionFocusTarget={resolveSessionFocusTarget} />
		</>
	);
}
