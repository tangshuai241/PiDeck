import { MotionProvider, PageTransition } from "./ui/Motion";
import { ModelPicker } from "./ui/ModelPicker";
import { KeyboardFrame } from "./ui/KeyboardFrame";
import { useEffect, useState } from "react";
import { Alert, BackHandler, Pressable, Text, View, useColorScheme } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { Check, Plus, UsersRound } from "lucide-react-native";
import type { RemoteProject, RemoteTask, RemoteTaskInput } from "../../../packages/tpa-remote/src/types";
import { useCompanion } from "./useCompanion";
import { palettes } from "./theme";
import { c } from "./copy";
import { HomeScreen, type HomeTab } from "./ui/HomeScreen";
import { ChatScreen } from "./ui/ChatScreen";
import { DeviceScreen } from "./ui/DeviceScreen";
import { FilesScreen } from "./ui/FilesScreen";
import { TaskEditorScreen } from "./ui/TaskEditorScreen";
import { NewConversationSheet } from "./ui/NewConversationSheet";
import { BottomSheet, LabelButton } from "./ui/MobilePrimitives";

type Route = HomeTab | "chat" | "device" | "files" | "task-editor";

/** Screen navigation owns presentation only; useCompanion owns the single host session stream. */
function Companion() {
	const s = useCompanion();
	const scheme = useColorScheme();
	const [dark, setDark] = useState(scheme === "dark");
	const colors = dark ? palettes.dark : palettes.light;
	const [route, setRoute] = useState<Route>("home");
	const [lastHome, setLastHome] = useState<HomeTab>("home");
	const [projects, setProjects] = useState<RemoteProject[]>([]);
	const [project, setProject] = useState<RemoteProject>();
	const [tasks, setTasks] = useState<RemoteTask[]>([]);
	const [loading, setLoading] = useState(false);
	const [workspace, setWorkspace] = useState(false);
	const [modelPicker, setModelPicker] = useState(false);
	const [newChat, setNewChat] = useState(false);
	const connected = s.connection === "connected";
	useEffect(() => {
		if (s.createdSessionId) {
			setNewChat(false);
			setRoute("chat");
		}
	}, [s.createdSessionId]);
	useEffect(() => {
		if (!s.createdTaskId) return;
		setRoute("tasks");
		setLastHome("tasks");
		void s.client
			.tasks()
			.then(setTasks)
			.catch(() => s.setError("CATALOG_FAILED"));
	}, [s.createdTaskId, s.client]);
	useEffect(() => {
		void SystemUI.setBackgroundColorAsync(colors.background).catch(() => undefined);
	}, [colors.background]);
	useEffect(() => {
		if (!connected) return;
		let cancelled = false;
		void Promise.all([s.client.projects(), s.client.tasks()])
			.then(([nextProjects, nextTasks]) => {
				if (!cancelled) {
					setProjects(nextProjects);
					setTasks(nextTasks);
				}
			})
			.catch(() => {
				if (!cancelled) s.setError("CATALOG_FAILED");
			});
		return () => {
			cancelled = true;
		};
	}, [connected, s.client]);
	function goHome(next: HomeTab) {
		setRoute(next);
		setLastHome(next);
	}
	function back() {
		if (route === "task-editor") goHome("tasks");
		else setRoute(lastHome);
	}
	useEffect(() => {
		const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
			if (newChat) {
				setNewChat(false);
				return true;
			}
			if (workspace) {
				setWorkspace(false);
				return true;
			}
			if (route === "home") return false;
			if (route === "project") goHome("projects");
			else if (route === "tasks" || route === "projects") goHome("home");
			else back();
			return true;
		});
		return () => subscription.remove();
	}, [route, lastHome, workspace, newChat]);
	async function refresh() {
		if (!connected) {
			s.client.refresh();
			return;
		}
		setLoading(true);
		try {
			await s.client.list();
			const [nextProjects, nextTasks] = await Promise.all([s.client.projects(), s.client.tasks()]);
			setProjects(nextProjects);
			setTasks(nextTasks);
		} catch {
			s.setError("CATALOG_FAILED");
		} finally {
			setLoading(false);
		}
	}
	async function create(projectId: string, text: string): Promise<boolean> {
		const id = await s.create(projectId, text);
		if (!id) return false;
		setNewChat(false);
		setRoute("chat");
		return true;
	}
	async function saveTask(task: RemoteTaskInput): Promise<boolean> {
		if (!connected || s.working || loading) return false;
		setLoading(true);
		try {
			await s.client.createTask(task);
			void s.client
				.tasks()
				.then(setTasks)
				.catch(() => s.setError("CATALOG_FAILED"));
			return true;
		} catch (error) {
			s.setError(error instanceof Error && error.message === "DELIVERY_UNKNOWN" ? "DELIVERY_UNKNOWN" : "TASK_FAILED");
			return false;
		} finally {
			setLoading(false);
		}
	}
	function startChat() {
		if (!connected) {
			setRoute("device");
			return;
		}
		if (!project && projects[0]) setProject(projects[0]);
		setNewChat(true);
	}
	const error =
		s.error === "UPDATE_REQUIRED"
			? c.modelsUnavailable
			: s.error === "MODEL_BUSY"
				? c.modelBusy
				: s.error === "MODEL_UNAVAILABLE"
					? c.modelUnavailable
					: s.error === "DELIVERY_UNKNOWN"
						? c.sendUnknown
						: s.error === "COMMAND_NOT_RECEIVED"
							? c.commandNotReceived
							: s.error === "RESTORE_FAILED"
								? c.restoreError
								: s.error === "CACHE_FAILED"
									? c.cacheError
									: s.error
										? c.error
										: undefined;
	return (
		<SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={["top", "bottom"]}>
			<StatusBar style={dark ? "light" : "dark"} />
			<KeyboardFrame>
				{error && (
					<Pressable accessibilityRole="button" onPress={() => setRoute("device")} style={{ paddingHorizontal: 20, paddingVertical: 8, borderBottomWidth: 1, borderColor: colors.border }}>
						<Text accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 13, lineHeight: 21 }}>
							{error}
						</Text>
					</Pressable>
				)}
				<PageTransition identity={route}>
					{route === "chat" ? (
						<ChatScreen chooseModel={() => setModelPicker(true)} controller={s} colors={colors} back={back} settings={() => setRoute("device")} sessions={() => setRoute(lastHome)} files={() => setRoute("files")} />
					) : route === "device" ? (
						<DeviceScreen controller={s} colors={colors} dark={dark} toggleTheme={() => setDark(!dark)} back={back} />
					) : route === "files" ? (
						<FilesScreen client={s.client} sessionId={s.selected} connected={connected} colors={colors} back={() => setRoute(s.selected ? "chat" : lastHome)} />
					) : route === "task-editor" ? (
						<TaskEditorScreen colors={colors} projects={projects} project={project} close={() => goHome("tasks")} save={saveTask} working={loading || !connected || s.error === "DELIVERY_UNKNOWN"} />
					) : (
						<HomeScreen
							tab={route}
							setTab={goHome}
							colors={colors}
							sessions={s.sessions}
							projects={projects}
							tasks={tasks}
							project={project}
							connected={connected}
							busy={loading}
							openSession={(id) => {
								setRoute("chat");
								void s.select(id);
							}}
							openProject={(item) => {
								setProject(item);
								goHome("project");
							}}
							newChat={startChat}
							newTask={() => (connected ? setRoute("task-editor") : setRoute("device"))}
							openSettings={() => setRoute("device")}
							openWorkspace={() => setWorkspace(true)}
							refresh={() => {
								void refresh();
							}}
							openFiles={() => setRoute("files")}
						/>
					)}
				</PageTransition>
				<ModelPicker open={modelPicker} close={() => setModelPicker(false)} client={s.client} sessionId={newChat ? undefined : s.selected} projectId={project?.id} colors={colors} selected={s.preferences.model} choose={s.chooseModel} />
				<NewConversationSheet
					model={s.preferences.model?.name}
					chooseModel={() => setModelPicker(true)}
					key={s.createdSessionId ?? "new"}
					open={newChat}
					close={() => setNewChat(false)}
					colors={colors}
					projects={projects}
					project={project}
					chooseProject={setProject}
					connected={connected}
					working={s.working || s.error === "DELIVERY_UNKNOWN"}
					create={create}
				/>
				<BottomSheet open={workspace} close={() => setWorkspace(false)} colors={colors}>
					<Text style={{ paddingHorizontal: 10, color: colors.secondary, fontSize: 12, marginBottom: 10 }}>{c.workspaceName}</Text>
					<Text style={{ paddingHorizontal: 10, color: colors.secondary, fontSize: 12 }}>{c.workspace}</Text>
					<Pressable accessibilityRole="button" onPress={() => setWorkspace(false)} style={{ minHeight: 46, borderRadius: 10, backgroundColor: colors.muted, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 }}>
						<View style={{ width: 30, height: 30, borderRadius: 12, backgroundColor: colors.avatar, alignItems: "center", justifyContent: "center" }}>
							<Text style={{ fontSize: 15, color: "white" }}>T</Text>
						</View>
						<Text style={{ flex: 1, color: colors.text, fontSize: 14 }}>{c.workspaceName}</Text>
						<Check size={21} color={colors.secondary} />
					</Pressable>
					<View style={{ marginTop: 15, borderTopWidth: 1, borderColor: colors.border, paddingTop: 12, gap: 12 }}>
						<LabelButton colors={colors} onPress={() => Alert.alert(c.brand, c.noAccount)}>
							<Plus size={20} color={colors.text} />
							<Text style={{ color: colors.text, fontSize: 13 }}>{c.workspaceCreate}</Text>
						</LabelButton>
						<LabelButton colors={colors} onPress={() => Alert.alert(c.brand, c.noAccount)}>
							<UsersRound size={20} color={colors.text} />
							<Text style={{ color: colors.text, fontSize: 13 }}>{c.workspaceInvite}</Text>
						</LabelButton>
					</View>
				</BottomSheet>
			</KeyboardFrame>
		</SafeAreaView>
	);
}

export default function NativeApp() {
	return (
		<SafeAreaProvider>
			<MotionProvider>
				<Companion />
			</MotionProvider>
		</SafeAreaProvider>
	);
}
