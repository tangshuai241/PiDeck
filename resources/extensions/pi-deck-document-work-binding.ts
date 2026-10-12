/**
 * TPA 独立文稿与需求对齐之间的**唯一绑定入口**。
 *
 * 两个扩展是独立文件，加载顺序由 `-e` 批次决定（对齐先于文稿）。若让文稿扩展直接
 * 拦截 `/align approve`，就得依赖命令注册顺序；反过来让对齐扩展 import 文稿扩展又会
 * 让对齐在文稿缺失时崩掉。这里用一个小注册表解耦：
 *
 * - 文稿扩展在加载时 `setDocumentWorkApprovalGate(...)` 注册自己的判定；
 * - 对齐扩展在批准前调用 `documentWorkApprovalRefusal(briefId)`；没人注册时返回 undefined，
 *   行为与引入文稿功能之前完全一致（旧 `/align approve` 兼容性由此保证）。
 *
 * 闸只做"拒绝"：它从不授予权限、从不替对齐批准，也不能让批准绕过版本校验。
 */
export type DocumentWorkApprovalGate = {
	/** 返回拒绝原因；undefined 表示放行。 */
	refuse(briefId: string, revision: number): string | undefined;
};

let gate: DocumentWorkApprovalGate | undefined;

export function setDocumentWorkApprovalGate(next: DocumentWorkApprovalGate | undefined): void {
	gate = next;
}

/** 对齐批准前的判定入口（fail-open 到"无文稿功能"的行为，不 fail-open 到"允许制作"）。 */
export function documentWorkApprovalRefusal(briefId: string, revision: number): string | undefined {
	if (!gate) return undefined;
	try {
		return gate.refuse(briefId, revision);
	} catch {
		// 闸自身坏了不能把对齐流程彻底锁死；但也不能静默放行一个可能无上下文的批准。
		return "Document work approval gate failed; restart the round before approving.";
	}
}

/** 当前是否有文稿绑定闸（供诊断/测试断言）。 */
export function hasDocumentWorkApprovalGate(): boolean {
	return gate !== undefined;
}
