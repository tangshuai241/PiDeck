import { Text, View } from "react-native";
import type { PinnedMessage } from "../mobilePreferences";
import type { Palette } from "../theme";
import { c } from "../copy";
import { BottomSheet } from "./MobilePrimitives";
import { Touch } from "./Motion";
import { typeScale } from "./typography";

/** Bookmarks open the original message reader even when its timeline row has been recycled. */
export function PinnedMessagesSheet({ open, close, pins, read, colors }: { open: boolean; close: () => void; pins: PinnedMessage[]; read: (pin: PinnedMessage) => void; colors: Palette }) {
	return (
		<BottomSheet open={open} close={close} colors={colors} title={c.pinnedMessages}>
			{!pins.length && <Text style={{ ...typeScale.body, color: colors.secondary }}>{c.noPins}</Text>}
			{pins.map((pin) => (
				<Touch
					key={pin.key}
					accessibilityRole="button"
					onPress={() => {
						close();
						read(pin);
					}}
					style={{ padding: 10, borderRadius: 8, backgroundColor: colors.surface }}
				>
					<View>
						<Text numberOfLines={3} style={{ ...typeScale.body, color: colors.text }}>
							{pin.text}
						</Text>
						<Text style={{ ...typeScale.caption, color: colors.secondary, marginTop: 4 }}>{new Date(pin.timestamp).toLocaleString()}</Text>
					</View>
				</Touch>
			))}
		</BottomSheet>
	);
}
