import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Check } from "lucide-react-native";
import type { RemoteBatchQuestion, RemoteQuestion } from "../../../packages/tpa-remote/src/types";
import { serializeBatchAnswers, type AskAnswerValue } from "../../../packages/tpa-remote/src/ask";
import type { Palette } from "./theme";
import { c } from "./copy";

type Draft = Record<string, string | boolean | string[] | undefined>;

function optionLabel(option: string | { label: string; value?: string; description?: string }): string {
	return typeof option === "string" ? option : option.label;
}

function optionValue(option: string | { label: string; value?: string; description?: string }): string {
	return typeof option === "string" ? option : (option.value ?? option.label);
}

function answered(value: AskAnswerValue): boolean {
	return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
}

/** 选择题选项：紧凑 chip，选中态同时用边框、底色和勾选标记区分，避免“看不出选没选”。 */
function Chip({ label, selected, disabled, colors, onPress }: { label: string; selected: boolean; disabled: boolean; colors: Palette; onPress: () => void }) {
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ selected }}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => ({
				minHeight: 34,
				paddingHorizontal: 11,
				paddingVertical: 7,
				borderRadius: 10,
				borderWidth: 1,
				borderColor: selected ? colors.primary : colors.border,
				backgroundColor: selected ? colors.selected : colors.surface,
				flexDirection: "row",
				alignItems: "center",
				gap: 5,
				opacity: disabled ? 0.5 : pressed ? 0.6 : 1,
			})}
		>
			{selected ? <Check size={13} color={colors.primary} /> : null}
			<Text style={{ fontSize: 13, lineHeight: 18, color: selected ? colors.primary : colors.text }}>{label}</Text>
		</Pressable>
	);
}

