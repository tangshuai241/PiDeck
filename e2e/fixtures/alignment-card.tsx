import { createRoot } from "react-dom/client";
import { Provider, atom, createStore, useAtomValue } from "jotai";
import type { AlignmentState, SendSessionPromptResult } from "../../src/shared/types";
import { sessionRuntimeByIdAtom, type SessionRuntimeViewState } from "../../src/renderer/src/atoms/session-atoms";
import { sessionComposerModeByIdAtom } from "../../src/renderer/src/atoms/composer-atoms";
import { alignmentQueuedCountAtomFamily } from "../../src/renderer/src/atoms/alignment-atoms";
import { SessionAlignmentTimeline } from "../../src/renderer/src/components/session/SessionAlignmentTimeline";
import { RespondingIndicator } from "../../src/renderer/src/components/session/SurfaceParts";
import { ComposerBottomBar } from "../../src/renderer/src/components/session/ComposerComponents";
import { useSessionAlignmentControls } from "../../src/renderer/src/hooks/useSessionAlignmentControls";
import { Button } from "../../src/renderer/src/components/ui-shadcn/button";
import { useSessionSend } from "../../src/renderer/src/hooks/useSessionSend";
import { desktopApi } from "../../src/renderer/src/desktopApi";
import { setI18nLocale } from "../../src/renderer/src/i18n";
import "../../src/renderer/src/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
setI18nLocale("zh-CN");
const store = createStore();
const SESSION_ID = "alignment-fixture";
const actionAtom = atom("");
const questions = params.get("questions") === "1";
const working = params.get("working") === "1";
const initial: AlignmentState = {
	schemaVersion: 1,
	briefId: "brief-theme-123",
	revision: 2,
	briefRevision: working ? undefined : 2,
	phase: working || questions ? "clarifying" : "ready",
	brief: working
		? undefined
		: {
				goal: "依据实际材料整理本次施工总结。",
				scope: ["只写桥面系部分，不扩展到其他分项。"],
				materials: Array.from({ length: 12 }, (_, index) => `已读取材料 ${index + 1}：现场记录与已核实要求。${"材料摘要，不把文件路径当作已读内容。".repeat(4)}`),
				deliverable: "一份可检查和继续修改的 Markdown 草稿。",
				preserve: ["未核实的数据保留待补，不编造参数。"],
				acceptance: ["范围准确，关键要求均有对应内容。"],
				questions: questions ? ["请确认是否需要另行生成 Word 成品。"] : [],
			},
};
function publish(state: AlignmentState | undefined, busy = false): void {
	const runtime: SessionRuntimeViewState = { agentId: "fixture-agent", runtimeGeneration: 1, status: busy ? "running" : "idle", updatedAt: Date.now(), state: { alignment: state, isStreaming: busy } };
	store.set(sessionRuntimeByIdAtom, { ...store.get(sessionRuntimeByIdAtom), [SESSION_ID]: runtime });
}
store.set(sessionComposerModeByIdAtom, { [SESSION_ID]: "alignment" });
publish(params.get("idle") === "1" ? undefined : initial, working || params.get("busy") === "1");
let settleSend: (() => void) | undefined;
let acknowledge: (() => void) | undefined;

/** Only IPC is mocked: the timeline surface, policy, Jotai subscriptions, control hook and ordinary send hook are production modules. */
desktopApi.sessions.sendPrompt = async (input) => {
	const result: SendSessionPromptResult = { accepted: true, sessionId: SESSION_ID, requestId: input.requestId, agentId: "fixture-agent", runtimeGeneration: 1, delivery: "accepted" };
	store.set(actionAtom, input.message);
	if (input.message.startsWith("/align approve")) {
		acknowledge = () => {
			const current = store.get(sessionRuntimeByIdAtom)[SESSION_ID]?.state?.alignment;
			if (current) publish({ ...current, phase: "approved" }, true);
		};
		return result;
	}
	if (input.message === "/align off") {
		publish({ ...initial, phase: "cancelled" });
		return result;
	}
	return new Promise((resolve) => {
		settleSend = () => resolve(result);
	});
};

desktopApi.extensions.list = async () => ({ raw: "", extensions: [{ id: "alignment-fixture", source: "pi-deck-alignment-mode.ts", scope: "user", builtIn: true, enabled: true }] });

function Fixture() {
	const modes = useAtomValue(sessionComposerModeByIdAtom);
	const alignment = useSessionAlignmentControls(SESSION_ID);
	const action = useAtomValue(actionAtom);
	const runtimes = useAtomValue(sessionRuntimeByIdAtom);
	const busy = runtimes[SESSION_ID]?.status === "running";
	const send = useSessionSend({ sessionId: SESSION_ID, templates: [], compact: async () => {}, sendPrompt: desktopApi.sessions.sendPrompt });
	return (
		<main className="mx-auto mt-6 w-full max-w-[520px] space-y-3 p-3">
			{params.get("mode-bar") === "1" && (
				<div data-testid="production-composer-bar" className="rounded-lg border border-border bg-card">
					<ComposerBottomBar
						sessionId={SESSION_ID}
						backend="pi"
						record={{}}
						composerAgentMode={modes[SESSION_ID] ?? "normal"}
						disabled={params.get("disabled") === "1" || busy || alignment.pending}
						thinkingControl={null}
						voiceControls={null}
						sendControls={null}
						onPickModel={() => {}}
						onPickPromptTemplate={() => {}}
						onPickSkill={() => {}}
						onCompact={() => {}}
						onChangeMode={(mode) => alignment.changeMode(mode, modes[SESSION_ID] ?? "normal")}
						onCancelPlan={alignment.cancel}
						onAttachFile={() => {}}
					/>
				</div>
			)}
			<div data-testid="chat-flow" className="space-y-3">
				<p className="text-control text-foreground">{questions ? "是否需要生成 Word？请回复。" : "本轮聊天回复。"}</p>
				<SessionAlignmentTimeline sessionId={SESSION_ID} />
				{busy && <RespondingIndicator isStarting={false} isCompacting={false} />}
			</div>
			<div data-testid="fixture-composer" className="flex flex-wrap gap-2">
				<Button
					data-testid="send-revision"
					onClick={() => {
						void send(undefined, "改为 Excel，不要 Word。");
					}}
				>
					Send revision
				</Button>
				<Button data-testid="accept-send" onClick={() => settleSend?.()}>
					Accept delivery
				</Button>
				<Button data-testid="finish-without-brief" onClick={() => publish(store.get(sessionRuntimeByIdAtom)[SESSION_ID]?.state?.alignment ?? undefined)}>
					End response
				</Button>
				<Button
					data-testid="publish-revised"
					onClick={() => {
						const current = store.get(sessionRuntimeByIdAtom)[SESSION_ID]?.state?.alignment;
						if (initial.brief) publish({ ...initial, revision: (current?.revision ?? 2) + 1, briefRevision: (current?.revision ?? 2) + 1, phase: "ready", brief: { ...initial.brief, deliverable: "一份 Excel 成品。", questions: [] } });
					}}
				>
					Publish revised brief
				</Button>
				<Button data-testid="ack-approval" onClick={() => acknowledge?.()}>
					Acknowledge approval
				</Button>
				<Button data-testid="queue-revision" onClick={() => store.set(alignmentQueuedCountAtomFamily(SESSION_ID), 1)}>
					Queue revision
				</Button>
			</div>
			<output data-testid="alignment-action" className="text-caption text-muted-foreground whitespace-pre-wrap break-words">
				{action}
			</output>
		</main>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing alignment fixture root");
createRoot(root).render(
	<Provider store={store}>
		<Fixture />
	</Provider>,
);
