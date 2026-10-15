import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, KeyboardAvoidingView, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Restore flex layout on Android hide, whose reported frame can exclude the status bar. */
export function KeyboardFrame({ children }: { children: ReactNode }) {
	const insets = useSafeAreaInsets();
	const [visible, setVisible] = useState(Keyboard.isVisible());
	useEffect(() => {
		if (Platform.OS !== "android") return;
		const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
		const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return (
		<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : visible ? "height" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? insets.top : 0}>
			{children}
		</KeyboardAvoidingView>
	);
}
