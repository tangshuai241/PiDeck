import { cloneElement, isValidElement, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import chatSystem from "./reference-assets/chat-system.png";
import homeSystem from "./reference-assets/home-system.jpg";
import otherSystem from "./reference-assets/other-system.jpg";
import { Button } from "@/components/ui-shadcn/button";
import { cn } from "@/lib/utils";
/** Screenshot-specific semantic tokens do not alter the desktop theme. */
const referenceTokens: CSSProperties & Record<`--${string}`, string> = {
	"--color-bg-app": "#f9f9f9",
	"--color-bg-panel": "#ffffff",
	"--color-text-primary": "#202124",
	"--color-text-secondary": "#747b89",
	"--color-border-default": "#e8e8e8",
	"--color-border-subtle": "#eceef0",
	"--color-bg-muted": "#ededed",
};

/** Shared buttons retain keyboard access and circular reference hit areas. */
export function IconButton({ label, className, children, ...props }: ComponentProps<typeof Button> & { label: string }) {
	// An explicit size on the icon avoids the shared button's fallback 16px selector.
	const icon = isValidElement<{ className?: string }>(children) ? cloneElement(children, { className: cn("size-5", children.props.className) }) : children;
	return (
		<Button type="button" variant="ghost" size="icon" aria-label={label} className={cn("size-11 rounded-full text-text-primary hover:bg-bg-muted [&_svg]:size-5", className)} {...props}>
			{icon}
		</Button>
	);
}

/** Only the OS status strip uses the supplied image; app content remains native DOM. */
function StatusBar({ clock }: { clock: string }) {
	const source = clock === "5:43" ? chatSystem : clock === "5:36" ? homeSystem : otherSystem;
	return (
		<div aria-hidden="true" className="relative aspect-[480/58] w-full shrink-0 overflow-hidden">
			<img src={source} alt="" className="absolute inset-x-0 top-0 h-auto w-full max-w-none" />
		</div>
	);
}

/** One phone frame keeps system chrome consistent across all reference screens. */
export function Frame({ children, clock = "5:37" }: { children: ReactNode; clock?: string }) {
	return (
		<main style={referenceTokens} className="relative mx-auto flex h-dvh min-h-[520px] w-full max-w-[480px] flex-col overflow-hidden bg-bg-app font-[MiSans,'MiSans_VF',Arial,'Microsoft_YaHei',sans-serif] text-text-primary motion-reduce:[&_*]:transition-none">
			<StatusBar clock={clock} />
			{children}
			<div aria-hidden="true" className="pointer-events-none absolute bottom-[11px] left-1/2 z-[100] h-[6px] w-[157px] -translate-x-1/2 rounded-full bg-[#999]" />
		</main>
	);
}
