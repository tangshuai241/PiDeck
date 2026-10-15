import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ChevronDown, FolderOpen, Monitor, X } from "lucide-react-native";
import type { RemoteProject, RemoteTaskInput } from "../../../../packages/tpa-remote/src/types";
import type { Palette } from "../theme";
import { c } from "../copy";
import { parseTaskTime } from "../taskForm";
import { Action, BrandGlyph, LabelButton } from "./MobilePrimitives";

/** Form writes only through the desktop scheduler catalog after an explicit Save. */
export function TaskEditorScreen({ colors, projects, project, close, save, working }: { colors: Palette; projects: RemoteProject[]; project?: RemoteProject; close: () => void; save: (task: RemoteTaskInput) => Promise<boolean>; working: boolean }) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [selected, setSelected] = useState(project);
	const [choosing, setChoosing] = useState(false);
	const [trigger, setTrigger] = useState<"daily" | "manual">("daily");
	const [time, setTime] = useState("09:00");
	const row = (label: string, body: React.ReactNode) => (
		<View style={{ minHeight: 79, borderBottomWidth: 1, borderColor: colors.border, paddingHorizontal: 15, paddingTop: 8, paddingBottom: 9, justifyContent: "space-between", alignItems: "flex-end" }}>
			<Text style={{ alignSelf: "flex-start", color: colors.secondary, fontSize: 13 }}>{label}</Text>
			{body}
		</View>
	);
	async function submit() {
		const parsed = parseTaskTime(time);
		if (!name.trim() || !prompt.trim() || !selected || !parsed) {
			Alert.alert(c.brand, c.fillTask);
			return;
		}
		if (await save({ name: name.trim(), projectId: selected.id, prompt, trigger, ...parsed })) close();
	}
	return (
		<View style={{ flex: 1 }}>
			<View style={{ minHeight: 55, paddingLeft: 10, borderBottomWidth: 1, borderColor: colors.border, justifyContent: "center" }}>
				<Action label={c.close} onPress={close} colors={colors}>
					<X size={20} color={colors.secondary} />
				</Action>
			</View>
			<ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingTop: 25, paddingBottom: 60 }}>
				<View style={{ minHeight: 225, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 15, paddingVertical: 10 }}>
					<TextInput accessibilityLabel={c.taskName} placeholder={c.taskName} placeholderTextColor={colors.secondary} value={name} onChangeText={setName} maxLength={120} style={{ minHeight: 47, borderBottomWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 21, fontWeight: "500", padding: 0 }} />
					<TextInput
						accessibilityLabel={c.taskPrompt}
						placeholder={c.taskPrompt}
						placeholderTextColor={colors.secondary}
						value={prompt}
						onChangeText={setPrompt}
						multiline
						maxLength={20_000}
						style={{ minHeight: 109, maxHeight: 240, fontSize: 13, lineHeight: 27, color: colors.text, textAlignVertical: "top", padding: 0, marginTop: 10 }}
					/>
					<View style={{ minHeight: 36, flexDirection: "row", alignItems: "center", gap: 7 }}>
						<BrandGlyph color={colors.secondary} />
						<Text style={{ color: colors.secondary, fontSize: 13 }}>{c.followModel}</Text>
					</View>
				</View>
				<View style={{ flexDirection: "row", gap: 5, marginTop: 9 }}>
					<LabelButton colors={colors} onPress={() => Alert.alert(c.brand, c.hostTime)}>
						<Monitor size={18} color={colors.text} />
						<Text style={{ color: colors.text, fontSize: 13 }}>{c.hostLabel}</Text>
					</LabelButton>
					<LabelButton colors={colors} onPress={() => setChoosing(!choosing)}>
						<FolderOpen size={20} color={colors.text} />
						<Text style={{ color: colors.text, fontSize: 13 }}>{selected?.name || c.chooseProject}</Text>
					</LabelButton>
				</View>
				{choosing && (
					<View style={{ gap: 4, marginTop: 10 }}>
						{projects.map((item) => (
							<LabelButton
								key={item.id}
								colors={colors}
								onPress={() => {
									setSelected(item);
									setChoosing(false);
								}}
							>
								{item.name}
							</LabelButton>
						))}
					</View>
				)}
				<Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 21, marginTop: 10, marginBottom: 25, paddingHorizontal: 7 }}>{selected ? c.hostTaskHint : c.noProjectHint}</Text>
				<View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 11, overflow: "hidden", backgroundColor: colors.surface }}>
					{row(
						c.destination,
						<LabelButton colors={colors} onPress={() => Alert.alert(c.brand, c.eachNewChat)}>
							{c.eachNewChat}
						</LabelButton>,
					)}
					{row(
						c.trigger,
						<View style={{ flexDirection: "row", borderRadius: 6, backgroundColor: colors.muted, padding: 2 }}>
							{[
								{ id: "daily", name: c.timed },
								{ id: "manual", name: c.manual },
							].map((item) => (
								<Pressable
									key={item.id}
									accessibilityRole="button"
									accessibilityState={{ selected: trigger === item.id }}
									onPress={() => setTrigger(item.id === "daily" ? "daily" : "manual")}
									style={{ minHeight: 34, minWidth: 62, borderRadius: 5, alignItems: "center", justifyContent: "center", borderWidth: trigger === item.id ? 1 : 0, borderColor: colors.border, backgroundColor: trigger === item.id ? colors.surface : "transparent" }}
								>
									<Text style={{ color: trigger === item.id ? colors.text : colors.secondary, fontSize: 13 }}>{item.name}</Text>
								</Pressable>
							))}
						</View>,
					)}
					{trigger === "daily" && (
						<>
							{row(
								c.repeat,
								<View style={{ minHeight: 35, paddingHorizontal: 10, borderRadius: 11, backgroundColor: colors.muted, flexDirection: "row", gap: 12, alignItems: "center" }}>
									<Text style={{ color: colors.text, fontSize: 13 }}>{c.daily}</Text>
									<ChevronDown size={18} color={colors.secondary} />
								</View>,
							)}
							{row(c.time, <TextInput accessibilityLabel={c.time} value={time} onChangeText={setTime} maxLength={5} style={{ minHeight: 38, minWidth: 70, textAlign: "right", fontSize: 14, color: colors.text, padding: 0 }} />)}
						</>
					)}
					<Text style={{ paddingHorizontal: 15, paddingVertical: 10, fontSize: 14, lineHeight: 19, color: colors.secondary }}>{c.hostTime}</Text>
				</View>
				<View style={{ marginTop: 24, paddingTop: 30, borderTopWidth: 1, borderColor: colors.border, alignItems: "flex-end" }}>
					<LabelButton
						colors={colors}
						strong
						disabled={working}
						onPress={() => {
							void submit();
						}}
					>
						{c.saveTask}
					</LabelButton>
				</View>
			</ScrollView>
		</View>
	);
}
