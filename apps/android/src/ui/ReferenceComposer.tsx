import { Touch as Pressable } from "./Motion";
import { Text, TextInput, View } from "react-native";
import { ArrowUp, CloudOff, Folder, Square, Cloud, ChevronDown } from "lucide-react-native";
import type { Palette } from "../theme";
import { c } from "../copy";

/** Fixed native composer follows the reference and binds every action to the host state. */
export function ReferenceComposer({
	colors,
	draft,
	change,
	send,
	stop,
	connected,
	busy,
	disabled,
	project,
	model,
	showContext = true,
	settings,
	chooseProject,
	chooseModel,
}: {
	colors: Palette;
	draft: string;
	change: (text: string) => void;
	send: () => void;
	stop?: () => void;
	connected: boolean;
	busy: boolean;
	disabled: boolean;
	project?: string;
	model?: string;
	showContext?: boolean;
	settings: () => void;
	chooseProject: () => void;
	chooseModel?: () => void;
}) {
	return (
		<View style={{ paddingHorizontal: 12, paddingBottom: 4, backgroundColor: colors.background }}>
			<View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 11, paddingTop: 3, paddingBottom: 3, backgroundColor: colors.surface }}>
				{showContext && (
					<View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
						<Pressable accessibilityRole="button" accessibilityLabel={c.settings} onPress={settings} style={{ width: 44, height: 36, alignItems: "center", justifyContent: "center" }}>
							{connected ? <Cloud size={16} color={colors.success} /> : <CloudOff size={16} color={colors.secondary} />}
						</Pressable>
						<Pressable accessibilityRole="button" onPress={chooseProject} style={{ minHeight: 36, flex: 1, flexDirection: "row", alignItems: "center", gap: 7 }}>
							<Folder size={14} color={colors.secondary} />
							<Text numberOfLines={1} style={{ fontSize: 11, color: colors.secondary }}>
								{project || c.noneSelected}
							</Text>
						</Pressable>
					</View>
				)}
				{!connected && <Text style={{ fontSize: 11, color: colors.secondary }}>{c.offlineHint}</Text>}
				<TextInput
					accessibilityLabel={c.emptyChat}
					placeholder={c.emptyChat}
					placeholderTextColor={colors.secondary}
					value={draft}
					onChangeText={change}
					multiline
					maxLength={20_000}
					style={{ color: colors.text, fontSize: 13, lineHeight: 20, minHeight: 26, maxHeight: 120, padding: 0, paddingHorizontal: 2, textAlignVertical: "top" }}
				/>
				<View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 40 }}>
					<Pressable accessibilityRole="button" accessibilityLabel={c.chooseModel} onPress={chooseModel} disabled={!chooseModel} style={{ flex: 1, minHeight: 32, flexDirection: "row", gap: 5, alignItems: "center" }}>
						<Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 11, color: colors.secondary }}>
							{model || c.chooseModel}
						</Text>
						<ChevronDown size={12} color={colors.secondary} />
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={busy ? c.stop : c.send}
						onPress={busy && stop ? stop : send}
						disabled={!connected || disabled || (!busy && !draft.trim())}
						style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: !connected || disabled || (!busy && !draft.trim()) ? 0.4 : 1 }}
					>
						<View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: colors.strong, alignItems: "center", justifyContent: "center" }}>{busy ? <Square size={13} color={colors.background} /> : <ArrowUp size={19} color={colors.background} />}</View>
					</Pressable>
				</View>
			</View>
		</View>
	);
}
