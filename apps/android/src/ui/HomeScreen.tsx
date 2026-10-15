import { Touch as Pressable } from "./Motion";
import { useState } from "react";
import { Alert, FlatList, Text, View } from "react-native";
import { ArrowLeft, CalendarClock, Clock3, FileCode2, Folder, Folders, Laptop, MessageSquareText, PenLine, Plus, RefreshCw, Settings, Settings2 } from "lucide-react-native";
import type { RemoteProject, RemoteSession, RemoteTask } from "../../../../packages/tpa-remote/src/types";
import type { Palette } from "../theme";
import { c } from "../copy";
import { Action, LabelButton, SearchField } from "./MobilePrimitives";

export type HomeTab = "home" | "tasks" | "projects" | "project";
type Props = {
	tab: HomeTab;
	setTab: (tab: HomeTab) => void;
	colors: Palette;
	sessions: RemoteSession[];
	projects: RemoteProject[];
	tasks: RemoteTask[];
	project?: RemoteProject;
	connected: boolean;
	busy: boolean;
	openSession: (id: string) => void;
	openProject: (project: RemoteProject) => void;
	newChat: () => void;
	newTask: () => void;
	openSettings: () => void;
	openWorkspace: () => void;
	refresh: () => void;
	openFiles: () => void;
};

