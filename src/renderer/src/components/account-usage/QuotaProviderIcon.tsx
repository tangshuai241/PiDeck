/** Reuse the session brand marks; Grok's bundled mark comes from stablyai/orca (MIT). */
import type { QuotaProvider } from "../../../../shared/types/accountUsage";
import grokIcon from "../../assets/quota/grok.png";
import { SourceLogo } from "../session/SessionSourceBadge";

export function QuotaProviderIcon({ provider }: { provider: QuotaProvider }) {
	return (
		<span className="inline-flex size-3 shrink-0 items-center justify-center text-foreground/80 [&_svg]:size-3" aria-hidden="true" data-quota-provider-icon={provider}>
			{provider === "grok" ? <img src={grokIcon} alt="" className="size-3 object-contain mix-blend-multiply dark:mix-blend-screen dark:invert" /> : <SourceLogo source={provider === "opencode-go" ? "opencode" : provider === "glm" ? "zcode" : "codex"} />}
		</span>
	);
}
