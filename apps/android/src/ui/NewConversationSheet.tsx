import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { Folder, GitBranch, Laptop, MessageCircle, Monitor } from "lucide-react-native";
import type { RemoteProject } from "../../../../packages/tpa-remote/src/types";
import type { Palette } from "../theme";
import { c } from "../copy";
import { BottomSheet } from "./MobilePrimitives";
import { ReferenceComposer } from "./ReferenceComposer";

/** Creation stays on the computer; local drafts survive changing project selection or connectivity. */
export function NewConversationSheet({
	open,
	close,
	colors,
	projects,
	project,
	chooseProject,
	connected,
	working,
	create,
	model,
	chooseModel,
}: {
	open: boolean;
	close: () => void;
	colors: Palette;
	projects: RemoteProject[];
	project?: RemoteProject;
	chooseProject: (project: RemoteProject) => void;
	connected: boolean;
	working: boolean;
	model?: string;
	chooseModel: () => void;
	create: (projectId: string, text: string) => Promise<boolean>;
}) {
	const [draft, setDraft] = useState("");
	const [selecting, setSelecting] = useState(false);
	const row = (label: string, content: React.ReactNode) => (
		<View style={{ minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: 10, flexDirection: "row", alignItems: "center", paddingHorizontal: 10, gap: 8, backgroundColor: colors.muted }}>
			<Text style={{ width: 54, color: colors.secondary, fontSize: 12 }}>{label}</Text>
			<View style={{ flex: 1, minWidth: 0 }}>{content}</View>
		</View>
	);
	return (
		<BottomSheet open={open} close={close} colors={colors} title={c.newChat}>
			{row(
				c.machine,
				<View style={{ flexDirection: "row", gap: 9, alignItems: "center", padding: 10, borderRadius: 8, backgroundColor: colors.field }}>
					<Monitor size={18} color={colors.secondary} />
					<Text style={{ color: colors.secondary, fontSize: 14 }}>{c.hostLabel}</Text>
				</View>,
			)}
			{row(
				c.type,
				<View style={{ flexDirection: "row", padding: 4, backgroundColor: colors.field, borderRadius: 7 }}>
					<View style={{ flex: 1, minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: 6, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
						<Folder size={17} color={colors.text} />
						<Text style={{ fontSize: 13, color: colors.text }}>{c.local}</Text>
					</View>
					<Pressable accessibilityRole="button" onPress={() => Alert.alert(c.brand, c.unavailable)} style={{ flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center" }}>
						<Text style={{ fontSize: 12, color: colors.secondary }}>{c.github}</Text>
					</Pressable>
					<Pressable accessibilityRole="button" onPress={() => Alert.alert(c.brand, c.chooseProject)} style={{ minWidth: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4 }}>
						<MessageCircle size={17} color={colors.secondary} />
						<Text style={{ fontSize: 12, color: colors.secondary }}>{c.home}</Text>
					</Pressable>
				</View>,
			)}
			{row(
				c.project,
				<Pressable accessibilityRole="button" accessibilityLabel={c.chooseProject} onPress={() => setSelecting(!selecting)} style={{ minHeight: 40, borderRadius: 8, backgroundColor: colors.field, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 9 }}>
					<Folder size={18} color={colors.text} />
					<Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: colors.text }}>
						{project?.name || c.chooseProject}
					</Text>
				</Pressable>,
			)}
			{selecting &&
				projects.map((item) => (
					<Pressable
						key={item.id}
						accessibilityRole="button"
						onPress={() => {
							chooseProject(item);
							setSelecting(false);
						}}
						style={{ padding: 14, borderRadius: 10, backgroundColor: colors.surface }}
					>
						<Text style={{ color: colors.text, fontSize: 13 }}>{item.name}</Text>
						<Text numberOfLines={1} style={{ color: colors.secondary, fontSize: 12, marginTop: 4 }}>
							{item.path}
						</Text>
					</Pressable>
				))}
			{row(
				c.mode,
				<View style={{ flexDirection: "row", backgroundColor: colors.field, borderRadius: 7, padding: 3 }}>
					<View style={{ flex: 1, minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: colors.surface, borderRadius: 7, borderWidth: 1, borderColor: colors.border }}>
						<Folder size={18} color={colors.text} />
						<Text style={{ fontSize: 13, color: colors.text }}>{c.localFiles}</Text>
					</View>
					<View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, opacity: 0.45 }}>
						<GitBranch size={17} color={colors.secondary} />
						<Text style={{ color: colors.secondary, fontSize: 12 }}>{c.worktree}</Text>
					</View>
				</View>,
			)}
			<View style={{ marginTop: 12, marginHorizontal: -17 }}>
				<ReferenceComposer
					model={model}
					chooseModel={chooseModel}
					colors={colors}
					draft={draft}
					change={setDraft}
					showContext={false}
					connected={connected}
					busy={false}
					disabled={working || !project}
					send={() => {
						if (project)
							void create(project.id, draft).then((accepted) => {
								if (accepted) setDraft("");
							});
					}}
					settings={() => {}}
					chooseProject={() => setSelecting(true)}
				/>
			</View>
		</BottomSheet>
	);
}
