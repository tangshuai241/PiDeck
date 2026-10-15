/** 右侧详情抽屉：复用 Dialog 的焦点锁、遮罩和语义，输入缓冲由页面域持有。 */
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Maximize2, Minimize2, X } from "lucide-react";
import { t } from "../../i18n";
import { EASE_DRAWER } from "../../lib/ease";
import { cn } from "../../lib/utils";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle, DialogDescription } from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import { isOutsideInteractionFromToast } from "../ui-shadcn/toastOutsideGuard";

export function PersonalTodoPanel(props: { open: boolean; title: string; onClose: () => void; openerRef: RefObject<HTMLElement | null>; children: ReactNode }) {
	const [wide, setWide] = useState(false);
	// Radix 会等退出动画结束再卸载；关闭期间保留最后一帧内容，避免空白抽屉滑出。
	const lastFrame = useRef({ title: props.title, children: props.children });
	if (props.open) lastFrame.current = { title: props.title, children: props.children };
	return (
		<Dialog
			open={props.open}
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
		>
			<DialogPortal>
				<DialogOverlay className="backdrop-blur-none motion-reduce:animate-none" />
				<DialogPrimitive.Content
					className={cn(
						"fixed inset-y-0 right-0 z-(--z-dialog) flex w-full flex-col border-l border-border bg-background shadow-[var(--shadow-modal)] outline-none transition-[max-width] duration-300 motion-reduce:transition-none motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-right-8 motion-safe:data-[state=open]:fade-in-0 motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:slide-out-to-right-8 motion-safe:data-[state=closed]:fade-out-0",
						wide ? "max-w-[min(960px,100vw)]" : "max-w-[580px]",
					)}
					style={{ animationTimingFunction: `cubic-bezier(${EASE_DRAWER.join(",")})` }}
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						if (props.openerRef.current?.isConnected) props.openerRef.current.focus({ preventScroll: true });
					}}
					onInteractOutside={(event) => {
						if (isOutsideInteractionFromToast(event)) event.preventDefault();
					}}
				>
					<header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-6">
						<DialogTitle className="mr-auto text-body font-medium">{lastFrame.current.title}</DialogTitle>
						<Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t(wide ? "personalTodo.narrowPanel" : "personalTodo.widePanel")} onClick={() => setWide((current) => !current)}>
							{wide ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
						</Button>
						<DialogPrimitive.Close asChild>
							<Button variant="ghost" size="icon" className="size-8" aria-label={t("common.close")}>
								<X className="size-4" />
							</Button>
						</DialogPrimitive.Close>
					</header>
					<DialogDescription className="sr-only">{t("personalTodo.panelHint")}</DialogDescription>
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">{lastFrame.current.children}</div>
				</DialogPrimitive.Content>
			</DialogPortal>
		</Dialog>
	);
}
