/**
 * 功能页正文渲染器注册表：目录（`personalWorkbenchPages`）只描述身份与可用性，
 * 正文组件在这里按页面 id 注册。
 *
 * 为什么要一层注册：页面容器（`PersonalWorkbenchPageBody`）不应认识每个功能域；
 * 新增功能页 = 目录加一条 + 这里注册一个组件，不往容器里堆 switch，也不动侧栏。
 * P03 起阅读页已实现（`components/reading`），注册后不再回落目录里的「未接入」说明。
 */
import type { ComponentType } from "react";
import type { PersonalWorkbenchPageId } from "../../../../shared/types/personalWorkbench";
import { ReadingPage } from "../reading/ReadingPage";
import { PersonalTodoPage } from "../todos/PersonalTodoPage";

/**
 * 功能页正文的注入面（薄装配）：页面容器只转交「当前项目 + 打开会话」两个动作，
 * 具体业务仍在页面自己的 hook 里。新增能力优先做 registry 项，不往容器加分支。
 */
export type PersonalWorkbenchPageProps = {
	projectId?: string;
	onOpenSession?: (projectId: string, sessionId: string) => void | Promise<void>;
};

const PERSONAL_WORKBENCH_PAGE_RENDERERS: Partial<Record<PersonalWorkbenchPageId, ComponentType<PersonalWorkbenchPageProps>>> = {
	reading: ReadingPage,
	todo: PersonalTodoPage,
};

/** 取该功能页的正文组件；未注册返回 null（调用方回落到目录里的状态说明）。 */
export function personalWorkbenchPageRenderer(pageId: PersonalWorkbenchPageId): ComponentType<PersonalWorkbenchPageProps> | null {
	return PERSONAL_WORKBENCH_PAGE_RENDERERS[pageId] ?? null;
}
