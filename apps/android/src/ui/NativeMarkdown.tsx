import { memo, useMemo, type ReactNode } from "react";
import { Alert, Linking, ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { Definition, Nodes, Table } from "mdast";
import type { Palette } from "../theme";
import { c } from "../copy";
import { markdownText, parseNativeMarkdown, safeMarkdownUrl, tableColumnWidths } from "../markdown";
import { typeScale } from "./typography";

/** GFM presentation in native views; no WebView, HTML execution or remote-image requests. */
export const NativeMarkdown = memo(function NativeMarkdown({ text, colors }: { text: string; colors: Palette }) {
	const tree = useMemo(() => parseNativeMarkdown(text), [text]);
	const { fontScale } = useWindowDimensions();
	const definitions = new Map<string, Definition>();
	for (const node of tree.children) if (node.type === "definition") definitions.set(node.identifier, node);
	const body = { ...typeScale.body, color: colors.text };
	function openLink(value: string) {
		const url = safeMarkdownUrl(value);
		if (url) void Linking.openURL(url).catch(() => Alert.alert(c.openFailed));
	}
	function inline(node: Nodes, key: number): ReactNode {
		const children = "children" in node ? node.children.map(inline) : undefined;
		switch (node.type) {
			case "text":
			case "html":
				return node.value;
			case "break":
				return "\n";
			case "strong":
				return (
					<Text key={key} style={{ fontWeight: "700" }}>
						{children}
					</Text>
				);
			case "emphasis":
				return (
					<Text key={key} style={{ fontStyle: "italic" }}>
						{children}
					</Text>
				);
			case "delete":
				return (
					<Text key={key} style={{ textDecorationLine: "line-through" }}>
						{children}
					</Text>
				);
			case "inlineCode":
				return (
					<Text key={key} style={{ fontFamily: "monospace", backgroundColor: colors.muted }}>
						{node.value}
					</Text>
				);
			case "link":
			case "linkReference": {
				const url = node.type === "link" ? node.url : definitions.get(node.identifier)?.url;
				return url && safeMarkdownUrl(url) ? (
					<Text key={key} accessibilityRole="link" onPress={() => openLink(url)} style={{ color: colors.primary, textDecorationLine: "underline" }}>
						{children}
					</Text>
				) : (
					children
				);
			}
			case "image":
			case "imageReference":
				return node.alt || (node.type === "image" ? node.title : "") || "";
			case "footnoteReference":
				return `[${node.label || node.identifier}]`;
			default:
				return children || markdownText(node);
		}
	}
	function table(node: Table, key: number) {
		const widths = tableColumnWidths(node).map((width) => width * fontScale);
		return (
			<ScrollView key={key} horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={{ marginBottom: 10 }}>
				<View style={{ borderTopWidth: 1, borderLeftWidth: 1, borderColor: colors.border }}>
					{node.children.map((row, rowIndex) => (
						<View key={rowIndex} style={{ flexDirection: "row", backgroundColor: rowIndex === 0 ? colors.muted : rowIndex % 2 ? colors.surface : colors.background }}>
							{widths.map((width, col) => (
								<View key={col} style={{ width, paddingHorizontal: 8, paddingVertical: 7, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border }}>
									<Text selectable accessibilityRole={rowIndex === 0 ? "header" : undefined} style={{ ...typeScale.process, color: colors.text, fontWeight: rowIndex === 0 ? "600" : "400", textAlign: node.align?.[col] || "left" }}>
										{row.children[col]?.children.map(inline)}
									</Text>
								</View>
							))}
						</View>
					))}
				</View>
			</ScrollView>
		);
	}
	function block(node: Nodes, key: number): ReactNode {
		switch (node.type) {
			case "paragraph":
				return (
					<Text key={key} selectable style={{ ...body, marginBottom: 6 }}>
						{node.children.map(inline)}
					</Text>
				);
			case "heading":
				return (
					<Text key={key} selectable accessibilityRole="header" style={{ ...body, fontSize: node.depth <= 2 ? 16 : 14, lineHeight: node.depth <= 2 ? 23 : 20, fontWeight: "600", marginTop: 6, marginBottom: 8 }}>
						{node.children.map(inline)}
					</Text>
				);
			case "table":
				return table(node, key);
			case "code":
				return (
					<View key={key} style={{ backgroundColor: colors.muted, borderRadius: 7, padding: 10, marginBottom: 10 }}>
						{!!node.lang && <Text style={{ ...typeScale.caption, color: colors.secondary, marginBottom: 5 }}>{node.lang}</Text>}
						<ScrollView horizontal nestedScrollEnabled>
							<Text selectable style={{ ...typeScale.process, color: colors.text, fontFamily: "monospace" }}>
								{node.value}
							</Text>
						</ScrollView>
					</View>
				);
			case "blockquote":
				return (
					<View key={key} style={{ borderLeftWidth: 2, borderColor: colors.border, paddingLeft: 10, marginBottom: 8 }}>
						{node.children.map(block)}
					</View>
				);
			case "list":
				return (
					<View key={key} style={{ marginBottom: 8 }}>
						{node.children.map((item, index) => (
							<View key={index} style={{ flexDirection: "row", gap: 6 }}>
								<Text style={{ ...body, minWidth: 18 }}>{typeof item.checked === "boolean" ? (item.checked ? "☑" : "☐") : node.ordered ? `${(node.start ?? 1) + index}.` : "•"}</Text>
								<View style={{ flex: 1 }}>{item.children.map(block)}</View>
							</View>
						))}
					</View>
				);
			case "thematicBreak":
				return <View key={key} style={{ height: 1, backgroundColor: colors.border, marginVertical: 10 }} />;
			case "definition":
				return null;
			case "footnoteDefinition":
				return (
					<View key={key}>
						<Text style={body}>[{node.label || node.identifier}]</Text>
						{node.children.map(block)}
					</View>
				);
			default:
				return (
					<Text key={key} selectable style={body}>
						{inline(node, key)}
					</Text>
				);
		}
	}
	return <View>{tree.children.map(block)}</View>;
});
