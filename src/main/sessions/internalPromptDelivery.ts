/**
 * 主进程内部投递选项（不在渲染层契约里）。
 *
 * 背景（真机缺陷）：文稿链路的宿主协议命令 `/tpa-work bind|execute|release` 与
 * `/align approve …` 由主进程自己派发，文本里带着元数据与编码载荷。它们照常发送、
 * 照常触发模型，但 `AgentManager.sendPrompt` 原来无条件把它们写成一条用户消息，
 * 于是时间线上出现了「不是用户说的话」的气泡，也污染了「最新用户轮」的来源。
 *
 * 这里提供两件事：
 * 1. `InternalPromptDelivery`：只允许主进程内部调用方设置的投递选项；
 * 2. `sanitizeRendererPromptInput`：渲染层经公开 IPC 送进来时，只保留白名单字段，
 *    同名的伪造字段（例如伪造 `internalControl`）在这里被丢弃——渲染层永远不能
 *    请求「隐藏的时间线消息」。
 *
 * 边界：这不是授权开关。内部控制命令仍然要走完整的运行时守卫、expectedRuntime 栅栏、
 * 分发租约与幂等回执；`internalControl` 只影响「是否生成乐观用户气泡」这一件事。
 */

import type { SendSessionPromptInput } from "../../shared/types/session";

/**
 * 内部控制投递标记（Symbol 键）。
 *
 * 为什么用 Symbol 而不是普通字段：结构化克隆（IPC / HTTP / JSON）不会携带 symbol 键，
 * 因此渲染层与任何远程输入在结构上就无法伪造这个标记——比「在每个入口逐字段白名单」
 * 更硬，而且每一条转发路径天然安全。只有主进程内部模块能 import 这个符号并设置它。
 */
export const INTERNAL_CONTROL = Symbol.for("pideck.internal-control.v1");

/** 只允许主进程内部调用方设置的投递选项。 */
export type InternalPromptDelivery = {
	/** 内部控制文本：照常校验、照常发送、照常触发模型，但不生成乐观用户气泡。 */
	[INTERNAL_CONTROL]?: true;
};

/** 渲染层可以送进来的字段白名单：其余一律丢弃。 */
export function sanitizeRendererPromptInput(raw: SendSessionPromptInput): SendSessionPromptInput {
	const sanitized: SendSessionPromptInput = {
		sessionId: raw.sessionId,
		requestId: raw.requestId,
		message: raw.message,
	};
	if (typeof raw.agentMessage === "string") sanitized.agentMessage = raw.agentMessage;
	if (Array.isArray(raw.images)) sanitized.images = raw.images;
	if (raw.streamingBehavior === "steer" || raw.streamingBehavior === "followUp") sanitized.streamingBehavior = raw.streamingBehavior;
	if (typeof raw.description === "string") sanitized.description = raw.description;
	if (raw.expectedRuntime) sanitized.expectedRuntime = raw.expectedRuntime;
	// 显式说明：内部投递标记不在白名单里（它还是 symbol 键，IPC 结构化克隆根本带不过来），
	// 渲染层伪造的同名字段会被丢弃。
	return sanitized;
}
