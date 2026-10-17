import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, LayoutAnimation, Text, View } from "react-native";
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
	const attention = s.snapshot?.attention;
	const statusLine = attention?.questionCount ? `${c.awaitingAnswer}${attention.question ? ` · ${attention.question}` : ""}` : attention?.completionUnread && attention.completion ? attention.completion.outcome === "failed" ? c.failedResult : attention.completion.outcome === "interrupted" ? c.interruptedResult : c.unreadResult : attention?.running ? c.runningNow : attention?.completion?.outcome === "aborted" ? c.stoppedResult : undefined;
	// 结果进入可见区域才算已读：应用在前台、非历史浏览、列表跟随底部。
	const snapshot = s.snapshot;
	// 已读规则与桌面一致：仅当应用在前台、本会话可见、结果在视口内，且不是「打开会话时已存在的
	// 未读结果」时才确认。新结果在浏览中到达、用户点按未读提示或滚回底部都会触发确认。
	const completionBaselineRef = useRef<{ sessionId?: string; completionId?: string }>({});
	const previousFollowingRef = useRef(viewport.following);
	const [focusResultRequested, setFocusResultRequested] = useState(false);
	useEffect(() => {
		setFocusResultRequested(false);
	}, [s.selected]);
	useEffect(() => {
		const becameFollowing = !previousFollowingRef.current && viewport.following;
		previousFollowingRef.current = viewport.following;
		if (!snapshot || !attention?.completionUnread || !attention.completion) return;
		const baseline = completionBaselineRef.current;
		if (baseline.sessionId !== snapshot.sessionId) {
			// 首次看到该会话：把当前结果记为基线，打开会话本身不确认已读。
			completionBaselineRef.current = { sessionId: snapshot.sessionId, completionId: attention.completion.id };
			return;
		}
		const preexisting = baseline.completionId !== undefined && baseline.completionId === attention.completion.id;
		if (preexisting && !focusResultRequested && !becameFollowing) return;
		if (!viewport.following || s.historyMode || AppState.currentState !== "active") return;
		void s.client.acknowledge(snapshot.sessionId, attention.completion.id).catch(() => undefined);
	}, [snapshot, attention, viewport.following, s.historyMode, s.client, focusResultRequested]);
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
						<Pressable
							accessibilityRole="button"
							disabled={!attention?.completionUnread}
							onPress={() => {
								viewport.latest();
								setFocusResultRequested(true);
							}}
							style={{ alignSelf: "flex-start", maxWidth: "100%" }}
						>
							<Text numberOfLines={1} style={{ ...typeScale.caption, color: attention?.completionUnread ? colors.primary : colors.secondary }}>
								{statusLine ? `${current?.project || c.projectFallback} · ${statusLine}` : current?.project || c.projectFallback}
							</Text>
						</Pressable>
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
									if (!snapshot) return;
									void s.perform(async () => {
										try {
											await s.client.answer(snapshot, question.requestId, value);
										} catch (error) {
											// 确定拒绝（问题已被桌面回答/运行时变化）：刷新快照移除过期提问，命令已结算。
											await s.client.select(snapshot.sessionId).catch(() => undefined);
											throw error;
										}
									});
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
				disabled={s.working || s.error === "DELIVERY_UNKNOWN"}
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
