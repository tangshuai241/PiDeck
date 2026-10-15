import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { RemoteQuestion } from "../../../packages/tpa-remote/src/types";
import type { Palette } from "./theme";
import { c } from "./copy";
import { createStyles } from "./styles";

/** Answers are bound to the original pending question and runtime. */
export function QuestionCard({ question, colors, disabled, answer }: { question: RemoteQuestion; colors: Palette; disabled: boolean; answer: (value: boolean | string) => void }) {
	const [text, setText] = useState("");
	const styles = createStyles(colors);
	return (
		<View style={styles.question}>
			<Text style={styles.caption}>{c.question}</Text>
			<Text style={[styles.body, { marginVertical: 12 }]}>{question.title}</Text>
			{question.method === "confirm" ? (
				<>
					<Pressable accessibilityRole="button" disabled={disabled} style={styles.primary} onPress={() => answer(true)}>
						<Text style={styles.primaryLabel}>{c.approve}</Text>
					</Pressable>
					<Pressable accessibilityRole="button" disabled={disabled} style={styles.secondaryButton} onPress={() => answer(false)}>
						<Text style={styles.body}>{c.reject}</Text>
					</Pressable>
				</>
			) : question.method === "select" && question.options ? (
				question.options.map((option) => (
					<Pressable key={option} accessibilityRole="button" disabled={disabled} style={styles.secondaryButton} onPress={() => answer(option)}>
						<Text style={styles.body}>{option}</Text>
					</Pressable>
				))
			) : question.method === "input" || question.method === "editor" ? (
				<>
					<TextInput accessibilityLabel={c.answer} placeholder={c.answer} placeholderTextColor={colors.secondary} value={text} onChangeText={setText} style={styles.input} multiline maxLength={20_000} />
					<Pressable accessibilityRole="button" disabled={disabled || !text.trim()} style={styles.primary} onPress={() => answer(text)}>
						<Text style={styles.primaryLabel}>{c.submit}</Text>
					</Pressable>
				</>
			) : (
				<Text style={styles.secondary}>{c.desktopQuestion}</Text>
			)}
		</View>
	);
}
