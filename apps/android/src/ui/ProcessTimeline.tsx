import { Text, View } from "react-native";
import { Brain, ChevronDown, ChevronRight, Terminal, MessagesSquare } from "lucide-react-native";
import type { MessageChannel, RemoteMessage } from "../../../../packages/tpa-remote/src/types";
import type { ConversationTurn, ProcessStep } from "../conversation";
import type { Palette } from "../theme";
import { c } from "../copy";
import { Touch } from "./Motion";
import { typeScale } from "./typography";

export type OpenPart = (message: RemoteMessage, channel: MessageChannel) => void;

/** Per-channel full-content links preserve the original message identity. */
export function FullLink({ message, channel, colors, open }: { message: RemoteMessage; channel: MessageChannel; colors: Palette; open: OpenPart }) {
	return (
		<Touch accessibilityRole="button" onPress={() => open(message, channel)} style={{ minHeight: 32, justifyContent: "center" }}>
			<Text style={{ ...typeScale.process, color: colors.primary }}>{channel === "thinking" ? c.fullThinking : channel === "tool" ? c.fullTool : c.fullText}</Text>
		</Touch>
	);
}

/** Counts describe this received turn; errors stay visible even when details are closed. */
export function ProcessSummary({ turn, expanded, toggle, colors }: { turn: ConversationTurn; expanded: boolean; toggle: () => void; colors: Palette }) {
	const failures = turn.steps.filter((step) => step.message.tool?.status === "error").length;
	const active = turn.steps
		.slice()
		.reverse()
		.find((step) => step.message.tool?.status === "running" || (step.kind === "thinking" && step.message.thinkingEndedAt === 0));
	return (
		<Touch accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggle} style={{ minHeight: 32, justifyContent: "center", paddingVertical: 3, marginBottom: 2 }}>
			<View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
				{expanded ? <ChevronDown size={15} color={colors.secondary} /> : <ChevronRight size={15} color={colors.secondary} />}
				<Text style={{ ...typeScale.process, color: colors.secondary }}>{turn.partial ? c.partialProcess : c.process}</Text>
				<Text style={{ ...typeScale.caption, color: colors.secondary }}>
					{c.calls} {turn.tools} · {c.thoughts} {turn.thoughts} · {c.replies} {turn.replies}
				</Text>
				{!!failures && (
					<Text style={{ ...typeScale.caption, color: colors.danger }}>
						{c.processFailed} {failures}
					</Text>
				)}
			</View>
			{turn.running && (
				<Text numberOfLines={1} style={{ ...typeScale.caption, color: colors.secondary, paddingLeft: 21 }}>
					{active?.message.tool?.name || (active?.kind === "thinking" ? c.thinkingLive : c.generating)}
				</Text>
			)}
		</Touch>
	);
}

/** Parent-owned identity state survives virtualization and incoming message updates. */
export function ProcessDetail({ step, colors, open, expanded, toggle }: { step: ProcessStep; colors: Palette; open: OpenPart; expanded: boolean; toggle: () => void }) {
	const { message, kind } = step;
	const tool = message.tool;
	const Icon = kind === "thinking" ? Brain : kind === "tool" ? Terminal : MessagesSquare;
	const detail = kind === "thinking" ? (message.thinking ?? "") : kind === "tool" ? tool?.detail || message.text : message.text;
	const channel = kind === "reply" ? "text" : kind;
	const truncated = channel === "text" ? message.textTruncated : channel === "thinking" ? message.thinkingTruncated : message.toolTruncated;
	const duration = tool?.durationMs ?? (message.thinkingEndedAt && message.thinkingStartedAt ? message.thinkingEndedAt - message.thinkingStartedAt : undefined);
	const label = kind === "thinking" ? c.thinking : kind === "reply" ? c.interimReply : tool?.name.split("__").at(-1) || c.tool;
	return (
		<View style={{ borderLeftWidth: 1, borderLeftColor: colors.border, paddingLeft: 9, marginLeft: 4, marginBottom: 2 }}>
			<Touch accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggle} style={{ minHeight: 32, justifyContent: "center", paddingVertical: 2 }}>
				<View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
					<Icon size={14} color={tool?.status === "error" ? colors.danger : colors.secondary} />
					<Text numberOfLines={1} style={{ ...typeScale.process, flexShrink: 1, color: colors.secondary, fontFamily: kind === "tool" ? "monospace" : undefined }}>
						{label}
					</Text>
					{tool && <Text style={{ ...typeScale.caption, color: tool.status === "error" ? colors.danger : colors.secondary }}>{tool.status === "running" ? c.toolRunning : tool.status === "error" ? c.processFailed : c.toolDone}</Text>}
					{duration !== undefined && duration > 0 && <Text style={{ ...typeScale.caption, color: colors.secondary }}>{duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`}</Text>}
					{expanded ? <ChevronDown size={13} color={colors.secondary} /> : <ChevronRight size={13} color={colors.secondary} />}
				</View>
				{!expanded && (
					<Text numberOfLines={1} style={{ ...typeScale.caption, paddingLeft: 21, color: colors.secondary }}>
						{detail.replace(/^工具：[^\n]*\n状态：[^\n]*\n*/, "").replace(/\s+/g, " ")}
					</Text>
				)}
			</Touch>
			{expanded && (
				<Text selectable style={{ ...typeScale.process, color: colors.secondary, fontFamily: kind === "tool" ? "monospace" : undefined, paddingVertical: 3 }}>
					{detail}
				</Text>
			)}
			{expanded && truncated && <FullLink message={message} channel={channel} colors={colors} open={open} />}
		</View>
	);
}
