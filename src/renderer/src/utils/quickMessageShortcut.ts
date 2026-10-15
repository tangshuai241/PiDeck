/**
 * 「快捷消息」浮层由哪一栏响应全局快捷键 —— 纯判定，便于单测。
 *
 * 背景：快捷键是主进程 before-input-event 的全局广播（appShortcutTriggered），
 * 分屏时每个会话栏都挂一份订阅，若不加判定就会按一次同时弹出多个浮层。
 *
 * 两种「属于本栏」的情形：
 * - 本栏就是聚焦会话（分屏下点过哪一栏、或当前打开的会话）；
 * - 当前没有会话被聚焦（项目空态/引导页），此时页面上只存在引导页那一个输入框，
 *   快捷键当然归它——否则按钮看得见、快捷键却静默失效，是最难排查的一类不一致。
 *
 * 一种「谁都不属于」的情形：个人工作台功能页盖住会话列时，会话栏与输入框都不可见，
 * 输入类快捷键（快捷消息、语音录音）不得落到被遮的会话上。焦点隔离（inert）已经挡住
 * 键盘输入，快捷键不能成为绕过它的后门；后台运行不受影响，只是不再接管这两个键。
 */
export function ownsQuickMessageShortcut(input: { focusedSessionId: string | undefined; sessionId: string; guideSessionId: string; personalWorkbenchPageOpen?: boolean }): boolean {
	if (input.personalWorkbenchPageOpen) return false;
	if (input.focusedSessionId === input.sessionId) return true;
	return input.focusedSessionId === undefined && input.sessionId === input.guideSessionId;
}
