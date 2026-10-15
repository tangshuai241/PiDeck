/** 隔离界面夹具：真实页面与 hook + 内存桌面接口；不会连接云端、pi 或正式数据。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { createPreviewApi } from "../../src/renderer/src/previewApi";
import { setI18nLocale } from "../../src/renderer/src/i18n";
import type { PersonalTodo, PersonalTodoChangedEvent, PersonalTodoOperation, PersonalTodoQuery, PersonalTodoSyncSummary, PersonalTodoView } from "../../src/shared/types/personalTodo";
import { personalTodoLocalDay } from "../../src/renderer/src/utils/personalTodoPresentation";
import "../../src/renderer/src/styles.css";

const scope = { origin: "https://todo-ui.invalid", account: "isolated", cloudInstanceId: "test", accountKey: "test-account" };
const summary: PersonalTodoSyncSummary = { pending: 0, sending: 0, conflict: 0, unknown: 0, error: 0, confirmedRecent: 0 };
const write = { available: true, verified: true, reason: null };
const today = new Date();
const dayAt = (offset: number) => personalTodoLocalDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));

/** 构造完整共享记录，不用类型断言绕过契约。 */
function makeView(id: string, title: string, overrides: Partial<PersonalTodo> = {}): PersonalTodoView {
	const item: PersonalTodo = {
		id,
		title,
		note: "这是隔离测试中的背景说明。\n完整原文应保留。",
		category: "个人工作",
		deadline: null,
		urgency: 1,
		status: "open",
		revision: "r1",
		createdAt: today.toISOString(),
		updatedAt: today.toISOString(),
		linkedTaskIds: [],
		subtodos: [],
		subtodoProgress: { total: 0, done: 0, open: 0, cancelled: 0 },
		source: { kind: "canonical", namespace: null, sourceId: null, fingerprint: null, rawAvailable: null },
		isRoot: true,
		parentId: null,
		parentSubtaskId: null,
		historyCount: null,
		...overrides,
	};
	return { item, confirmed: item, draft: null, sync: { phase: "synced", pendingCount: 0, lastError: null, cloudRevision: null, lastAttemptAt: null }, linkedTasks: [] };
}

const state: { fail: boolean; delay: number; nextCursor: string | null; submits: PersonalTodoOperation[]; queries: PersonalTodoQuery[]; items: PersonalTodoView[] } = {
	fail: false,
	delay: 90,
	nextCursor: null,
	submits: [],
	queries: [],
	items: [
		makeView("overdue", "核对预算与审批资料", { deadline: dayAt(-2), category: "项目管理", urgency: 3 }),
		makeView("today", "整理今天的工作记录", { deadline: dayAt(0), category: "日常记录" }),
		makeView("future", "准备下周设计讨论", { deadline: dayAt(4), category: "产品设计", urgency: 2 }),
		makeView("parent", "完成待办页面改造", { deadline: dayAt(5), category: "产品设计", subtodos: [{ id: "sub-1", text: "核对列表交互", note: "", status: "open", assignee: null, linkedTaskIds: [], sourceId: null }], subtodoProgress: { total: 1, done: 0, open: 1, cancelled: 0 } }),
		makeView("raw", "读完手边这本书", { deadline: "下周", category: "阅读" }),
		makeView("done", "归档上一版设计", { status: "done", deadline: dayAt(-4) }),
		makeView("cancelled", "保留已取消事项", { status: "cancelled" }),
	],
};
declare global {
	interface Window {
		todoUiHarness: typeof state;
	}
}
window.todoUiHarness = state;
const listeners = new Set<(event: PersonalTodoChangedEvent) => void>();
const api = createPreviewApi();
api.personalTodo = {
	getStatus: async () => ({ ok: true, status: { supported: true, scope, summary, write, lastFetchedAt: today.toISOString(), lastError: null } }),
	list: async (query) => {
		state.queries.push(query);
		const items = state.items.filter(
			({ item }) =>
				(!query.search || item.title.includes(query.search)) &&
				(!query.category || item.category === query.category) &&
				(!query.status?.length || query.status.includes(item.status)) &&
				(!query.deadlineFrom || Boolean(item.deadline && item.deadline >= query.deadlineFrom)) &&
				(!query.deadlineTo || Boolean(item.deadline && item.deadline <= query.deadlineTo)),
		);
		return { ok: true, scope, items, nextCursor: state.nextCursor, source: "cloud", fetchedAt: today.toISOString(), summary, write };
	},
	get: async (id) => {
		const item = state.items.find((view) => view.item.id === id);
		return item ? { ok: true, scope, item, summary, write } : { ok: false, error: { code: "invalidInput", message: "test item absent" } };
	},
	submit: async ({ operation, clientRequestId }) => {
		state.submits.push(operation);
		await new Promise((resolve) => window.setTimeout(resolve, state.delay));
		if (state.fail) return { ok: false, error: { code: "offline", message: "isolated failure" } };
		let view: PersonalTodoView;
		if (operation.kind === "create") {
			view = makeView(`new-${state.submits.length}`, operation.title, { note: operation.note ?? "", category: operation.category ?? null, deadline: operation.deadline ?? null, urgency: operation.urgency ?? null });
			state.items.push(view);
		} else {
			const existing = state.items.find((entry) => entry.item.id === operation.id);
			if (!existing) return { ok: false, error: { code: "invalidInput", message: "test item absent" } };
			const item = { ...existing.item, revision: `${existing.item.revision}-next` };
			if (operation.kind === "status") item.status = operation.status;
			if (operation.kind === "patch") Object.assign(item, operation.patch);
			if (operation.kind === "subtodoStatus") {
				item.subtodos = item.subtodos.map((subtodo) => (subtodo.id === operation.subtodoId ? { ...subtodo, status: operation.status } : subtodo));
				item.subtodoProgress = { total: item.subtodos.length, done: item.subtodos.filter((subtodo) => subtodo.status === "done").length, open: item.subtodos.filter((subtodo) => subtodo.status === "open").length, cancelled: item.subtodos.filter((subtodo) => subtodo.status === "cancelled").length };
			}
			view = { ...existing, item, confirmed: item };
			state.items = state.items.map((entry) => (entry.item.id === item.id ? view : entry));
		}
		for (const listener of listeners) listener({ scope, reason: "cloud", items: [view], reload: false, summary, write });
		return { ok: true, accepted: true, requestId: clientRequestId ?? "test-request", item: view, summary, write };
	},
	retry: async () => ({ ok: true, retried: 0, summary, write }),
	resolveConflict: async () => ({ ok: true, item: null, summary }),
	onChanged: (listener) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};
window.piDesktop = api;
setI18nLocale("zh-CN");
const { PersonalTodoPage } = await import("../../src/renderer/src/components/todos/PersonalTodoPage");
const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<main className="flex h-screen min-h-0 flex-col bg-background p-6">
			<PersonalTodoPage />
		</main>,
	);
