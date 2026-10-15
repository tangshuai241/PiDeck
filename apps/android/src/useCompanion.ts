import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import { commandIdentity } from "../../../packages/tpa-remote/src/commandIdentity";
import { isRecord } from "../../../packages/tpa-remote/src/crypto";
import { useHistory } from "./useHistory";
import { PhoneClient, type ConnectionState } from "./phoneClient";
import { loadCache, loadCredentials, saveCache, saveCredentials, type LocalCache } from "./storage";
import type { RemoteSession, RemoteSnapshot, RemoteModel, RemoteMessage } from "../../../packages/tpa-remote/src/types";

import { togglePinned, type MobilePreferences } from "./mobilePreferences";

/** Own mobile state by session; never borrow the desktop's current-session selection. */
export function useCompanion() {
	const [client] = useState(() => new PhoneClient(saveCredentials));
	const [connection, setConnection] = useState<ConnectionState>("unpaired");
	const [sessions, setSessions] = useState<RemoteSession[]>([]);
	const [snapshots, setSnapshots] = useState<Record<string, RemoteSnapshot>>({});
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [preferences, setPreferences] = useState<MobilePreferences>({ pins: {} });
	const [selected, setSelected] = useState<string>();
	const [error, setError] = useState<string>();
	const [working, setWorking] = useState(false);
	const [createdSessionId, setCreatedSessionId] = useState<string>();
	const [createdTaskId, setCreatedTaskId] = useState<string>();
	const cache = useRef<LocalCache>({ sessions, drafts, preferences });
	const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		let mounted = true;
		const unsubscribe = client.subscribe((event) => {
			if (!mounted) return;
			if (event.kind === "state") setConnection(event.state);
			if (event.kind === "error") setError(event.code);
			if (event.kind === "receipt") {
				if (!event.ok) setError("REQUEST_FAILED");
				else if (event.command.method === "tasks.create" && isRecord(event.result) && typeof event.result.id === "string") {
					setCreatedTaskId(event.result.id);
					setError(undefined);
				} else if ((event.command.method === "session.create" || event.command.method === "session.fork") && isRecord(event.result) && typeof event.result.sessionId === "string") {
					const id = event.result.sessionId;
					const staged = event.command.method === "session.fork" && typeof event.result.text === "string" ? event.result.text : event.command.projectId ? cache.current.drafts[`new:${event.command.projectId}`] : "";
					setSelected(id);
					setCreatedSessionId(id);
					setError(undefined);
					setDrafts((current) => {
						const next = { ...current, [id]: event.result && isRecord(event.result) && event.result.accepted === true ? "" : (staged ?? "") };
						cache.current.drafts = next;
						return next;
					});
					void client.select(id).catch(() => setError("SYNC_FAILED"));
					void client.list().catch(() => undefined);
				} else if (event.command.method === "session.send" && event.command.sessionId && event.command.target) {
					const id = event.command.sessionId;
					const text = cache.current.drafts[id] ?? "";
					void Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, commandIdentity("session.send", { sessionId: id, target: event.command.target, text, ...(event.command.model ? { model: event.command.model } : {}) }))
						.then((signature) => {
							if (!mounted) return;
							setError(undefined);
							if (signature === event.command.signature)
								setDrafts((current) => {
									if (current[id] !== text) return current;
									const next = { ...current, [id]: "" };
									cache.current.drafts = next;
									return next;
								});
						})
						.catch(() => {
							if (mounted) setError("CACHE_FAILED");
						});
				} else setError(undefined);
			}
			if (event.kind === "sessions") {
				setSessions(event.sessions);
				cache.current.sessions = event.sessions;
			}
			if (event.kind === "snapshot") {
				setSnapshots((current) => {
					const old = new Map(current[event.snapshot.sessionId]?.messages.map((message) => [message.id, message]));
					const messages = event.snapshot.messages.map((message) => {
						const previous = old.get(message.id);
						return previous && JSON.stringify(previous) === JSON.stringify(message) ? previous : message;
					});
					return { ...current, [event.snapshot.sessionId]: { ...event.snapshot, messages } };
				});
				cache.current.snapshot = event.snapshot;
			}
			if (saveTimer.current) clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => {
				void saveCache(cache.current).catch(() => {
					if (mounted) setError("CACHE_FAILED");
				});
			}, 1200);
		});
		void (async () => {
			try {
				const [credentials, stored] = await Promise.all([loadCredentials(), loadCache()]);
				if (!mounted) return;
				setSessions(stored.sessions);
				setDrafts(stored.drafts);
				setPreferences(stored.preferences);
				cache.current = stored;
				if (stored.snapshot) {
					setSnapshots({ [stored.snapshot.sessionId]: stored.snapshot });
					client.seed(stored.snapshot);
				}
				await client.restore(credentials);
			} catch {
				if (mounted) setError("RESTORE_FAILED");
			}
		})();
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") void saveCache(cache.current).catch(() => undefined);
		});
		return () => {
			mounted = false;
			unsubscribe();
			subscription.remove();
			if (saveTimer.current) clearTimeout(saveTimer.current);
			client.dispose();
		};
	}, [client]);
	async function select(sessionId: string) {
		setSelected(sessionId);
		setError(undefined);
		if (connection === "connected") {
			setWorking(true);
			try {
				await client.select(sessionId);
			} catch {
				setError("SYNC_FAILED");
			} finally {
				setWorking(false);
			}
		}
	}
	function changeDraft(text: string) {
		if (!selected) return;
		setDrafts((current) => {
			const next = { ...current, [selected]: text };
			cache.current.drafts = next;
			return next;
		});
	}
	async function send() {
		const snapshot = selected ? snapshots[selected] : undefined;
		const text = selected ? drafts[selected] : undefined;
		if (!snapshot || !text?.trim() || working || connection !== "connected") return;
		setWorking(true);
		setError(undefined);
		const source = selected;
		try {
			await saveCache(cache.current);
			await client.send(snapshot, text, cache.current.preferences.model ? { provider: cache.current.preferences.model.provider, modelId: cache.current.preferences.model.id } : undefined);
			if (source)
				setDrafts((current) => {
					if (current[source] !== text) return current;
					const next = { ...current, [source]: "" };
					cache.current.drafts = next;
					return next;
				});
		} catch (error) {
			setError(error instanceof Error ? error.message : "SEND_FAILED");
		} finally {
			setWorking(false);
		}
	}
	async function perform(action: () => Promise<void>) {
		setWorking(true);
		setError(undefined);
		try {
			await action();
		} catch (error) {
			setError(error instanceof Error ? error.message : "REQUEST_FAILED");
		} finally {
			setWorking(false);
		}
	}
	async function create(projectId: string, text: string): Promise<string | undefined> {
		if (working || connection !== "connected" || !text.trim()) return undefined;
		setWorking(true);
		setError(undefined);
		let sessionId: string | undefined;
		try {
			cache.current.drafts = { ...cache.current.drafts, [`new:${projectId}`]: text };
			await saveCache(cache.current);
			const result = await client.createSession(projectId, text, cache.current.preferences.model ? { provider: cache.current.preferences.model.provider, modelId: cache.current.preferences.model.id } : undefined);
			sessionId = result.sessionId;
			const id = sessionId;
			setSelected(id);
			setCreatedSessionId(id);
			setDrafts((current) => {
				const next = { ...current, [id]: result.accepted ? "" : text };
				cache.current.drafts = next;
				return next;
			});
			await client.select(id);
			if (result.unknown) setError("DELIVERY_UNKNOWN");
		} catch (error) {
			setError(error instanceof Error ? error.message : "CREATE_FAILED");
		} finally {
			setWorking(false);
		}
		return sessionId;
	}
	async function forget() {
		cache.current = { sessions: [], drafts: {}, preferences: { pins: {} } };
		setPreferences({ pins: {} });
		if (saveTimer.current) clearTimeout(saveTimer.current);
		await client.forget();
		setSessions([]);
		setSnapshots({});
		setDrafts({});
		setSelected(undefined);
		setError(undefined);
	}
	useEffect(() => {
		const timer = setTimeout(() => {
			void saveCache(cache.current).catch(() => setError("CACHE_FAILED"));
		}, 700);
		return () => clearTimeout(timer);
	}, [drafts]);
	function chooseModel(model: RemoteModel | undefined) {
		const next = { ...cache.current.preferences, model };
		cache.current.preferences = next;
		setPreferences(next);
		void saveCache(cache.current).catch(() => setError("CACHE_FAILED"));
	}
	function pin(message: RemoteMessage) {
		if (!selected) return;
		const next = togglePinned(cache.current.preferences, selected, message);
		cache.current.preferences = next;
		setPreferences(next);
		void saveCache(cache.current).catch(() => setError("CACHE_FAILED"));
	}
	async function fork(message: RemoteMessage) {
		const snapshot = selected ? snapshots[selected] : undefined;
		if (!snapshot?.target || !message.entryId || working) return;
		await perform(async () => {
			const result = await client.fork(snapshot, message.entryId || "");
			setDrafts((old) => {
				const next = { ...old, [result.sessionId]: result.text };
				cache.current.drafts = next;
				return next;
			});
			setSelected(result.sessionId);
			setCreatedSessionId(result.sessionId);
			await client.select(result.sessionId);
			await client.list();
		});
	}

	const snapshot = selected ? snapshots[selected] : undefined;
	const history = useHistory(client, selected, snapshot, setError);
	return { preferences, chooseModel, pin, fork, client, connection, sessions, selected, setSelected, snapshot, draft: selected ? (drafts[selected] ?? "") : "", error, setError, working, select, changeDraft, send, perform, forget, create, createdSessionId, createdTaskId, ...history };
}
export type CompanionController = ReturnType<typeof useCompanion>;
