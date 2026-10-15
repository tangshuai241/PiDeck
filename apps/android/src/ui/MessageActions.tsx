import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { Check, Copy, GitFork, Pin } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import type { RemoteMessage } from "../../../../packages/tpa-remote/src/types";
import type { Palette } from "../theme";
import { c } from "../copy";
import { Touch } from "./Motion";

export type MessageControls = { pinned: boolean; busy: boolean; connected: boolean; fork: () => void; pin: () => void; full: () => void };
/** Small glyphs keep independent targets and real outcomes; copy confirmation clears on unmount. */
export function MessageActions({ message, controls, colors }: { message: RemoteMessage; controls: MessageControls; colors: Palette }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (timer.current) clearTimeout(timer.current);
		};
	}, []);
	async function copy() {
		if (message.textTruncated) {
			controls.full();
			return;
		}
		try {
			await Clipboard.setStringAsync(message.text);
			if (!mounted.current) return;
			setCopied(true);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 1500);
		} catch {
			Alert.alert(c.error);
		}
	}
	return (
		<View style={{ flexDirection: "row", gap: 4, alignSelf: message.role === "user" ? "flex-end" : "flex-start", marginTop: 2 }}>
			{message.role === "user" && (
				<Touch
					accessibilityRole="button"
					accessibilityLabel={c.forkFromMessage}
					disabled={controls.busy || !controls.connected || !message.entryId}
					onPress={controls.fork}
					style={{ width: 32, height: 30, alignItems: "center", justifyContent: "center", opacity: controls.busy || !controls.connected || !message.entryId ? 0.35 : 1 }}
				>
					<GitFork size={14} color={colors.secondary} />
				</Touch>
			)}
			<Touch accessibilityRole="button" accessibilityLabel={controls.pinned ? c.unpinMessage : c.pinMessage} accessibilityState={{ selected: controls.pinned }} onPress={controls.pin} style={{ width: 32, height: 30, alignItems: "center", justifyContent: "center" }}>
				<Pin size={14} color={controls.pinned ? colors.primary : colors.secondary} />
			</Touch>
			<Touch
				accessibilityRole="button"
				accessibilityLabel={c.copyMessage}
				onPress={() => {
					void copy();
				}}
				style={{ width: 32, height: 30, alignItems: "center", justifyContent: "center" }}
			>
				{copied ? <Check size={14} color={colors.success} /> : <Copy size={14} color={colors.secondary} />}
			</Touch>
		</View>
	);
}
