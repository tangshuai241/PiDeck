/**
 * 文稿意图与改稿请求的保守纯策略。
 *
 * 为什么要它：文稿归档只适用于明确的正式文稿任务。普通 Plan、编码、解释、读材料
 * 都必须走原生聊天与原生批准；反过来，用户明确说「把第二节改短」时也不该要求他先切
 * 模式或重新对齐。这里的判断必须保守：拿不准就返回 false，让流程停在原聊天语义上，
 * 由用户在聊天里自然澄清，绝不因为一个模型声明或渲染层布尔值就启动制作。
 *
 * 注意：这些规则只决定「要不要把这一轮接进文稿生命周期」，不是安全授权本身；
 * 真正的授权仍是主进程读到的真实用户轮（正文指纹 + 稳定会话身份）。
 */

/** 正式文稿的名词：必须是用户真正在做一份文档，而不是在写代码或解释一段文字。 */
const DOCUMENT_NOUN = /(?:文稿|文档|报告|方案|说明书|白皮书|纪要|简历|合同|论文|投标书|总结材料|初稿|成稿|定稿|word|docx|markdown|\.md\b)/i;

/** 制作动词：说明这一轮要产出正式成品，而不是讨论或修改代码。 */
const PRODUCTION_VERB = /(?:写|起草|拟|整理成|生成|制作|产出|出一份|出一版|输出|归档)/;

/**
 * 代码产物的名词：只列无歧义的那些。
 *
 * 裸「接口」「类型」**刻意不在列**：它们在正式文稿的题材描述里极常见
 *（「介绍桥梁类型和传感器接口」），把它们当工程信号会把明确的正式文书请求
 * 静默降级成原生批准（2026-10-12 真实验收 defect）。判断标准是「用户要什么产物、
 * 做什么动作」，不是文里出现过什么词。
 */
const CODE_ARTIFACT_NOUN = /(?:函数|方法|类(?:定义|声明|继承|成员|图)|模块|组件|脚本|代码|单元测试|测试用例|单测|编译|重构|调试|依赖|报错|堆栈|bug|仓库|分支|git\b|commit\b|rebase\b|import\b|module\b|api\b|类型定义|类型声明|部署|配置|提交(?:这次|本次|该|这些|那些)?(?:改动|变更|修改))/i;

/** 把「接口/函数/…」限定在真实工程搭配里：「X 的函数」「生成 X 接口」是代码，题材描述不是。 */
const CODE_ARTIFACT_PHRASE = /(?:的(?:函数|方法|接口|类|模块|组件|脚本|代码)|(?:生成|实现|写|改|重构|新建|创建)\S{0,6}(?:接口|函数|方法|类|模块|组件|脚本))/i;

/**
 * 这一轮是否带明确的工程/编码语境（公开入口，供当前轮路由与文稿判定共用）。
 *
 * 保守方向：宁可把模糊轮留在普通聊天（不启动任何无绑定执行），也不把工程轮拖进文稿域。
 */
export function hasOrdinaryEngineeringIntent(text: string): boolean {
	const value = text.trim();
	if (!value) return false;
	return CODE_ARTIFACT_NOUN.test(value) || CODE_ARTIFACT_PHRASE.test(value);
}

/**
 * 当前轮的域路由：这一轮该进正式文稿域，还是留在普通聊天/原生批准。
 *
 * 两条路径（首次建档与确认单批准）必须用同一套判断，否则 brief 的措辞就成了绕过文稿域的
 * 暗门：真实验收里 brief 含「只提交确认单」→ 被判成工程语境 → 走原生批准，一点绑定都没有。
 *
 * 规则顺序即优先级：
 * 1. 用户原话本身就是正式文稿要求 → 文稿域（用户原话优先于模型措辞）；
 * 2. 用户原话明确是工程/编码任务 → 普通轮（不得被本轮或历史 brief 拖进文稿域）；
 * 3. 用户原话没有明确信号（例如「按上面的要求」「确认」）→ 以**属于当前 revision** 的
 *    brief 为准；调用方必须只在 briefRevision 等于当前 revision 时传 briefText，旧 brief 不参与；
 * 4. 都没有 → 普通轮。
 *
 * 这里只做域路由，不构成授权：授权仍是用户点击确认 + 主进程读到的那一轮真实用户轮。
 */
export function routeDocumentTurn(input: { userText?: string; briefText?: string }): "document" | "ordinary" {
	const userText = (input.userText ?? "").trim();
	if (isDocumentWorkIntent(userText)) return "document";
	if (hasOrdinaryEngineeringIntent(userText)) return "ordinary";
	if (isDocumentWorkIntent(input.briefText ?? "")) return "document";
	return "ordinary";
}

/**
 * 是否把这一轮接进文稿生命周期（建工作 / 拦截确认单）。
 *
 * 只判断「这一轮是不是正式文稿任务」：必须同时有文档名词与制作动词，且不是工程语境。
 * 「已有工作但没有可用基稿」属于调用方的分支（本轮是改稿却没有基稿 → 明确阻塞），
 * 不能在这里返回「普通聊天」，否则会把文稿轮悄悄交给原生批准。
 */
export function isDocumentWorkIntent(text: string): boolean {
	const value = text.trim();
	if (!value) return false;
	if (hasOrdinaryEngineeringIntent(value)) return false;
	if (!DOCUMENT_NOUN.test(value)) return false;
	return PRODUCTION_VERB.test(value);
}

/** 明确的否定/先解释语境：出现即不启动改稿，交由聊天澄清。 */
const REVISION_NEGATION = /(?:不要改|不用改|先别改|别改|别动|先解释|只是解释|只是问问|先说明|不要动|先看|暂时不改|不用动|解释一下|说明一下)/;

/** 明确的改稿动词。 */
const REVISION_VERB = /(?:改|修改|调整|替换|删掉|删除|加上|增加|补上|缩短|精简|润色|重写|改写|扩写|改成|换成|重排)/;

/** 章节/位置的定位词：有它说明用户指明了改哪里（范围明确）。 */
const REVISION_LOCATOR = /(?:第[一二三四五六七八九十百零〇\d]+[章节节篇部分条]|标题|开头|结尾|落款|附录|摘要|结论|正文|附注|表格|第\s*\d+\s*(?:节|章|段)|最后一段|第一段|序号|格式|字体|排版|加粗|楷体|宋体|字号|页眉|页脚)/;

/**
 * 是否是「明确的改稿请求」，可以自动接续（不要求用户切模式或重新对齐）。
 *
 * 保守判定：出现改稿动词 + 定位词，且没有否定/先解释语境。只有动作者（"改一下"）
 * 没有定位时返回 false，让聊天自然澄清——宁可多问一句，也不误启动一轮制作。
 */
export function isExplicitRevisionRequest(text: string): boolean {
	const value = text.trim();
	if (!value) return false;
	if (REVISION_NEGATION.test(value)) return false;
	if (hasOrdinaryEngineeringIntent(value)) return false;
	return REVISION_VERB.test(value) && REVISION_LOCATOR.test(value);
}
