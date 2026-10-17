/**
 * Ask 问答的跨端纯逻辑：主进程生成摘要、手机端提交批量答案都用这一份，
 * 避免「桌面能答、手机答不了」或两端信封格式不一致。
 *
 * 只处理数据形状，不依赖 React / Electron，宿主与 Android 客户端都可直接 import。
 */

/** 批量题单题类型（与 AgentUiBatchQuestion.type 对齐）。 */
export type RemoteAskQuestionType = "select" | "multi_select" | "confirm" | "input" | "editor";

/** 便携版批量题：手机端完整渲染题目所需的最小字段集。 */
export type RemoteBatchQuestion = {
	id: string;
	type: RemoteAskQuestionType;
	question: string;
	options?: Array<string | { label: string; value?: string; description?: string }>;
	allowOther?: boolean;
	placeholder?: string;
	prefill?: string;
};

export type AskAnswerValue = string | boolean | string[] | null | undefined;

/** Plan Mode 等内部标记只给桌面识别，不进入摘要/手机列表。 */
export function stripAskMarkers(title: string): string {
	const trimmed = title.trim();
	return trimmed.startsWith("[PI_DECK_PLAN_NEXT]") ? trimmed.slice("[PI_DECK_PLAN_NEXT]".length).trim() : trimmed;
}

/**
 * 待回答请求的展示摘要：
 * - 单题取请求标题；标题为空时退回题目本身；
 * - 批量题取第一题摘要（与桌面待回答入口一致）。
 * 返回 undefined 表示没有可展示的问题文本。
 */
export function askQuestionSummary(input: { title?: string; questions?: ReadonlyArray<{ question: string }> }): string | undefined {
	const first = input.questions?.[0]?.question;
	const candidate = stripAskMarkers(input.title ?? "") || stripAskMarkers(first ?? "");
	return candidate || undefined;
}

/** 与桌面 askUi.batchAnswerLabel 同一规则：布尔转 true/false，数组用「、」连接，其余原样。 */
export function batchAnswerLabel(value: AskAnswerValue): string {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) return value.join("、");
	return value ?? "";
}

/**
 * 序列化批量题答案（与桌面 askUi.serializeBatchAnswers 同一信封）：
 * pi 扩展按 `{ answers: [{ id, type, value, label, wasCustom }] }` 读取。
 */
export function serializeBatchAnswers(questions: ReadonlyArray<{ id: string; type: string }>, answers: Readonly<Record<string, AskAnswerValue>>): string {
	return JSON.stringify({
		answers: questions.map((question) => {
			const value = answers[question.id] ?? null;
			return { id: question.id, type: question.type, value, label: batchAnswerLabel(value), wasCustom: false };
		}),
	});
}
