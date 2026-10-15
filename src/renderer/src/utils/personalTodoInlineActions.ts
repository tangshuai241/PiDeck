/** 行内编辑策略：使用打开浮层时的版本，拒绝覆盖详情草稿或未解决的冲突。 */
import type { PersonalTodoOperation, PersonalTodoStatus, PersonalTodoSubmitResult, PersonalTodoView } from "../../../shared/types/personalTodo";
import type { TranslationKey } from "../i18n";
import { resolvePersonalTodoStatusDecision } from "./personalTodoState";

export type PersonalTodoInlinePatch = Pick<Extract<PersonalTodoOperation, { kind: "patch" }>["patch"], "category" | "deadline" | "urgency">;

/** 只组合既有提交边界；这里不持久化、不取数，也不建立第二份事项状态。 */
export function createPersonalTodoInlineActions(deps: {
	items: readonly PersonalTodoView[];
	hasDirtyDraft: (id: string) => boolean;
	activeIds: Set<string>;
	onNotice: (notice: { itemId: string; key: TranslationKey } | null) => void;
	submit: (operation: PersonalTodoOperation) => Promise<PersonalTodoSubmitResult>;
	getScope: () => string;
	scope: string;
	isAlive: () => boolean;
}) {
	const run = async (view: PersonalTodoView, operation: PersonalTodoOperation): Promise<boolean> => {
		if (!deps.isAlive() || deps.scope !== deps.getScope()) return false;
		const id = view.item.id;
		const lockKey = `${deps.scope}::${id}`;
		if (deps.activeIds.has(lockKey)) return false;
		if (deps.hasDirtyDraft(id)) {
			deps.onNotice({ itemId: id, key: "personalTodo.inlineDirtyDraft" });
			return false;
		}
		const current = deps.items.find((entry) => entry.item.id === id);
		if (!current || current.item.revision !== view.item.revision || ["conflict", "unknown", "error"].includes(current.sync.phase)) {
			deps.onNotice({ itemId: id, key: "personalTodo.inlineChanged" });
			return false;
		}
		const scope = deps.getScope();
		deps.onNotice(null);
		deps.activeIds.add(lockKey);
		try {
			const result = await deps.submit(operation);
			return deps.isAlive() && scope === deps.getScope() && result.ok;
		} finally {
			deps.activeIds.delete(lockKey);
		}
	};
	return {
		/** patch 只携带用户选择的字段；清除用 null，紧急度 0 必须保留。 */
		patchInline: (view: PersonalTodoView, patch: PersonalTodoInlinePatch) => run(view, { kind: "patch", id: view.item.id, expectedRevision: view.item.revision, patch }),
		/** 选择完成与勾选完成遵守相同父子规则；取消不会删除任何事项。 */
		setInlineStatus: (view: PersonalTodoView, status: PersonalTodoStatus) => {
			const decision = resolvePersonalTodoStatusDecision({ status, subtodos: view.item.subtodos });
			if (decision.kind === "blocked") {
				deps.onNotice({ itemId: view.item.id, key: decision.reasonKey });
				return Promise.resolve(false);
			}
			return run(view, { kind: "status", id: view.item.id, expectedRevision: view.item.revision, status });
		},
	};
}
