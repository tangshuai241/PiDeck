import { useState } from "react";
import { Bluetooth, Check, ChevronLeft, CloudOff, Copy, Ellipsis, Folder, GitFork, MessageCircle, Pin, Plus, UserRound, VolumeX, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui-shadcn/dialog";
import { LogoMark } from "@/components/app/LogoMark";
import { c } from "./copy";
import { Frame, IconButton } from "./chrome";
import { ReferenceComposer } from "./ReferenceComposer";

/** Recreate the supplied screen; unreferenced actions identify the preview boundary. */
export function ChatScreen({ onBack }: { onBack: () => void }) {
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState("");
	const [copied, setCopied] = useState(false);
	const preview = () => setNotice(c.previewNotice);
	async function copyMessage() {
		try {
			await navigator.clipboard.writeText(c.title);
			setCopied(true);
		} catch {
			setNotice(c.previewNotice);
		}
	}
	return (
		<Frame clock={c.clock}>
			<header className="flex h-[62px] shrink-0 items-center gap-[15px] px-4 pb-[3px]">
				<IconButton label={c.back} onClick={onBack} className="border border-border-subtle">
					<ChevronLeft className="size-[25px]" strokeWidth={1.9} />
				</IconButton>
				<div className="min-w-0 flex-1">
					<h1 className="m-0 text-[19px] leading-[25px] font-medium">{c.title}</h1>
					<div className="mt-[2px] flex items-center gap-[6px] text-[15px] leading-[20px] font-semibold text-text-secondary">
						<Folder className="size-[15px]" strokeWidth={1.8} />
						{c.project}
					</div>
				</div>
				<IconButton label={c.conversations} onClick={preview} className="border border-border-subtle">
					<span className="relative size-6">
						<MessageCircle className="absolute left-0 top-0 size-[19px]" strokeWidth={1.8} />
						<MessageCircle className="absolute bottom-0 right-0 size-[17px] fill-bg-app" strokeWidth={1.8} />
					</span>
				</IconButton>
				<IconButton label={c.more} onClick={preview} className="border border-border-subtle">
					<Ellipsis className="size-[24px]" strokeWidth={3} />
				</IconButton>
			</header>
			<section aria-label={c.message} className="min-h-0 flex-1 overflow-y-auto px-[30px] pt-[25px]">
				<div className="flex justify-end">
					<div className="flex flex-col items-end">
						<div className="mr-[52px] flex h-[24px] items-center gap-[9px] text-[15px] leading-6 text-text-secondary">
							<span className="size-[16px] rounded-full border-[1.5px] border-current" />
							{c.time}
						</div>
						<div className="mt-[3px] flex items-center gap-[10px]">
							<div className="grid min-h-[59px] min-w-[75px] place-items-center rounded-[19px] bg-bg-muted px-5 text-[18px]">{c.title}</div>
							<span className="grid size-[40px] place-items-center rounded-full bg-[#e7e8eb]">
								<UserRound className="size-[21px]" strokeWidth={1.8} />
							</span>
						</div>
						<div className="mr-[49px] mt-[10px] flex gap-[2px] text-text-secondary">
							<IconButton label={c.branch} onClick={preview} className="size-9 text-text-secondary [&_svg]:size-[17px]">
								<GitFork strokeWidth={1.8} />
							</IconButton>
							<IconButton label={c.pin} onClick={preview} className="size-9 text-text-secondary [&_svg]:size-[17px]">
								<Pin strokeWidth={1.8} />
							</IconButton>
							<IconButton label={c.copy} onClick={copyMessage} className="size-9 text-text-secondary [&_svg]:size-[17px]">
								{copied ? <Check /> : <Copy strokeWidth={1.8} />}
							</IconButton>
						</div>
					</div>
				</div>
			</section>
			<footer className="shrink-0 px-[17px] pb-[36px]">
				<div className="mb-[10px] flex h-[41px] items-center rounded-[11px] border border-border-subtle bg-bg-panel px-[9px] shadow-[0_1px_3px_#0000000d]">
					<IconButton label={c.connection} onClick={preview} className="h-9 w-[34px] text-text-secondary [&_svg]:size-[19px]">
						<CloudOff strokeWidth={1.7} />
					</IconButton>
					<span className="mx-[5px] h-[18px] w-px bg-[#d7d9de]" />
					<Button variant="ghost" className="h-9 gap-[10px] rounded-lg px-[2px] text-[15px] font-normal text-text-secondary" onClick={preview} aria-label={c.chooseProject}>
						<Folder className="size-[18px]" strokeWidth={1.7} />
						{c.project}
					</Button>
				</div>
				<ReferenceComposer draft={draft} setDraft={setDraft} preview={preview} onSubmit={preview} />
			</footer>
			<Dialog
				open={!!notice}
				onOpenChange={(open) => {
					if (!open) setNotice("");
				}}
			>
				<DialogContent className="max-w-sm rounded-2xl bg-bg-panel text-text-primary">
					<DialogTitle>{c.previewTitle}</DialogTitle>
					<DialogDescription>{notice}</DialogDescription>
					<Button onClick={() => setNotice("")}>{c.close}</Button>
				</DialogContent>
			</Dialog>
		</Frame>
	);
}
