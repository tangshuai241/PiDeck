import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import type { RemoteModel } from "../../../../packages/tpa-remote/src/types";
import type { PhoneClient } from "../phoneClient";
import type { Palette } from "../theme";
import { c } from "../copy";
import { BottomSheet, SearchField } from "./MobilePrimitives";
import { Touch } from "./Motion";
import { typeScale } from "./typography";

/** The phone stores the choice; Pi owns the available catalog and final validation at send. */
export function ModelPicker({ open, close, client, sessionId, projectId, selected, choose, colors }: { open: boolean; close: () => void; client: PhoneClient; sessionId?: string; projectId?: string; selected?: RemoteModel; choose: (model: RemoteModel | undefined) => void; colors: Palette }) {
	const [models, setModels] = useState<RemoteModel[]>([]);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!open) return;
		let active = true;
		setLoading(true);
		setFailed(false);
		setQuery("");
		void client
			.models(sessionId, projectId)
			.then((value) => {
				if (active) setModels(value);
			})
			.catch(() => {
				if (active) {
					setModels([]);
					setFailed(true);
				}
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [open, client, sessionId, projectId]);
	const filtered = useMemo(() => models.filter((model) => `${model.name} ${model.provider} ${model.id}`.toLowerCase().includes(query.toLowerCase())), [models, query]);
	return (
		<BottomSheet open={open} close={close} colors={colors} title={c.chooseModel}>
			<View style={{ flexDirection: "row", marginBottom: 4 }}>
				<SearchField value={query} change={setQuery} placeholder={c.searchModels} colors={colors} />
			</View>
			<Text style={{ ...typeScale.caption, color: colors.secondary }}>{c.phoneModelHint}</Text>
			{loading && <ActivityIndicator color={colors.primary} />}
			{failed && <Text style={{ ...typeScale.process, color: colors.danger }}>{c.modelsUnavailable}</Text>}
			{!loading &&
				filtered.slice(0, 80).map((model) => (
					<Touch
						key={`${model.provider}:${model.id}`}
						accessibilityRole="button"
						accessibilityState={{ selected: selected?.provider === model.provider && selected.id === model.id }}
						onPress={() => {
							choose(model);
							close();
						}}
						style={{ paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8, flexDirection: "row", gap: 8, alignItems: "center", backgroundColor: selected?.provider === model.provider && selected.id === model.id ? colors.selected : colors.surface }}
					>
						<View style={{ flex: 1 }}>
							<Text style={{ ...typeScale.body, color: colors.text }}>{model.name}</Text>
							<Text style={{ ...typeScale.caption, color: colors.secondary }}>
								{model.provider} · {model.id}
							</Text>
						</View>
						{selected?.provider === model.provider && selected.id === model.id && <Check size={16} color={colors.primary} />}
					</Touch>
				))}
			{filtered.length > 80 && <Text style={{ ...typeScale.caption, color: colors.secondary }}>{c.refineModelSearch}</Text>}
			<Touch
				accessibilityRole="button"
				onPress={() => {
					choose(undefined);
					close();
				}}
				style={{ minHeight: 36, justifyContent: "center" }}
			>
				<Text style={{ ...typeScale.process, color: colors.secondary }}>{c.useSessionModel}</Text>
			</Touch>
		</BottomSheet>
	);
}
