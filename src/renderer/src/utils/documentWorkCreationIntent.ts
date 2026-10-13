/**
 * 首次建档的转场纯策略：这一轮该不该、以及该以哪一轮身份建立工作记录。
 *
 * 为什么必须独立成纯函数（缺陷背景）：原实现把判断写在 effect 里，依赖数组写成了
 * **稳定的 atom 对象**而不是订阅到的值，于是 Pi 发布 ready brief 后组件重渲染、
 * effect 却不再执行，建档入口永远不出现（真实验收里 `documentWork.list` 一直是 `[]`）。
 * 把「值 → 决策」抽出来后，effect 只需要依赖决策的稳定签名，转场就不会再被漏掉。
 *
 * 决策规则（每条都有对应的行为测试）：
 * 1. 有在途操作（phase 非 idle）→ keep：不和正在进行的建档/制作抢状态。
 * 2. 已有工作记录 → clear：建档只服务「还没有工作」的情况；工作快照是异步载入的，
 *    载入后必须把可能已经武装的待建撤掉，否则既有文稿的会话会一直显示「选择目录」。
 * 3. 对齐未激活（无快照、cancelled、complete）→ clear：这一轮没有待办，不残留待建卡。
 * 4. revision < 1 → clear：只选了需求模式、还没提交实际要求，不建记录。
 * 5. 没有真实用户轮身份 → keep：不能在缺身份时建档，等消息到达后重新决策。
 * 6. 当前轮路由（与确认单批准路径共用 `routeDocumentTurn`）：用户原话、当前 revision 的
 *    brief 二者之一命中正式文稿证据 → arm（绑定该轮身份）；明确工程/编码轮或两者都没有
 *    证据 → clear（普通计划/编码轮不得出现文稿卡）。
 * 7. arm 时派生的显示标题只服务界面与记录：走共享 `sanitizeWorkTitle`（截 80 字），恒定满足
 *    公开 IPC `documentWorkCreate` 的标题上界；不够长/超长的需求摘要都不许反过来挡住建档。
 *    需求正文（goal/deliverable/acceptance）与用户轮身份不受归一影响。
 */
import { isAlignmentActive } from "../../../shared/alignment";
import { sanitizeWorkTitle } from "../../../shared/documentWork";
import { routeDocumentTurn } from "../../../shared/documentIntentPolicy";
import type { AlignmentState } from "../../../shared/types/alignment";
import type { DocumentWorkPhase } from "../atoms/document-work-atoms";

export type DocumentWorkFirstCreateIntent = { sourceTurnId: string; title?: string };
export type DocumentWorkFirstCreateAction = { kind: "arm"; intent: DocumentWorkFirstCreateIntent } | { kind: "clear" } | { kind: "keep" };

export function deriveDocumentWorkFirstCreateAction(input: { alignment?: AlignmentState; hasWorkView: boolean; phase: DocumentWorkPhase; latestUserTurn?: { id: string; text: string } }): DocumentWorkFirstCreateAction {
	if (input.phase !== "idle") return { kind: "keep" };
	if (input.hasWorkView) return { kind: "clear" };
	const alignment = input.alignment;
	if (!isAlignmentActive(alignment) || !alignment) return { kind: "clear" };
	// 空模式：只选模式（revision 0）不算一次实际提交。
	if (alignment.revision < 1) return { kind: "clear" };
	if (!input.latestUserTurn?.id) return { kind: "keep" };
	// brief 只有在属于当前 revision 时才参与路由；否则只看最新用户轮（旧 brief 不参与）。
	const briefIsCurrent = Boolean(alignment.brief && alignment.briefRevision !== undefined && alignment.briefRevision === alignment.revision);
	const briefText = briefIsCurrent && alignment.brief ? `${alignment.brief.goal}\n${alignment.brief.deliverable}` : "";
	// 与确认单批准路径共用同一套当前轮路由：用户原话优先于模型措辞。
	if (routeDocumentTurn({ userText: input.latestUserTurn.text, briefText }) !== "document") return { kind: "clear" };
	// 标题只是给卡片/记录用的显示派生值，必须走共享 sanitizeWorkTitle 策略（空白与控制字符归一、
	// 截 80 字），因为公开 IPC documentWorkCreate 的标题上界是 120 字：直接拿整段 goal 当标题，
	// 真实验收里 219 字的正式需求摘要会在边界被拒（INVALID_INPUT/title_too_long），记录根本建不出来。
	// 归一不得反哺需求正文：brief 原文（goal/deliverable/acceptance）与用户轮身份保持原样。
	const title = alignment.brief?.goal ? sanitizeWorkTitle(alignment.brief.goal, "") : "";
	return { kind: "arm", intent: { sourceTurnId: input.latestUserTurn.id, ...(title ? { title } : {}) } };
}

/** 决策的稳定签名：effect 依赖它，值变了才重跑，避免依赖稳定 atom 漏掉转场。 */
export function documentWorkFirstCreateKey(action: DocumentWorkFirstCreateAction): string {
	return action.kind === "arm" ? `arm:${action.intent.sourceTurnId}:${action.intent.title ?? ""}` : action.kind;
}
