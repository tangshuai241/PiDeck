import { useCallback, useEffect, useRef, useState } from "react";
import type { FlatList } from "react-native";
import type { RemoteMessage } from "../../../packages/tpa-remote/src/types";
import type { ConversationRow } from "./conversation";
import { ChatViewport, outputChanged } from "./chatViewport";

/** Own scheduled scrolling and cancel it with the screen; one frame absorbs batched token updates. */
export function useChatViewport(sessionId: string | undefined, messages: RemoteMessage[]) {
	const list = useRef<FlatList<ConversationRow>>(null);
	const policy = useRef(new ChatViewport());
	const gesture = useRef(false);
	const frame = useRef<number | undefined>(undefined);
	const previous = useRef<RemoteMessage[]>([]);
	const [following, setFollowing] = useState(true);
	const [unread, setUnread] = useState(false);
	const sync = useCallback(() => {
		setFollowing(policy.current.following);
		setUnread(policy.current.unread);
	}, []);
	const resize = useCallback(() => {
		if (frame.current !== undefined) cancelAnimationFrame(frame.current);
		if (policy.current.resize())
			frame.current = requestAnimationFrame(() => {
				frame.current = undefined;
				if (policy.current.resize()) list.current?.scrollToEnd({ animated: false });
			});
	}, []);
	useEffect(() => {
		policy.current = new ChatViewport();
		previous.current = [];
		gesture.current = false;
		sync();
		resize();
		return () => {
			if (frame.current !== undefined) cancelAnimationFrame(frame.current);
		};
	}, [sessionId, resize, sync]);
	useEffect(() => {
		if (outputChanged(previous.current, messages)) {
			policy.current.output();
			sync();
			resize();
		}
		previous.current = messages;
	}, [messages, resize, sync]);
	return {
		list,
		following,
		unread,
		resize,
		disclose: () => policy.current.disclose(),
		pause: () => {
			policy.current.pause();
			sync();
		},
		latest: () => {
			policy.current.latest();
			sync();
			resize();
		},
		begin: () => {
			gesture.current = true;
		},
		end: (distance: number) => {
			policy.current.scroll(distance, true);
			gesture.current = false;
			sync();
			resize();
		},
		scroll: (distance: number) => {
			policy.current.scroll(distance, gesture.current);
			sync();
		},
	};
}
