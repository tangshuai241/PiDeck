/** Title model selection participates in the common settings draft and its normal save flow. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AvailableModel } from "../../../../../shared/types";
import { DEFAULT_SESSION_TITLE_MODEL, normalizeSessionTitleModel, type SessionTitleModel } from "../../../../../shared/sessionTitlePreference";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { ModelPicker } from "../../session/ComposerComponents";
import { DirtyMarker, SettingRow, SettingsModelPickerControl } from "./SettingRows";

export function SessionTitleModelSetting({ value, dirty, onChange }: { value?: SessionTitleModel; dirty: boolean; onChange(value: SessionTitleModel): void }) {
	const selected = normalizeSessionTitleModel(value);
	const [open, setOpen] = useState(false);
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [loading, setLoading] = useState(false);
	const requestRevision = useRef(0);
	const loadModels = useCallback(async (force = false) => {
		const revision = ++requestRevision.current;
		setLoading(true);
		try {
			const report = await desktopApi.projects.listModelsReport(undefined, force);
			if (requestRevision.current === revision) setModels(report.models);
		} catch {
			if (requestRevision.current === revision) showNotice(t("settings.sessionTitleModelsFailed"));
		} finally {
			if (requestRevision.current === revision) setLoading(false);
		}
	}, []);
	useEffect(() => {
		if (open) void loadModels();
		return () => {
			requestRevision.current += 1;
		};
	}, [open, loadModels]);
	return (
		<SettingRow
			anchor="common-session-title-model"
			title={
				<>
					<span>{t("settings.sessionTitleModel")}</span>
					<DirtyMarker dirty={dirty} label={t("settings.sessionTitleModel")} />
				</>
			}
			description={t("settings.sessionTitleModelDesc")}
			alignEnd={false}
		>
			<SettingsModelPickerControl value={`${selected.provider}/${selected.modelId}`} placeholder={t("settings.sessionTitleModel")} onOpen={() => setOpen(true)} onClear={() => onChange({ ...DEFAULT_SESSION_TITLE_MODEL })} />
			{open && (
				<ModelPicker
					models={models}
					loading={loading && models.length === 0}
					refreshing={loading}
					onRefresh={() => void loadModels(true)}
					current={selected}
					favoriteModels={[]}
					onToggleFavorite={() => undefined}
					onPick={(model) => {
						onChange({ provider: model.provider, modelId: model.id });
						setOpen(false);
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</SettingRow>
	);
}