/** Native lists follow the reference hierarchy and display only data returned by the computer. */
export function HomeScreen(p: Props) {
	const [query, setQuery] = useState("");
	const [onlyActive, setOnlyActive] = useState(false);
	const project = p.tab === "project";
	const tasks = p.tab === "tasks";
	const projects = p.tab === "projects";
	const filtered = p.sessions.filter((session) => (!project || session.projectId === p.project?.id) && (!onlyActive || session.active) && `${session.title} ${session.project}`.toLowerCase().includes(query.toLowerCase()));
	const notify = (message: string) => Alert.alert(c.brand, message);
	return (
		<View style={{ flex: 1 }}>
			<View style={{ minHeight: 56, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 10 }}>
				{project ? (
					<>
						<Action
							label={c.back}
							onPress={() => {
								setQuery("");
								p.setTab("projects");
							}}
							colors={p.colors}
							filled
						>
							<ArrowLeft size={20} color={p.colors.text} />
						</Action>
						<View style={{ width: 30, height: 30, borderRadius: 7, backgroundColor: "#cb3688", alignItems: "center", justifyContent: "center" }}>
							<Text style={{ color: "white", fontSize: 13 }}>{p.project?.name.slice(0, 1).toUpperCase()}</Text>
						</View>
					</>
				) : (
					<Pressable accessibilityRole="button" accessibilityLabel={c.workspace} onPress={p.openWorkspace} style={{ width: 36, height: 36, borderRadius: 25, backgroundColor: p.colors.avatar, alignItems: "center", justifyContent: "center" }}>
						<Text style={{ color: "white", fontSize: 13, lineHeight: 19, fontWeight: "400" }}>T</Text>
					</Pressable>
				)}
				{tasks ? <View style={{ flex: 1 }} /> : <SearchField value={query} change={setQuery} placeholder={projects ? c.searchProjects : c.searchChats} colors={p.colors} />}

				{!project && (
					<Action label={c.settings} onPress={p.openSettings} colors={p.colors}>
						<Settings size={20} color={p.colors.text} />
					</Action>
				)}
			</View>
			{!projects && !tasks && (
				<View style={{ alignItems: "flex-end", paddingHorizontal: 15, paddingTop: 0, paddingBottom: 6 }}>
					<Action label={c.filter} onPress={() => setOnlyActive(!onlyActive)} colors={p.colors} filled>
						<Settings2 size={18} color={onlyActive ? p.colors.primary : p.colors.secondary} />
					</Action>
					{onlyActive && <Text style={{ color: p.colors.primary, fontSize: 12, marginTop: 4 }}>{c.ongoing}</Text>}
				</View>
			)}
			{projects ? (
				<View style={{ flex: 1, paddingHorizontal: 15 }}>
					<View style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", borderRadius: 25, backgroundColor: p.colors.muted, paddingHorizontal: 16, minHeight: 38, gap: 9, marginTop: 10 }}>
						<Laptop size={18} color={p.colors.text} />
						<Text style={{ color: p.colors.text, fontSize: 13 }}>{c.local}</Text>
					</View>
					<Text style={{ color: p.colors.text, fontSize: 13, marginTop: 25, marginBottom: 9, marginLeft: 10 }}>{c.hostLabel}</Text>
					<FlatList
						data={p.projects.filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))}
						keyExtractor={(entry) => entry.id}
						refreshing={p.busy}
						onRefresh={p.refresh}
						contentContainerStyle={{ borderRadius: 12, backgroundColor: p.colors.muted, overflow: "hidden" }}
						ListEmptyComponent={<Text style={{ color: p.colors.secondary, padding: 24, textAlign: "center" }}>{p.connected ? c.noProjects : c.noCloudChat}</Text>}
						renderItem={({ item, index }) => (
							<Pressable
								accessibilityRole="button"
								onPress={() => {
									setQuery("");
									p.openProject(item);
								}}
								style={{ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 15, paddingHorizontal: 15, paddingVertical: 10 }}
							>
								<View style={{ width: 32, height: 32, borderRadius: 12, backgroundColor: index % 2 ? "#cb3688" : "#88cf32", alignItems: "center", justifyContent: "center" }}>
									<Text style={{ color: "white", fontSize: 14 }}>{item.name.slice(0, 1).toUpperCase()}</Text>
								</View>
								<View style={{ flex: 1 }}>
									<Text style={{ color: p.colors.text, fontSize: 13, lineHeight: 19, fontWeight: "400" }}>{item.name}</Text>
									<Text numberOfLines={1} style={{ color: p.colors.secondary, fontSize: 11, marginTop: 2 }}>
										{item.path}
									</Text>
								</View>
							</Pressable>
						)}
					/>
				</View>
			) : tasks ? (
				<View style={{ flex: 1, paddingHorizontal: 20 }}>
					<View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 15 }}>
						<Text style={{ color: p.colors.text, fontSize: 15, marginRight: "auto" }}>{c.schedules}</Text>
						<View style={{ flex: 1, maxWidth: 200 }}>
							<SearchField value={query} change={setQuery} placeholder={c.searchTasks} colors={p.colors} />
						</View>
						<LabelButton onPress={p.newTask} colors={p.colors} strong>
							<Plus size={20} color={p.colors.background} />
						</LabelButton>
					</View>
					<FlatList
						data={p.tasks.filter((task) => task.name.includes(query))}
						keyExtractor={(task) => task.id}
						refreshing={p.busy}
						onRefresh={p.refresh}
						contentContainerStyle={{ paddingBottom: 24 }}
						ListEmptyComponent={
							<View style={{ alignItems: "center", marginTop: 94, gap: 15 }}>
								<CalendarClock size={20} color={p.colors.secondary} />
								<Text style={{ color: p.colors.text, fontSize: 15 }}>{c.noTasks}</Text>
								<Text style={{ color: p.colors.secondary, fontSize: 13, lineHeight: 20, textAlign: "center" }}>{c.noTasksHint}</Text>
								<View style={{ marginTop: 7 }}>
									<LabelButton colors={p.colors} onPress={p.newTask}>
										<Plus size={18} color={p.colors.text} />
										<Text style={{ color: p.colors.text, fontSize: 13 }}>{c.newTask}</Text>
									</LabelButton>
								</View>
							</View>
						}
						renderItem={({ item }) => (
							<Pressable accessibilityRole="button" onPress={() => notify(`${item.prompt}\n\n${item.schedule}\n${c.pauseTask}`)} style={{ padding: 18, marginTop: 16, borderWidth: 1, borderColor: p.colors.border, borderRadius: 16, backgroundColor: p.colors.surface }}>
								<Text style={{ color: p.colors.text, fontSize: 14 }}>{item.name}</Text>
								<Text style={{ color: p.colors.secondary, fontSize: 11, lineHeight: 16, marginTop: 3 }}>{item.nextRunAt ? new Date(item.nextRunAt).toLocaleString() : c.manual}</Text>
							</Pressable>
						)}
					/>
				</View>
			) : (
				<FlatList
					data={filtered}
					keyExtractor={(entry) => entry.id}
					refreshing={p.busy}
					onRefresh={p.refresh}
					contentContainerStyle={{ paddingHorizontal: 15, paddingBottom: 8 }}
					ListEmptyComponent={
						<Pressable accessibilityRole="button" onPress={p.connected ? p.refresh : p.openSettings} style={{ minHeight: 88, backgroundColor: p.colors.muted, borderWidth: 1, borderColor: p.colors.border, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 }}>
							<Text style={{ color: p.colors.secondary, fontSize: 14, textAlign: "center" }}>{!p.connected ? c.unpaired : project || query || onlyActive ? c.noMatches : c.noWorkspaceChats}</Text>
						</Pressable>
					}
					renderItem={({ item }) => (
						<Pressable accessibilityRole="button" onPress={() => p.openSession(item.id)} style={{ minHeight: 58, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 6, borderWidth: 1, borderColor: p.colors.border, borderRadius: 12, backgroundColor: p.colors.surface }}>
							<View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
								<Text numberOfLines={1} style={{ flex: 1, color: p.colors.text, fontSize: 13, lineHeight: 19, fontWeight: "400" }}>
									{item.title || c.unnamed}
								</Text>
								{item.active && <View style={{ width: 7, height: 7, borderRadius: 5, backgroundColor: p.colors.success }} />}
							</View>
							<Text numberOfLines={1} style={{ color: p.colors.secondary, fontSize: 11, lineHeight: 16, marginTop: 3 }}>
								{item.project}
							</Text>
						</Pressable>
					)}
				/>
			)}
			<View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 15, paddingTop: 6, paddingBottom: 4 }}>
				<View style={{ flex: 1, flexDirection: "row", borderWidth: 1, borderColor: p.colors.border, borderRadius: 12, backgroundColor: p.colors.muted, minHeight: 48, padding: 4, boxShadow: "0 7px 15px #00000018" }}>
					{(project
						? [
								{ id: "project", label: c.home, Icon: MessageSquareText },
								{ id: "files", label: c.projectFiles, Icon: FileCode2 },
								{ id: "settings", label: c.settings, Icon: Settings },
							]
						: [
								{ id: "home", label: c.home, Icon: MessageSquareText },
								{ id: "tasks", label: c.schedules, Icon: Clock3 },
								{ id: "projects", label: c.projects, Icon: Folders },
							]
					).map(({ id, label, Icon }) => (
						<Pressable
							key={id}
							accessibilityRole="tab"
							accessibilityState={{ selected: p.tab === id }}
							onPress={() => {
								setQuery("");
								if (id === "home" || id === "tasks" || id === "projects") p.setTab(id);
								else if (id === "files") p.openFiles();
								else if (id === "settings") p.openSettings();
							}}
							style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 1, borderRadius: 9, backgroundColor: p.tab === id ? p.colors.selected : "transparent" }}
						>
							<Icon size={20} color={p.tab === id ? p.colors.primary : p.colors.secondary} strokeWidth={2.2} />
							<Text numberOfLines={1} style={{ fontSize: 11, color: p.tab === id ? p.colors.primary : p.colors.secondary }}>
								{label}
							</Text>
						</Pressable>
					))}
				</View>
				<Pressable accessibilityRole="button" accessibilityLabel={c.newChat} onPress={p.newChat} style={{ width: 48, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: p.colors.strong, boxShadow: "0 5px 10px #00000020" }}>
					<PenLine size={22} color={p.colors.background} />
				</Pressable>
			</View>
		</View>
	);
}
