/** A small explicit action beside the session name, shared by tab and split-pane titles. */
import { Loader2, Sparkles } from "lucide-react";
import { useGenerateSessionTitle } from "../../hooks/useGenerateSessionTitle";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

export function GenerateSessionTitleButton({ sessionId }: { sessionId: string }) {
	const action = useGenerateSessionTitle(sessionId);
	if (!action.supported) return null;
	const label = t(action.busy ? "session.generatingTitle" : action.action === "busy" ? "session.generateTitleBusy" : action.action === "empty" ? "session.generateTitleUnavailable" : action.action === "activate" ? "session.generateTitleActivate" : "session.generateTitle");
	return (
		<span className="inline-flex shrink-0 [-webkit-app-region:no-drag]" title={label}>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="size-5 shrink-0 text-muted-foreground hover:text-primary"
				disabled={!action.available || action.busy}
				title={label}
				aria-label={label}
				data-testid="generate-session-title"
				onClick={(event) => {
					event.stopPropagation();
					void action.generate();
				}}
				onPointerDown={(event) => event.stopPropagation()}
			>
				{action.busy ? <Loader2 className="size-3 motion-safe:animate-spin" /> : <Sparkles className="size-3" />}
			</Button>
		</span>
	);
}
