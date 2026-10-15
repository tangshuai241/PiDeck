import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { MessageChannel, RemoteMessagePart } from "../../../../packages/tpa-remote/src/types";
import type { PhoneClient } from "../phoneClient";
import type { Palette } from "../theme";
import { c } from "../copy";
import { BottomSheet, LabelButton } from "./MobilePrimitives";
import { legacyBodyPage, initialBodyPageState, type BodyPageState } from "../legacyBodyPage";
import { typeScale } from "./typography";
import { NativeMarkdown } from "./NativeMarkdown";

export type FullMessageSelection = { messageId: string; entryId?: string; channel: MessageChannel; channelsSeparated?: boolean; thinking?: string; role?: string };

/** Keep one bounded page in memory; a changed source must be reloaded rather than stitched across versions. */
export function FullMessageSheet({ selection, sessionId, client, colors, close }: { selection?: FullMessageSelection; sessionId?: string; client: PhoneClient; colors: Palette; close: () => void }) {
	const [page, setPage] = useState<RemoteMessagePart>();
	const [previous, setPrevious] = useState<number[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(false);
	const epoch = useRef(0);
	const pending = useRef(false);
	const bodyStates = useRef(new Map<number, BodyPageState>());
	const [visibleText, setVisibleText] = useState("");
	async function load(offset: number, trail: number[], version?: string) {
		if (!selection || !sessionId || pending.current) return;
		const generation = epoch.current;
		pending.current = true;
		setLoading(true);
		setError(false);
		try {
			const result = await client.messagePart(sessionId, selection.messageId, selection.channel, offset, selection.entryId, version);
			if (generation !== epoch.current) return;
			// Compatibility is presentation-only: offsets and hashes remain host-owned.
			if (selection.channel === "text" && selection.role === "assistant" && !selection.channelsSeparated && selection.thinking) {
				const decoded = legacyBodyPage(result.text, bodyStates.current.get(offset) ?? initialBodyPageState(), result.nextOffset === null);
				if (result.nextOffset !== null) bodyStates.current.set(result.nextOffset, decoded.state);
				setVisibleText(decoded.text);
			} else setVisibleText(result.text);
			setPage(result);
			setPrevious(trail);
		} catch {
			if (generation === epoch.current) setError(true);
		} finally {
			if (generation === epoch.current) {
				pending.current = false;
				setLoading(false);
			}
		}
	}
	useEffect(() => {
		epoch.current++;
		pending.current = false;
		setPage(undefined);
		setVisibleText("");
		bodyStates.current.clear();
		setPrevious([]);
		setError(false);
		if (selection && sessionId) void load(0, []);
		return () => {
			epoch.current++;
		};
	}, [sessionId, selection?.messageId, selection?.entryId, selection?.channel, client]);
	const title = selection?.channel === "thinking" ? c.fullThinking : selection?.channel === "tool" ? c.fullTool : c.fullText;
	return (
		<BottomSheet open={!!selection} close={close} colors={colors} title={title} scrollKey={`${page?.version}-${page?.offset}`}>
			<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 10 }}>
				<LabelButton
					colors={colors}
					disabled={loading || error || !previous.length}
					onPress={() => {
						const offset = previous[previous.length - 1];
						if (offset !== undefined) void load(offset, previous.slice(0, -1), page?.version);
					}}
				>
					{c.previousPart}
				</LabelButton>
				<LabelButton
					colors={colors}
					disabled={loading || error || !page || page.nextOffset === null}
					onPress={() => {
						if (page?.nextOffset !== null && page?.nextOffset !== undefined) void load(page.nextOffset, [...previous, page.offset], page.version);
					}}
				>
					{c.nextPart}
				</LabelButton>
				<LabelButton
					colors={colors}
					disabled={loading}
					onPress={() => {
						void load(0, []);
					}}
				>
					{c.reloadPart}
				</LabelButton>
			</View>
			{loading && <ActivityIndicator color={colors.secondary} />}
			{error && (
				<Text accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 14, lineHeight: 24 }}>
					{c.partUnavailable}
				</Text>
			)}
			{page && (
				<>
					<Text style={{ color: colors.secondary, fontSize: 12, marginBottom: 12 }}>
						{c.contentPosition} {page.offset + (page.text.length ? 1 : 0)}–{page.offset + page.text.length} / {page.total}
					</Text>
					{selection?.channel === "text" && selection.role === "assistant" && visibleText ? (
						<NativeMarkdown text={visibleText} colors={colors} />
					) : (
						<Text selectable style={{ color: colors.text, ...typeScale.body, fontFamily: selection?.channel === "tool" ? "monospace" : undefined }}>
							{visibleText || (page.text.length ? c.reasoningOnlyPart : "")}
						</Text>
					)}
				</>
			)}
		</BottomSheet>
	);
}
