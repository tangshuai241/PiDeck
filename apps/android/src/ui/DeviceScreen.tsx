import { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { ArrowLeft, ClipboardPaste, Monitor, Moon, RefreshCw, ScanLine, ShieldCheck, Sun } from "lucide-react-native";
import type { CompanionController } from "../useCompanion";
import type { Palette } from "../theme";
import { c } from "../copy";
import { Action, BottomSheet, LabelButton } from "./MobilePrimitives";

/** Pairing is a real native camera/Keystore flow; no sample computer is presented as connected. */
export function DeviceScreen({ controller: s, colors, dark, toggleTheme, back }: { controller: CompanionController; colors: Palette; dark: boolean; toggleTheme: () => void; back: () => void }) {
	const [scanning, setScanning] = useState(false);
	const [notices, setNotices] = useState("");
	const [permission, requestPermission] = useCameraPermissions();
	const scanningLock = useRef(false);
	const status = { connected: c.connected, connecting: c.connecting, waiting: c.waiting, unpaired: c.unpaired, offline: c.offline, error: c.failed }[s.connection];
	async function pair(text: string) {
		setScanning(false);
		try {
			await s.client.pair(text);
		} catch {
			Alert.alert(c.brand, c.pairingInvalid);
		}
	}
	async function scan() {
		scanningLock.current = false;
		const next = permission?.granted ? permission : await requestPermission();
		if (next.granted) setScanning(true);
		else Alert.alert(c.brand, c.camera);
	}
	if (scanning)
		return (
			<View style={{ flex: 1 }}>
				<CameraView
					facing="back"
					style={{ flex: 1 }}
					barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
					onBarcodeScanned={({ data }) => {
						if (!scanningLock.current) {
							scanningLock.current = true;
							void pair(data);
						}
					}}
				/>
				<LabelButton colors={colors} onPress={() => setScanning(false)}>
					{c.cancel}
				</LabelButton>
			</View>
		);
	return (
		<View style={{ flex: 1 }}>
			<View style={{ flexDirection: "row", paddingHorizontal: 16, minHeight: 54, alignItems: "center", gap: 16 }}>
				<Action colors={colors} label={c.back} onPress={back}>
					<ArrowLeft size={23} color={colors.text} />
				</Action>
				<Text style={{ flex: 1, fontSize: 14, color: colors.text }}>{c.settings}</Text>
				<Action colors={colors} label={c.theme} onPress={toggleTheme}>
					{dark ? <Sun size={21} color={colors.text} /> : <Moon size={21} color={colors.text} />}
				</Action>
			</View>
			<ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
				<View style={{ padding: 14, gap: 13, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
					<Monitor size={32} color={colors.text} />
					<Text style={{ color: colors.text, fontSize: 15 }}>{c.computer}</Text>
					<Text accessibilityLiveRegion="polite" style={{ color: s.connection === "connected" ? colors.success : colors.secondary, fontSize: 12 }}>
						{status}
					</Text>
					<Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 19 }}>{s.connection === "waiting" ? c.pairHint : s.connection === "unpaired" ? c.emptyHint : c.connectedDetail}</Text>
					<LabelButton colors={colors} onPress={() => s.client.refresh()}>
						<RefreshCw size={18} color={colors.text} />
						<Text style={{ color: colors.text, fontSize: 13 }}>{c.reconnect}</Text>
					</LabelButton>
				</View>
				<LabelButton
					colors={colors}
					onPress={() => {
						void scan();
					}}
				>
					<ScanLine size={20} color={colors.text} />
					<Text style={{ color: colors.text, fontSize: 13 }}>{c.scan}</Text>
				</LabelButton>
				<LabelButton
					colors={colors}
					onPress={() => {
						void Clipboard.getStringAsync()
							.then(pair)
							.catch(() => Alert.alert(c.brand, c.pairingInvalid));
					}}
				>
					<ClipboardPaste size={19} color={colors.text} />
					<Text style={{ color: colors.text, fontSize: 13 }}>{c.paste}</Text>
				</LabelButton>
				<View style={{ flexDirection: "row", gap: 12, marginVertical: 10 }}>
					<ShieldCheck size={22} color={colors.secondary} />
					<View style={{ flex: 1 }}>
						<Text style={{ color: colors.text, fontSize: 13 }}>{c.privacyTitle}</Text>
						<Text style={{ color: colors.secondary, fontSize: 13, lineHeight: 18, marginTop: 7 }}>{c.privacy}</Text>
					</View>
				</View>
				<LabelButton
					colors={colors}
					onPress={() =>
						Alert.alert(c.forgetTitle, c.forgetHint, [
							{ text: c.cancel, style: "cancel" },
							{
								text: c.forget,
								style: "destructive",
								onPress: () => {
									void s.forget().catch(() => Alert.alert(c.brand, c.error));
								},
							},
						])
					}
				>
					{c.forget}
				</LabelButton>
				<LabelButton
					colors={colors}
					onPress={() => {
						void import("../../assets/third-party-notices.json").then((value) => setNotices(value.text)).catch(() => Alert.alert(c.brand, c.error));
					}}
				>
					{c.licenses}
				</LabelButton>
			</ScrollView>
			<BottomSheet open={!!notices} close={() => setNotices("")} colors={colors} title={c.licenses}>
				<Text selectable style={{ color: colors.text, fontSize: 12, lineHeight: 20 }}>
					{notices}
				</Text>
			</BottomSheet>
		</View>
	);
}
