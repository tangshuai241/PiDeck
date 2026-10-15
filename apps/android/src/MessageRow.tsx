import { memo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { RemoteMessage } from "../../../packages/tpa-remote/src/types";
import type { Palette } from "./theme";
import { c } from "./copy";

/** Stable message identities keep history rows out of current-message updates. */
export const MessageRow = memo(function MessageRow({ message, colors }: { message: RemoteMessage; colors: Palette }) {
	const [expanded, setExpanded] = useState(false);
	if (message.role === "tool")
		return (
			<Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} style={{ paddingVertical: 12 }}>
				<Text style={{ color: colors.secondary, fontSize: 13 }}>{expanded ? c.hideTool : c.tool}</Text>
				{expanded && (
					<Text selectable style={{ color: colors.secondary, fontSize: 13, lineHeight: 22, marginTop: 8 }}>
						{message.text}
					</Text>
				)}
			</Pressable>
		);
	return (
		<View
			style={{
				alignSelf: message.role === "user" ? "flex-end" : "stretch",
				maxWidth: message.role === "user" ? "92%" : "100%",
				backgroundColor: message.role === "user" ? colors.muted : "transparent",
				borderRadius: 22,
				borderBottomRightRadius: message.role === "user" ? 5 : 22,
				padding: message.role === "user" ? 15 : 0,
				marginBottom: 22,
			}}
		>
			<Text selectable style={{ color: message.role === "error" ? colors.danger : colors.text, fontSize: 16, lineHeight: 28 }}>
				{message.text}
			</Text>
		</View>
	);
});
