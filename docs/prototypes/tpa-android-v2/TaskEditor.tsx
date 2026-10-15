import { useState } from "react";
import { ChevronDown, FolderOpen, Monitor, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { LogoMark } from "@/components/app/LogoMark";
import { Frame, IconButton } from "./chrome";
import { r } from "./referenceCopy";

/** The schedule form is a local visual preview and never creates a real scheduled action. */
export function TaskEditor({ onClose, preview, notify }: { onClose: () => void; preview: () => void; notify: (message: string) => void }) {
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [trigger, setTrigger] = useState<"timed" | "manual">("timed");
	const row = "flex min-h-[79px] flex-col items-end justify-between border-b border-[#e4e4e4] px-[15px] pb-[8px] pt-[7px]";
	const select = "h-[35px] gap-[12px] rounded-[11px] border border-[#ddd] bg-[#f3f3f3] px-[10px] text-[16px] font-normal text-text-primary shadow-inner";
	return (
		<Frame>
			<header className="flex h-[55px] shrink-0 items-center border-b border-[#ececec] px-[10px]">
				<IconButton label={r.close} onClick={onClose} className="text-text-secondary [&_svg]:size-[20px]">
					<X />
				</IconButton>
			</header>
			<form
				className="min-h-0 flex-1 overflow-y-auto px-5 pb-[70px] pt-[25px]"
				onSubmit={(event) => {
					event.preventDefault();
					notify(!name.trim() || !prompt.trim() ? r.fillTask : r.taskPreview);
				}}
			>
				<section className="rounded-[16px] border border-[#e7e7e7] bg-bg-panel px-[15px] pb-[10px] pt-[9px]">
					<Input aria-label={r.taskName} placeholder={r.taskName} value={name} onChange={(event) => setName(event.target.value)} className="h-[47px] rounded-none border-0 border-b border-[#f0f0f0] bg-transparent px-0 text-[21px] font-medium shadow-none placeholder:text-[#aaa] focus-visible:ring-0 md:text-[21px]" />
					<Textarea
						aria-label={r.taskPrompt}
						placeholder={r.taskPrompt}
						value={prompt}
						onChange={(event) => setPrompt(event.target.value)}
						className="mt-[10px] h-[109px] min-h-[109px] resize-none rounded-none border-0 bg-transparent px-0 py-0 text-[16px] leading-[27px] shadow-none placeholder:text-[#aaa] focus-visible:ring-0 md:text-[16px]"
					/>
					<Button type="button" variant="ghost" onClick={preview} aria-label={r.model} className="mt-[3px] h-9 max-w-full justify-start gap-[7px] p-0 text-[16px] font-normal text-text-secondary">
						<span className="[&_.logo-mark]:bg-transparent [&_.logo-mark]:text-text-secondary [&_.logo-mark]:shadow-none [&_.logo-mark]:ring-0 [&_svg]:size-[20px] [&_svg_path]:fill-current [&_svg_rect]:fill-current">
							<LogoMark size={21} />
						</span>
						<span className="truncate">{r.taskModel}</span>
					</Button>
				</section>
				<div className="mt-[9px] flex gap-1 px-1">
					<Button type="button" variant="outline" onClick={preview} className="h-[32px] gap-[8px] rounded-[9px] border-[#d6d6d6] bg-white px-[10px] text-[16px] font-normal shadow-sm">
						<Monitor className="size-[18px]" />
						{r.host}
					</Button>
					<Button type="button" variant="outline" onClick={preview} className="h-[32px] gap-[8px] rounded-[9px] border-[#d6d6d6] bg-white px-[10px] text-[16px] font-normal shadow-sm">
						<FolderOpen className="size-[20px]" />
						{r.chooseProject}
					</Button>
				</div>
				<p className="mb-[25px] mt-[10px] px-[7px] text-[14px] leading-[20px] text-text-secondary">{r.noProject}</p>
				<section className="overflow-hidden rounded-[11px] border border-[#e2e2e2] bg-bg-panel shadow-[0_1px_2px_#00000008]">
					<div className={row}>
						<span className="self-start text-[16px] text-text-secondary">{r.destination}</span>
						<Button type="button" variant="outline" onClick={preview} className={select}>
							{r.newEachTime}
							<ChevronDown className="size-[18px] text-[#999]" />
						</Button>
					</div>
					<div className={row}>
						<span className="self-start text-[16px] text-text-secondary">{r.trigger}</span>
						<div className="flex h-[34px] rounded-[6px] bg-[#f1f2f3] p-[2px]">
							{["timed", "manual"].map((value) => (
								<Button
									key={value}
									type="button"
									variant="ghost"
									aria-pressed={trigger === value}
									onClick={() => setTrigger(value === "timed" ? "timed" : "manual")}
									className={`h-[30px] w-[62px] rounded-[5px] px-0 text-[16px] font-normal ${trigger === value ? "border border-[#ccc] bg-white shadow-sm" : "text-text-secondary"}`}
								>
									{value === "timed" ? r.timed : r.manual}
								</Button>
							))}
						</div>
					</div>
					<div className={row}>
						<span className="self-start text-[16px] text-text-secondary">{r.repeat}</span>
						<Button type="button" variant="outline" onClick={preview} className={select}>
							{r.daily}
							<ChevronDown className="size-[18px] text-[#999]" />
						</Button>
					</div>
					<div className={row}>
						<span className="self-start text-[16px] text-text-secondary">{r.time}</span>
						<Button type="button" variant="ghost" onClick={preview} className="h-[31px] px-0 text-[16px] font-normal">
							{r.timeValue}
						</Button>
					</div>
					<div className="px-[15px] py-[9px] text-[14px] leading-[24px]">
						<span className="mr-[10px] text-text-secondary">{r.upcoming}</span>
						{r.upcomingValue}
						<p className="m-0 text-text-secondary">{r.localTime}</p>
					</div>
				</section>
				<div className="mt-[24px] flex justify-end border-t border-[#e7e7e7] pt-[30px]">
					<Button type="submit" className="h-[36px] rounded-[11px] border border-[#555] bg-gradient-to-b from-[#333] to-[#191a1d] px-[13px] text-[16px] font-normal text-white shadow-sm">
						{r.saveTask}
					</Button>
				</div>
			</form>
		</Frame>
	);
}
