/**
 * TPA 独立文稿：本轮是不是"正式文稿"的纯策略。
 *
 * 为什么需要它：文稿流程会要求成果目录、冻结基稿、归档版本，这些对**普通项目开发**
 * （重构代码、修 bug、解释材料）都是纯负担。需求模式本身不能作为判据——用户在
 * 需求模式里说"重构 foo.ts"时，原生 Plan 执行必须原样可用。
 *
 * 判据只来自权威要求单里的文字（goal / deliverable），不来自 renderer 标志、
 * 模型自报或用户勾选：renderer 用它决定要不要建文稿记录，主进程在准备阶段用同一份
 * 实现再判一次（`resolveCreateAuthorization`），两边不可能靠"一个布尔值"通车。
 *
 * 保守优先：模糊一律按普通开发处理（不强制归档）；只有明确指向文档产物的目标才进文稿。
 */

/** 文档产物扩展名：出现即强信号（deliverable 优先）。 */
const DOCUMENT_EXTENSIONS = /\.(?:docx?|md|markdown|rtf|odt|pdf|txt)\b/i;
/** 只用于识别"这是代码/工程任务"的扩展名：出现即否决（除非同时给出文档扩展名）。 */
const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|c|h|cpp|cs|swift|sh|sql|vue|svelte|json|ya?ml|toml|css|scss|html|xml)\b/i;
/** 文档类名词（中英）。 */
// 只收"明确的文档实体"名词；"总结/汇报/方案"这类既可能是文档也可能是口头交代的词不收，
// 否则"读一下材料，给我结论"会被误判成要写文档。
const DOCUMENT_NOUNS = /(文稿|文档|报告|方案书|说明书|合同|协议|纪要|白皮书|提案|计划书|标书|公文|论文|简历|手册|report|document|memo|proposal|contract|whitepaper|white paper|minutes|manuscript|thesis|resume|handbook)/i;
/** 产出文档的动作词：避免把"研究一下这个方案"当成要写文档。 */
const PRODUCTION_VERBS = /(写|撰写|起草|整理|生成|产出|输出|做成|形成|汇编|排版|定稿|write|draft|produce|prepare|create|generate|compose|compile)/i;
/** 明确的 Word/Office 产物信号。 */
const OFFICE_SIGNALS = /(word|docx?|markdown|\.md\b|office|ooxml|排版|页眉|目录页)/i;

export type DocumentTargetDecision = { kind: "document"; reason: string } | { kind: "plain"; reason: string };

/** 目标文本：要求单里能说明"要交付什么"的字段。 */
export type DocumentTargetInput = {
	goal?: string;
	deliverable?: string;
	/** 要求单里点名的材料（只用于"本次明确关联文稿"的补充判断）。 */
	materials?: readonly string[];
};

function normalize(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 判断本轮是不是正式文稿。
 *
 * 规则（按顺序）：
 * 1. deliverable 里出现文档扩展名 → 文稿；
 * 2. 出现代码扩展名且没有文档扩展名 → 普通开发（否决）；
 * 3. deliverable 里有文档名词 → 文稿；
 * 4. goal 里有文档名词且有产出动作 → 文稿；
 * 5. goal/deliverable 里出现 Word/Markdown/排版这类明确产物词且有产出动作 → 文稿；
 * 6. 其余 → 普通开发（模糊不强制归档）。
 */
export function classifyDocumentTarget(input: DocumentTargetInput): DocumentTargetDecision {
	const goal = normalize(input.goal);
	const deliverable = normalize(input.deliverable);
	const combined = `${goal} ${deliverable}`.trim();
	if (!combined) return { kind: "plain", reason: "no stated goal or deliverable" };
	const hasDocumentExtension = DOCUMENT_EXTENSIONS.test(deliverable) || DOCUMENT_EXTENSIONS.test(goal);
	const hasCodeExtension = CODE_EXTENSIONS.test(combined);
	if (hasDocumentExtension) return { kind: "document", reason: "the goal or deliverable names a document file" };
	// 代码任务优先否决：写一个 .ts 文件不是"正式文稿"，即使描述里出现"文档"字样。
	if (hasCodeExtension) return { kind: "plain", reason: "the target names a source-code file" };
	if (DOCUMENT_NOUNS.test(deliverable)) return { kind: "document", reason: "the deliverable is a document artifact" };
	if (DOCUMENT_NOUNS.test(goal) && PRODUCTION_VERBS.test(combined)) return { kind: "document", reason: "the goal asks to produce a document" };
	if (OFFICE_SIGNALS.test(combined) && PRODUCTION_VERBS.test(combined)) return { kind: "document", reason: "the goal asks to produce an office/markdown artifact" };
	return { kind: "plain", reason: "the request does not clearly produce a document artifact" };
}

/**
 * 本轮要不要走文稿路由（renderer 与主进程共用同一份判据）。
 *
 * 只有"需求模式 + pi 后端 + 明确文档目标"才路由到文稿；普通聊天、普通 Plan 执行、
 * 其他后端一律走原生流程，不建文稿记录、不拦批准。
 */
export function shouldRouteRoundToDocumentWork(input: { backend: string; mode: string; brief: DocumentTargetInput | undefined }): { route: "document" | "plain"; reason: string } {
	if (input.backend !== "pi") return { route: "plain", reason: "the document flow supports the pi backend only" };
	if (input.mode !== "alignment") return { route: "plain", reason: "only the requirements mode can start a formal document round" };
	if (!input.brief) return { route: "plain", reason: "the requirements brief is not available yet" };
	const decision = classifyDocumentTarget(input.brief);
	return decision.kind === "document" ? { route: "document", reason: decision.reason } : { route: "plain", reason: decision.reason };
}

/**
 * 批准前是否需要拦下（要求用户先选成果目录）。
 *
 * 只有"本轮确定是文稿 + 已有工作记录 + 还没绑成果目录"才拦；普通开发一律放行，
 * 原生 approve 正常且只发一次。
 */
export function shouldBlockDocumentApproval(input: { route: "document" | "plain"; hasWork: boolean; hasOutputRoot: boolean }): { block: boolean; reason?: string } {
	if (input.route !== "document") return { block: false };
	if (!input.hasWork) return { block: false };
	if (input.hasOutputRoot) return { block: false };
	return { block: true, reason: "the document round needs an output folder before it can start" };
}
