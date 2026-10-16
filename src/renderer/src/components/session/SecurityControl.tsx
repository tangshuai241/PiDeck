import type { AgentBackend } from "../../../../shared/types";
import { SecurityLevelMenu } from "./SecurityLevelMenu";

/**
 * 底栏安全控制位统一入口（C20）：
 * 内置安全等级菜单（SecurityLevelMenu，SecurityStore 会话级覆盖，安全门热更新）。
 * 新增后端（如未来 Codex 运行时）只在这里注册控制位，不再在 ComposerArea 写 if/else。
 */
export function SecurityControl(props: { sessionId: string; backend?: AgentBackend; disabled?: boolean }) {
	return <SecurityLevelMenu sessionId={props.sessionId} disabled={props.disabled} />;
}
