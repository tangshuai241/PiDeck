import { YaoPromptTab } from "./YaoPromptTab";

/** The community library stays available after retiring online recommendations. */
export function PromptStoreTab(props: { onImported?: () => void; projectId?: string }) {
	return <YaoPromptTab onImported={props.onImported} projectId={props.projectId} />;
}
