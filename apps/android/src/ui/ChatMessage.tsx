import { memo } from "react";
import { Text, View } from "react-native";
import { UserRound } from "lucide-react-native";
import type { RemoteMessage } from "../../../../packages/tpa-remote/src/types";
import type { Palette } from "../theme";
import { FullLink, type OpenPart } from "./ProcessTimeline";
import { typeScale } from "./typography";
import { NativeMarkdown } from "./NativeMarkdown";
import { MessageActions, type MessageControls } from "./MessageActions";

/** Conversation text and compact, functional message controls share one presentation. */
export const Message = memo(function Message({ message, colors, open, controls }: { message: RemoteMessage; colors: Palette; open: OpenPart; controls: MessageControls }) {
	if (message.role === "user")
		return (
			<View style={{ alignItems: "flex-end", marginTop: 6, marginBottom: 10 }}>
				<Text style={{ ...typeScale.caption, color: colors.secondary, marginRight: 36, marginBottom: 4 }}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</Text>
				<View style={{ maxWidth: "94%", flexDirection: "row", alignItems: "center", gap: 8 }}>
					<View style={{ flexShrink: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, backgroundColor: colors.muted }}>
						<Text selectable style={{ ...typeScale.body, color: colors.text }}>
							{message.text}
						</Text>
						{message.textTruncated && <FullLink message={message} channel="text" colors={colors} open={open} />}
					</View>
					<View style={{ width: 28, height: 28, borderRadius: 10, backgroundColor: colors.field, alignItems: "center", justifyContent: "center" }}>
						<UserRound size={16} color={colors.text} />
					</View>
				</View>
				<MessageActions message={message} controls={controls} colors={colors} />
			</View>
		);
	return (
		<View style={{ marginBottom: 12 }}>
			{message.role === "assistant" && !!message.text ? (
				<NativeMarkdown text={message.text} colors={colors} />
			) : (
				!!message.text && (
					<Text selectable style={{ ...typeScale.body, color: message.role === "error" ? colors.danger : colors.secondary }}>
						{message.text}
					</Text>
				)
			)}
			{message.textTruncated && <FullLink message={message} channel="text" colors={colors} open={open} />}
			{message.role === "tool" && message.toolTruncated && <FullLink message={message} channel="tool" colors={colors} open={open} />}
			{message.role === "assistant" && <MessageActions message={message} controls={controls} colors={colors} />}
		</View>
	);
});
