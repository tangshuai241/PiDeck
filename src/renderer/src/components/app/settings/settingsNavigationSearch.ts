import type { TranslationKey } from "../../../i18n";
import { SETTINGS_FIELD_ANCHORS } from "../../../utils/settingsFieldAnchors";
import { SETTINGS_NAV_GROUPS, SETTINGS_TAB_KEYWORDS, SETTINGS_TAB_LABEL_KEYS, type SettingsTabLayoutEntry } from "./settingsTabLayout";

/** Match against the same translated titles and aliases used by the command palette. */
export function resolveSettingsNavigation(tabs: readonly SettingsTabLayoutEntry[], query: string, translate: (key: TranslationKey) => string) {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	const matches = (values: readonly string[]) => {
		const text = values.join(" ").toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	};
	return SETTINGS_NAV_GROUPS.map((group) => ({
		id: group.id,
		labelKey: group.labelKey,
		items: tabs
			.filter((entry) => entry.group === group.id)
			.flatMap((entry) => {
				const label = translate(SETTINGS_TAB_LABEL_KEYS[entry.id]);
				const fields = terms.length ? SETTINGS_FIELD_ANCHORS.filter((field) => field.tab === entry.id && matches([label, translate(field.labelKey), ...field.keywords])) : [];
				return matches([label, translate(group.labelKey), ...SETTINGS_TAB_KEYWORDS[entry.id]]) || fields.length ? [{ ...entry, label, fields }] : [];
			}),
	})).filter((group) => group.items.length > 0);
}
