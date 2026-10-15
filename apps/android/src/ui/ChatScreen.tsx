import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, LayoutAnimation, Text, View } from "react-native";
import { ArrowLeft, Ellipsis, Folder, MessagesSquare, Pin } from "lucide-react-native";
import type { CompanionController } from "../useCompanion";
import type { Palette } from "../theme";
import { c } from "../copy";
import { Action } from "./MobilePrimitives";
import { ReferenceComposer } from "./ReferenceComposer";
import { QuestionCard } from "../QuestionCard";
import { FullMessageSheet, type FullMessageSelection } from "./FullMessageSheet";
import { Message } from "./ChatMessage";
import { ProcessSummary, ProcessDetail, type OpenPart } from "./ProcessTimeline";
import { buildConversation, conversationRows, type ConversationRow } from "../conversation";
import { Touch as Pressable, useReducedMotion } from "./Motion";
import { typeScale } from "./typography";
import { useChatViewport } from "../useChatViewport";
import { pinKey } from "../mobilePreferences";
import { PinnedMessagesSheet } from "./PinnedMessagesSheet";
import { processIsOpen } from "../chatViewport";

/** Native chat is a view of the desktop session, including its provisional live channels. */
export function ChatScreen({ controller: s, colors, back, settings, sessions, files, chooseModel }: { controller: CompanionController; colors: Palette; back: () => void; settings: () => void; sessions: () => void; files: () => void; chooseModel: () => void }) {
	const viewport = useChatViewport(s.selected, s.displayMessages);
	const reduced = useReducedMotion();
	const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map());
	const turns = useMemo(() => buildConversation(s.displayMessages, !s.historyMode && !!s.snapshot?.busy, s.hasOlder), [s.displayMessages, s.historyMode, s.snapshot?.busy, s.hasOlder]);
	const openIds = useMemo(
		() =>
			new Set([
				...turns.filter((turn) => processIsOpen(turn.id, expanded)).map((turn) => turn.id),
				...Array.from(expanded)
					.filter(([id, open]) => id.startsWith("detail:") && open)
					.map(([id]) => id),
			]),
		[turns, expanded],
	);
	const rows = useMemo(() => conversationRows(turns, openIds), [turns, openIds]);
	const toggleLayout = useCallback(() => {
		// Hold this layout change without permanently disabling subsequent live following.
		viewport.disclose();
		if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut", "opacity"));
	}, [reduced]);
	const toggleTurn = useCallback(
		(id: string) => {
			toggleLayout();
			setExpanded((previous) => {
				const next = new Map(previous);
				next.set(id, !(previous.get(id) ?? !id.startsWith("detail:")));
				return next;
			});
		},
		[toggleLayout],
	);
	const [full, setFull] = useState<FullMessageSelection>();
	const openFull = useCallback<OpenPart>((message, channel) => setFull({ messageId: message.id, entryId: message.entryId, channel, channelsSeparated: message.channelsSeparated, thinking: message.thinking, role: message.role }), []);
	useEffect(() => {
		setFull(undefined);
		setExpanded(new Map());
	}, [s.selected]);

	const [showPins, setShowPins] = useState(false);
	const pins = s.selected ? (s.preferences.pins[s.selected] ?? []) : [];
	const current = s.sessions.find((session) => session.id === s.selected);
	const connected = s.connection === "connected";
	return (
		<View style={{ flex: 1 }}>
			<View style={{ minHeight: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8 }}>
				<Action label={c.back} onPress={back} colors={colors}>
					<ArrowLeft size={23} color={colors.text} />
				</Action>
				<View style={{ flex: 1, minWidth: 0 }}>
					<Text numberOfLines={1} style={{ ...typeScale.title, fontWeight: "500", color: colors.text }}>
						{current?.title || c.unnamed}
					</Text>
					<View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 }}>
						<Folder size={15} color={colors.secondary} />
						<Text numberOfLines={1} style={{ ...typeScale.caption, color: colors.secondary }}>
							{current?.project || c.projectFallback}
						</Text>
					</View>
				</View>
				{!!pins.length && (
					<Action label={c.pinnedMessages} onPress={() => setShowPins(true)} colors={colors}>
						<Pin size={15} color={colors.primary} />
					</Action>
				)}
				<Action label={c.allChats} onPress={sessions} colors={colors}>
					<MessagesSquare size={23} color={colors.text} />
				</Action>
				<Action label={c.filesInSession} onPress={files} colors={colors}>
					<Ellipsis size={25} color={colors.text} />
				</Action>
			</View>
			{!connected && (
				<Pressable onPress={settings} style={{ paddingHorizontal: 25, paddingVertical: 8 }}>
					<Text style={{ color: colors.secondary, fontSize: 12 }}>{c.mutedConnection}</Text>
				</Pressable>
			)}
			<FlatList
				key={s.selected}
				ref={viewport.list}
				data={rows}
				removeClippedSubviews={false}
				maintainVisibleContentPosition={viewport.following ? undefined : { minIndexForVisible: 0 }}
				keyExtractor={(message) => message.id}
				renderItem={({ item }) =>
					item.kind === "summary" ? (
						<ProcessSummary turn={item.turn} colors={colors} expanded={processIsOpen(item.turn.id, expanded)} toggle={() => toggleTurn(item.turn.id)} />
					) : item.kind === "step" ? (
						<ProcessDetail step={item.step} colors={colors} open={openFull} expanded={expanded.get(`detail:${item.id}`) ?? false} toggle={() => toggleTurn(`detail:${item.id}`)} />
					) : (
						<Message
							message={item.message}
							colors={colors}
							open={openFull}
							controls={{
								pinned: pins.some((pin) => pin.key === pinKey(item.message)),
								busy: !!s.snapshot?.busy || s.working,
								connected,
								fork: () => {
									void s.fork(item.message);
								},
								pin: () => s.pin(item.message),
								full: () => openFull(item.message, "text"),
							}}
						/>
					)
				}
				initialNumToRender={15}
				maxToRenderPerBatch={8}
				windowSize={7}
				contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 10 }}
				keyboardShouldPersistTaps="handled"
				scrollEventThrottle={100}
				onLayout={viewport.resize}
				onScrollBeginDrag={viewport.begin}
				onScrollEndDrag={({ nativeEvent: event }) => viewport.end(event.contentSize.height - event.contentOffset.y - event.layoutMeasurement.height)}
				onMomentumScrollBegin={viewport.begin}
				onMomentumScrollEnd={({ nativeEvent: event }) => viewport.end(event.contentSize.height - event.contentOffset.y - event.layoutMeasurement.height)}
				onScroll={({ nativeEvent: event }) => viewport.scroll(event.contentSize.height - event.contentOffset.y - event.layoutMeasurement.height)}
				onContentSizeChange={viewport.resize}
				ListHeaderComponent={
					s.hasOlder ? (
						<Pressable
							accessibilityRole="button"
							disabled={!connected || s.historyLoading}
							onPress={() => {
								viewport.pause();
								void s.loadOlder();
							}}
							style={{ minHeight: 44, alignItems: "center", justifyContent: "center", marginBottom: 15 }}
						>
							<Text style={{ color: colors.secondary, fontSize: 13 }}>{s.historyLoading ? c.preparing : c.loadOlder}</Text>
						</Pressable>
					) : null
				}
				ListEmptyComponent={s.working ? <ActivityIndicator color={colors.secondary} /> : null}
				ListFooterComponent={
					<>
						{s.snapshot?.questions.map((question) => (
							<QuestionCard
								key={`${question.runtimeGeneration}-${question.requestId}`}
								question={question}
								colors={colors}
								disabled={!connected || s.working}
								answer={(value) => {
									const snapshot = s.snapshot;
									if (snapshot) void s.perform(() => s.client.answer(snapshot, question.requestId, value));
								}}
							/>
						))}
						{s.snapshot?.busy && (
							<View style={{ minHeight: 36, flexDirection: "row", alignItems: "center", gap: 8 }}>
								<ActivityIndicator size="small" color={colors.secondary} />
								<Text style={{ color: colors.secondary, fontSize: 13 }}>{c.generating}</Text>
							</View>
						)}
					</>
				}
			/>
			{(!viewport.following || s.historyMode) && (
				<Pressable
					accessibilityRole="button"
					onPress={() => {
						s.showLatest();
						viewport.latest();
					}}
					style={{ alignSelf: "center", paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: colors.muted, marginBottom: 6 }}
				>
					<Text style={{ fontSize: 11, color: colors.text }}>{viewport.unread ? `${c.newMessage} · ${c.latest}` : c.latest}</Text>
				</Pressable>
			)}
			<ReferenceComposer
				colors={colors}
				draft={s.draft}
				change={s.changeDraft}
				send={() => {
					s.showLatest();
					viewport.latest();
					void s.send();
				}}
				stop={() => {
					const snapshot = s.snapshot;
					if (snapshot) void s.perform(() => s.client.abort(snapshot));
				}}
				connected={connected}
				busy={s.snapshot?.busy ?? false}
				disabled={s.working || !s.snapshot?.target || s.error === "DELIVERY_UNKNOWN"}
				project={current?.project}
				model={s.preferences.model?.name || current?.model}
				settings={settings}
				chooseProject={sessions}
				chooseModel={chooseModel}
			/>
			<PinnedMessagesSheet open={showPins} close={() => setShowPins(false)} pins={pins} colors={colors} read={(pin) => setFull({ messageId: pin.messageId, entryId: pin.entryId, channel: "text", role: pin.role })} />
			<FullMessageSheet selection={full} sessionId={s.selected} client={s.client} colors={colors} close={() => setFull(undefined)} />
		</View>
	);
}
