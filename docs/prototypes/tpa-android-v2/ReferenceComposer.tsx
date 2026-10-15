import { ArrowUp, Plus } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { LogoMark } from "@/components/app/LogoMark";
import { IconButton } from "./chrome";
import { c } from "./copy";
/** Shared visual composer: submitting the preview never contacts a remote host. */
export function ReferenceComposer({ draft, setDraft, preview, onSubmit }: { draft: string; setDraft: (value: string) => void; preview: () => void; onSubmit: () => void }) {
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
			className="rounded-[17px] border border-border-default bg-bg-panel px-[13px] pb-[10px] pt-[8px] shadow-[0_2px_3px_#00000010]"
		>
			<Textarea
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				aria-label={c.inputLabel}
				placeholder={c.placeholder}
				rows={1}
				className="h-[36px] min-h-[36px] max-h-[120px] resize-none rounded-none border-0 bg-transparent p-0 pl-[2px] pt-[1px] text-[17px] leading-[27px] shadow-none placeholder:text-[#a0a5ae] focus-visible:border-transparent focus-visible:ring-0 md:text-[17px]"
			/>
			<div className="mt-[3px] flex h-[41px] items-center gap-[19px]">
				<IconButton label={c.attachment} onClick={preview} className="size-[39px] shrink-0 text-text-secondary [&_svg]:size-[20px]">
					<Plus strokeWidth={1.6} />
				</IconButton>
				<Button variant="ghost" onClick={preview} aria-label={c.chooseModel} className="h-10 min-w-0 flex-1 justify-start gap-[6px] rounded-lg px-0 text-[17.5px] font-normal tracking-normal">
					<span className="shrink-0 [&_.logo-mark]:rounded-none [&_.logo-mark]:bg-transparent [&_.logo-mark]:text-text-primary [&_.logo-mark]:shadow-none [&_.logo-mark]:ring-0 [&_svg]:size-[20px] [&_svg_path]:fill-current [&_svg_rect]:fill-current">
						<LogoMark size={20} />
					</span>
					<span className="truncate">{c.model}</span>
				</Button>
				<Button type="submit" aria-label={c.send} disabled={!draft.trim()} className="size-[40px] shrink-0 rounded-full bg-[#999] p-0 text-white shadow-none hover:bg-[#888] disabled:opacity-100 [&_svg]:size-[24px]">
					<ArrowUp strokeWidth={2} />
				</Button>
			</div>
		</form>
	);
}
