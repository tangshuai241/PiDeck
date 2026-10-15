import { Touch as Pressable, useReducedMotion } from "./Motion";
import type { ReactNode } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Search, X } from "lucide-react-native";
import Svg, { Path } from "react-native-svg";
import type { Palette } from "../theme";
import { c } from "../copy";

/** Reuse the desktop mark geometry in native SVG; no web content or screenshot is embedded. */
export function BrandGlyph({ color, size = 20 }: { color: string; size?: number }) {
	return (
		<Svg width={size} height={size} viewBox="140 140 520 520">
			<Path fill={color} fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
			<Path fill={color} d="M517.36 400H634.72V634.72H517.36Z" />
		</Svg>
	);
}
/** Circular controls retain a full 44dp touch target even when their glyph is smaller. */
export function Action({ label, onPress, children, colors, filled = false, large = false, disabled = false }: { label: string; onPress: () => void; children: ReactNode; colors: Palette; filled?: boolean; large?: boolean; disabled?: boolean }) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={label}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => ({ width: large ? 48 : 44, height: large ? 48 : 44, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: filled ? 0 : 1, borderColor: colors.border, backgroundColor: filled ? colors.field : "transparent", opacity: disabled ? 0.4 : pressed ? 0.65 : 1 })}
		>
			{children}
		</Pressable>
	);
}
export function SearchField({ value, change, placeholder, colors }: { value: string; change: (value: string) => void; placeholder: string; colors: Palette }) {
	return (
		<View style={{ flex: 1, minWidth: 0, height: 38, borderRadius: 10, backgroundColor: colors.field, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8 }}>
			<Search size={19} color={colors.secondary} />
			<TextInput accessibilityLabel={placeholder} placeholder={placeholder} placeholderTextColor={colors.secondary} value={value} onChangeText={change} style={{ flex: 1, minWidth: 0, fontSize: 14, color: colors.text, paddingVertical: 6 }} />
		</View>
	);
}
export function LabelButton({ children, onPress, colors, disabled = false, strong = false }: { children: ReactNode; onPress: () => void; colors: Palette; disabled?: boolean; strong?: boolean }) {
	return (
		<Pressable
			accessibilityRole="button"
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => ({
				minHeight: 38,
				paddingHorizontal: 14,
				paddingVertical: 8,
				borderWidth: 1,
				borderColor: colors.border,
				borderRadius: 10,
				backgroundColor: strong ? colors.strong : colors.surface,
				opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
				flexDirection: "row",
				alignItems: "center",
				justifyContent: "center",
				gap: 8,
			})}
		>
			{typeof children === "string" ? <Text style={{ color: strong ? colors.background : colors.text, fontSize: 13 }}>{children}</Text> : children}
		</Pressable>
	);
}
/** Native modal owns dimming, Android back and the bottom-sheet focus surface. */
export function BottomSheet({ open, close, colors, title, children, scrollKey }: { open: boolean; close: () => void; colors: Palette; title?: string; children: ReactNode; scrollKey?: string | number }) {
	const reduced = useReducedMotion();
	return (
		<Modal visible={open} transparent animationType={reduced ? "none" : "slide"} onRequestClose={close}>
			<View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "#00000080" }}>
				<Pressable accessibilityRole="button" accessibilityLabel={c.close} onPress={close} style={StyleSheet.absoluteFill} />
				<View accessibilityViewIsModal style={{ maxHeight: "88%", backgroundColor: colors.background, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 18, paddingBottom: 16 }}>
					<View style={{ alignSelf: "center", width: 32, height: 4, borderRadius: 8, backgroundColor: colors.secondary, opacity: 0.45, marginTop: 10, marginBottom: 12 }} />
					{title && (
						<View style={{ minHeight: 26, marginBottom: 10, justifyContent: "center" }}>
							<Text style={{ textAlign: "center", color: colors.text, fontSize: 15, fontWeight: "600" }}>{title}</Text>
							<Pressable accessibilityRole="button" accessibilityLabel={c.close} onPress={close} style={{ position: "absolute", right: -4, top: -12, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
								<X size={23} color={colors.secondary} />
							</Pressable>
						</View>
					)}
					<ScrollView key={scrollKey} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
						{children}
					</ScrollView>
				</View>
			</View>
		</Modal>
	);
}
