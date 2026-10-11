import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Provider } from "jotai";
import type { AlignmentState } from "../../src/shared/types";
import { AlignmentCard } from "../../src/renderer/src/components/session/AlignmentCard";
import { ComposerWidgetLayoutProvider, useComposerWidgetLayoutValue, type ComposerWidgetCollapsedByKey } from "../../src/renderer/src/components/session/ComposerWidgetLayout";
import type { SessionAlignmentControls } from "../../src/renderer/src/hooks/useSessionAlignmentControls";
import { setI18nLocale } from "../../src/renderer/src/i18n";
import "../../src/renderer/src/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
setI18nLocale("zh-CN");

/** Real card and production styles; only the runtime and action transport are replaced. */
function Fixture() {
	const [collapsed, setCollapsed] = useState<ComposerWidgetCollapsedByKey>({});
	const layout = useComposerWidgetLayoutValue(collapsed, setCollapsed);
	const [action, setAction] = useState("");
	const pending = params.get("questions") === "1";
	const state: AlignmentState = {
		schemaVersion: 1,
		briefId: "brief-theme-123",
		revision: 2,
		phase: pending ? "clarifying" : "ready",
		brief: {
			goal: "依据实际材料整理本次施工总结。",
			scope: ["只写桥面系部分，不扩展到其他分项。"],
			materials: Array.from({ length: 12 }, (_, index) => `已读取材料 ${index + 1}：现场记录与已核实要求。${"材料摘要，不把文件路径当作已读内容。".repeat(4)}`),
			deliverable: "一份可检查和继续修改的 Markdown 草稿。",
			preserve: ["未核实的数据保留待补，不编造参数。"],
			acceptance: ["范围准确，关键要求均有对应内容。"],
			questions: pending ? ["请确认是否需要另行生成 Word 成品。"] : [],
		},
	};
	const controls: SessionAlignmentControls = {
		state,
		selected: true,
		busy: params.get("busy") === "1",
		pending: false,
		changeMode: () => false,
		approve: () => setAction(`approved:${state.briefId}:${state.revision}`),
		revise: () => setAction("revised"),
		cancel: () => setAction("cancelled"),
	};
	return (
		<Provider>
			<main className="mx-auto mt-6 w-full max-w-[520px] space-y-3 p-3">
				<ComposerWidgetLayoutProvider value={layout}>
					<AlignmentCard controls={controls} />
				</ComposerWidgetLayoutProvider>
				<output data-testid="alignment-action" className="text-caption text-muted-foreground">
					{action}
				</output>
			</main>
		</Provider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing alignment fixture root");
createRoot(root).render(<Fixture />);
