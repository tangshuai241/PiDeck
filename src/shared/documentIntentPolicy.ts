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

/** 代码与工程语境：出现这些词说明这是项目开发，不是文稿任务。 */
const ENGINEERING_NOUN = /(?:代码|函数|接口|重构|编译|测试用例|bug|报错|堆栈|依赖|提交|分支|仓库|脚本|配置|部署|单元测试|类型|module|import|api\b)/i;

export type DocumentIntentInput = {
	/** 用户原话或对齐要求的目标/成品描述。 */
	text: string;
	/** 会话里是否已经有一件工作（决定「继续改稿」是否成立）。 */
	hasWork: boolean;
	/** 工作里是否已有通过检查的可用基稿。 */
	hasUsableBase: boolean;
};

/**
 * 是否把这一轮接进文稿生命周期（建工作 / 拦截确认单）。
 * 保守规则：必须同时有文档名词与制作动词，且不是工程语境；已有工作也必须有可用基稿。
 */
export function isDocumentWorkIntent(input: DocumentIntentInput): boolean {
	const text = input.text.trim();
	if (!text) return false;
	if (ENGINEERING_NOUN.test(text)) return false;
	if (!DOCUMENT_NOUN.test(text)) return false;
	if (!PRODUCTION_VERB.test(text)) return false;
	if (input.hasWork && !input.hasUsableBase) return false;
	return true;
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
	if (ENGINEERING_NOUN.test(value)) return false;
	return REVISION_VERB.test(value) && REVISION_LOCATOR.test(value);
}

/** 从明确的改稿要求里抽出用户指到的块名，作为本轮的允许改动范围。 */
export function revisionScopeHints(text: string): string[] {
	const hints: string[] = [];
	for (const match of text.matchAll(/第[一二三四五六七八九十百零〇\d]+[章节节篇部分条]/g)) hints.push(match[0]);
	for (const match of text.matchAll(/(?:标题|开头|结尾|落款|附录|摘要|结论|正文|附注)/g)) hints.push(match[0]);
	return [...new Set(hints)].slice(0, 8);
}
