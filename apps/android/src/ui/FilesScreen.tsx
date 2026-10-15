import { useEffect, useRef, useState } from "react";
import { Alert, FlatList, Text, View } from "react-native";
import { ArrowLeft, FileText, RefreshCw } from "lucide-react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { RemoteArtifact } from "../../../../packages/tpa-remote/src/types";
import { encode } from "../../../../packages/tpa-remote/src/crypto";
import type { PhoneClient } from "../phoneClient";
import type { Palette } from "../theme";
import { c } from "../copy";
import { Action, LabelButton } from "./MobilePrimitives";

/** Read only archived artifacts through opaque host-issued IDs and verify every download digest. */
export function FilesScreen({ client, sessionId, connected, colors, back }: { client: PhoneClient; sessionId?: string; connected: boolean; colors: Palette; back: () => void }) {
	const [files, setFiles] = useState<RemoteArtifact[]>([]);
	const [downloading, setDownloading] = useState<string>();
	const [progress, setProgress] = useState(0);
	const [refreshing, setRefreshing] = useState(false);
	const epoch = useRef(0);
	async function refresh() {
		if (!sessionId || !connected) return;
		const current = ++epoch.current;
		setRefreshing(true);
		try {
			const items = await client.artifacts(sessionId);
			if (epoch.current === current) setFiles(items);
		} catch {
			if (epoch.current === current) Alert.alert(c.brand, c.error);
		} finally {
			if (epoch.current === current) setRefreshing(false);
		}
	}
	useEffect(() => {
		setFiles([]);
		void refresh();
		return () => {
			epoch.current++;
		};
	}, [sessionId, connected, client]);
	async function download(file: RemoteArtifact) {
		if (downloading) return;
		const current = epoch.current;
		setDownloading(file.id);
		setProgress(0);
		try {
			const bytes = await client.download(file, (received) => {
				if (epoch.current !== current) throw new Error("DOWNLOAD_CANCELLED");
				setProgress(Math.round((received / Math.max(file.bytes, 1)) * 100));
			});
			if (epoch.current !== current) return;
			const directory = `${FileSystem.documentDirectory}downloads/`;
			await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
			const extension = file.fileName.match(/\.[a-z0-9]{1,8}$/i)?.[0] ?? ".bin";
			const path = `${directory}${file.id}${extension}`;
			await FileSystem.writeAsStringAsync(path, encode(bytes), { encoding: FileSystem.EncodingType.Base64 });
			if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { dialogTitle: file.fileName });
			else Alert.alert(c.brand, c.verified);
		} catch {
			if (epoch.current === current) Alert.alert(c.brand, c.openFailed);
		} finally {
			if (epoch.current === current) setDownloading(undefined);
		}
	}
	return (
		<View style={{ flex: 1 }}>
			<View style={{ minHeight: 54, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 15 }}>
				<Action colors={colors} label={c.back} onPress={back}>
					<ArrowLeft size={23} color={colors.text} />
				</Action>
				<Text style={{ flex: 1, color: colors.text, fontSize: 14 }}>{c.filesInSession}</Text>
				<Action
					colors={colors}
					label={c.refresh}
					onPress={() => {
						void refresh();
					}}
				>
					<RefreshCw size={20} color={colors.text} />
				</Action>
			</View>
			<FlatList
				data={files}
				keyExtractor={(file) => file.id}
				refreshing={refreshing}
				onRefresh={() => {
					void refresh();
				}}
				contentContainerStyle={{ padding: 16, gap: 15 }}
				ListEmptyComponent={<Text style={{ color: colors.secondary, fontSize: 12, lineHeight: 26 }}>{!sessionId ? c.selectFirst : !connected ? c.noCloudChat : c.noFilesHint}</Text>}
				renderItem={({ item }) => (
					<View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 18, padding: 20, gap: 12 }}>
						<FileText size={28} color={colors.secondary} />
						<Text style={{ color: colors.text, fontSize: 14 }}>{item.fileName}</Text>
						<Text style={{ color: colors.secondary, fontSize: 13 }}>
							{c.version} {item.version} · {Math.ceil(item.bytes / 1024)} KB
						</Text>
						<LabelButton
							colors={colors}
							disabled={!connected || !!downloading}
							onPress={() => {
								void download(item);
							}}
						>
							{downloading === item.id ? `${c.downloading} ${progress}%` : c.download}
						</LabelButton>
					</View>
				)}
			/>
		</View>
	);
}
