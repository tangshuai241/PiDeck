import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/** Keep the scroll owner stable, including mounted MCP/security drafts and full-height editors. */
export function ConfigPage({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
	return (
		<div
			data-config-page=""
			className={cn(
				"config-content relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-settings-canvas px-8 py-7 text-foreground max-[820px]:px-4 [[data-bg-image=on]_&]:bg-transparent [&_[data-slot=select-trigger]]:border-transparent [&_[data-slot=select-trigger]]:bg-settings-control [&_[data-slot=select-trigger]]:shadow-none",
				className,
			)}
		>
			<h2 className="mb-6 shrink-0 text-heading font-semibold tracking-tight motion-safe:animate-[settings-content-enter_220ms_cubic-bezier(0.16,1,0.3,1)]">{title}</h2>
			{children}
		</div>
	);
}