/** 手机端问答卡：紧凑排版 + 明确选中态；批量题按题型逐题渲染，提交信封与桌面一致。 */
export function QuestionCard({ question, colors, disabled, answer }: { question: RemoteQuestion; colors: Palette; disabled: boolean; answer: (value: boolean | string) => void }) {
	const batch = question.method === "batch_ask" ? (question.batchQuestions ?? []) : [];
	const [draft, setDraft] = useState<Draft>(() => {
		const initial: Draft = {};
		for (const item of question.batchQuestions ?? []) {
			if (item.type === "multi_select") initial[item.id] = [];
			else if (item.type !== "confirm") initial[item.id] = item.prefill ?? "";
		}
		return initial;
	});
	const [single, setSingle] = useState(question.prefill ?? "");
	const update = (id: string, value: string | boolean | string[]) => setDraft((current) => ({ ...current, [id]: value }));
	const toggle = (item: RemoteBatchQuestion, value: string) => {
		const current = Array.isArray(draft[item.id]) ? (draft[item.id] as string[]) : [];
		update(item.id, current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]);
	};
	const answeredCount = batch.filter((item) => answered(draft[item.id])).length;
	const complete = answeredCount === batch.length;
	const field = { minHeight: 38, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, color: colors.text, fontSize: 13, lineHeight: 19, textAlignVertical: "top" as const };
	const submit = (onPress: () => void, enabled: boolean) => (
		<Pressable accessibilityRole="button" disabled={disabled || !enabled} onPress={onPress} style={{ minHeight: 42, marginTop: 12, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary, opacity: disabled || !enabled ? 0.4 : 1 }}>
			<Text style={{ color: colors.onPrimary, fontSize: 14, lineHeight: 20, fontWeight: "600" }}>{c.submit}</Text>
		</Pressable>
	);
	const header = (
		<View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
			<View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, backgroundColor: colors.selected }}>
				<Text style={{ color: colors.primary, fontSize: 11, lineHeight: 15, fontWeight: "600" }}>{c.answerNeeded}</Text>
			</View>
			{batch.length > 0 ? (
				<Text style={{ marginLeft: "auto", color: colors.secondary, fontSize: 11 }}>
					{answeredCount}/{batch.length}
				</Text>
			) : null}
		</View>
	);

	if (question.method === "batch_ask" && batch.length > 0) {
		return (
			<View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 13, marginTop: 10 }}>
				{header}
				{batch.map((item, index) => (
					<View key={item.id} style={{ marginTop: index === 0 ? 10 : 14 }}>
						<View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 7 }}>
							<Text style={{ color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: "600" }}>{item.question}</Text>
							{item.type === "multi_select" ? <Text style={{ color: colors.secondary, fontSize: 10 }}>{c.multiSelectHint}</Text> : null}
						</View>
						{item.type === "multi_select" ? (
							<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
								{(item.options ?? []).map((option) => {
									const value = optionValue(option);
									return <Chip key={value} label={optionLabel(option)} selected={Array.isArray(draft[item.id]) && (draft[item.id] as string[]).includes(value)} disabled={disabled} colors={colors} onPress={() => toggle(item, value)} />;
								})}
							</View>
						) : item.type === "select" && (item.options?.length ?? 0) > 0 ? (
							<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
								{(item.options ?? []).map((option) => {
									const value = optionValue(option);
									return <Chip key={value} label={optionLabel(option)} selected={draft[item.id] === value} disabled={disabled} colors={colors} onPress={() => update(item.id, value)} />;
								})}
							</View>
						) : item.type === "confirm" ? (
							<View style={{ flexDirection: "row", gap: 8 }}>
								<Chip label={c.approve} selected={draft[item.id] === true} disabled={disabled} colors={colors} onPress={() => update(item.id, true)} />
								<Chip label={c.rejectShort} selected={draft[item.id] === false} disabled={disabled} colors={colors} onPress={() => update(item.id, false)} />
							</View>
						) : (
							<TextInput
								accessibilityLabel={item.question}
								placeholder={item.placeholder ?? c.answer}
								placeholderTextColor={colors.secondary}
								value={typeof draft[item.id] === "string" ? (draft[item.id] as string) : ""}
								onChangeText={(text) => update(item.id, text)}
								style={[field, item.type === "editor" ? { minHeight: 64 } : null]}
								multiline={item.type === "editor"}
								maxLength={20_000}
							/>
						)}
						{item.type === "select" && item.allowOther ? (
							<TextInput
								accessibilityLabel={c.customAnswer}
								placeholder={item.placeholder ?? c.customAnswer}
								placeholderTextColor={colors.secondary}
								value={typeof draft[item.id] === "string" ? (draft[item.id] as string) : ""}
								onChangeText={(text) => update(item.id, text)}
								style={[field, { marginTop: 6 }]}
								maxLength={20_000}
							/>
						) : null}
					</View>
				))}
				{submit(() => answer(serializeBatchAnswers(batch, draft)), complete)}
				{!complete ? <Text style={{ color: colors.secondary, fontSize: 11, marginTop: 6, textAlign: "center" }}>{c.answerRemaining.replace("{count}", String(batch.length - answeredCount))}</Text> : null}
			</View>
		);
	}

	return (
		<View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 13, marginTop: 10 }}>
			{header}
			<Text style={{ color: colors.text, fontSize: 13, lineHeight: 19, marginTop: 8, marginBottom: 8 }}>{question.title}</Text>
			{question.method === "confirm" ? (
				<View style={{ flexDirection: "row", gap: 8 }}>
					<Pressable accessibilityRole="button" disabled={disabled} onPress={() => answer(true)} style={{ flex: 1, minHeight: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary }}>
						<Text style={{ color: colors.onPrimary, fontSize: 13, fontWeight: "600" }}>{c.approve}</Text>
					</Pressable>
					<Pressable accessibilityRole="button" disabled={disabled} onPress={() => answer(false)} style={{ flex: 1, minHeight: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border }}>
						<Text style={{ color: colors.text, fontSize: 13 }}>{c.rejectShort}</Text>
					</Pressable>
				</View>
			) : question.method === "select" && question.options ? (
				<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
					{question.options.map((option) => (
						<Chip key={option} label={option} selected={false} disabled={disabled} colors={colors} onPress={() => answer(option)} />
					))}
				</View>
			) : question.method === "input" || question.method === "editor" ? (
				<TextInput
					accessibilityLabel={c.answer}
					placeholder={question.placeholder ?? c.answer}
					placeholderTextColor={colors.secondary}
					value={single}
					onChangeText={setSingle}
					style={[field, question.method === "editor" ? { minHeight: 64 } : null]}
					multiline={question.method === "editor"}
					maxLength={20_000}
				/>
			) : (
				<Text style={{ color: colors.secondary, fontSize: 13 }}>{c.desktopQuestion}</Text>
			)}
			{question.method === "select" && question.allowOther ? (
				<>
					<TextInput accessibilityLabel={c.customAnswer} placeholder={question.placeholder ?? c.customAnswer} placeholderTextColor={colors.secondary} value={single} onChangeText={setSingle} style={[field, { marginTop: 6 }]} maxLength={20_000} />
					{submit(() => answer(single), single.trim().length > 0)}
				</>
			) : question.method === "input" || question.method === "editor" ? (
				submit(() => answer(single), single.trim().length > 0)
			) : null}
		</View>
	);
}
