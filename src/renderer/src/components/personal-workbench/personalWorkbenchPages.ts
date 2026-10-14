/**
 * 个人工作台的功能页目录（页面身份 → 文案 key / 图标 / 数据可用性）。
 *
 * 目录是导航的唯一真源：侧栏入口、页面容器标题、未接入状态说明都从这里取，
 * 新增功能页只加一条，不散落到组件里各写一份。
 *
 * 可用性：`ready` 表示页面本身已实现（P02 起待办页由 `components/todos` 提供正文，P03 起阅读页由
 * `components/reading` 提供正文）；账号、云端服务与写入是否可用属于运行期状态，只在打开这一页后
 * 由页面自己呈现，不做启动探测或后台轮询。页面内真正连不上的原因（连不上／需要密码／接口未部署）
 * 都由页面读取状态后如实显示，静态字段不用来冒充服务在线。
 */
import type { ComponentType } from "react";
import { BookOpen, ListTodo } from "lucide-react";
import type { PersonalWorkbenchAvailability, PersonalWorkbenchPageId } from "../../../../shared/types/personalWorkbench";
import type { TranslationKey } from "../../i18n";

export type PersonalWorkbenchPageDescriptor = {
	id: PersonalWorkbenchPageId;
	/** 入口与页面标题 */
	titleKey: TranslationKey;
	/** 一句话说明这个页面提供什么（入口 title 提示与未接入说明共用） */
	summaryKey: TranslationKey;
	icon: ComponentType<{ className?: string }>;
	availability: PersonalWorkbenchAvailability;
};

/**
 * 展示顺序：阅读、待办（与方案里的左侧结构一致）。
 *
 * `ready` 的页面不经过这里：正文由 `personalWorkbenchPageRenderers` 注册的组件提供，
 * 运行期状态（服务连不上、需要连接、接口未部署等）由页面自己说明。
 */
export const PERSONAL_WORKBENCH_PAGES: readonly PersonalWorkbenchPageDescriptor[] = [
	{ id: "reading", titleKey: "personalWorkbench.reading", summaryKey: "personalWorkbench.readingSummary", icon: BookOpen, availability: "ready" },
	{ id: "todo", titleKey: "personalWorkbench.todo", summaryKey: "personalWorkbench.todoSummary", icon: ListTodo, availability: "ready" },
];

/** 按身份取目录项；id 是联合类型，未命中说明目录漏项，属于开发期错误。 */
export function personalWorkbenchPageById(id: PersonalWorkbenchPageId): PersonalWorkbenchPageDescriptor {
	const page = PERSONAL_WORKBENCH_PAGES.find((candidate) => candidate.id === id);
	if (!page) throw new Error(`Unknown personal workbench page: ${id}`);
	return page;
}

/** 入口角标文案：ready 不显示角标（正常可用不需要标注），未接入/不可用各有自己的说法。 */
export function personalWorkbenchBadgeKey(availability: PersonalWorkbenchAvailability): TranslationKey | null {
	switch (availability) {
		case "not-connected":
			return "personalWorkbench.badgeNotConnected";
		case "unavailable":
			return "personalWorkbench.badgeUnavailable";
		case "ready":
			return null;
	}
}

/** 页面正文的未接入/不可用说明；ready 返回 null（正文由页面自己的实现给出）。 */
export function personalWorkbenchStatusKeys(availability: PersonalWorkbenchAvailability): { titleKey: TranslationKey; bodyKey: TranslationKey } | null {
	switch (availability) {
		case "not-connected":
			return { titleKey: "personalWorkbench.notConnectedTitle", bodyKey: "personalWorkbench.notConnectedBody" };
		case "unavailable":
			return { titleKey: "personalWorkbench.unavailableTitle", bodyKey: "personalWorkbench.unavailableBody" };
		case "ready":
			return null;
	}
}
