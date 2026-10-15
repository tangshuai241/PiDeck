import { useState } from "react";
import { Check, Folder, GitBranch, MessageCircle, Monitor, Plus, UsersRound, X } from "lucide-react";
import { GitHubMark as Github } from "./GitHubMark";
import { Dialog as Primitive } from "radix-ui";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle, DialogDescription } from "@/components/ui-shadcn/dialog";
import { IconButton } from "./chrome";
import { ReferenceComposer } from "./ReferenceComposer";
import { r } from "./referenceCopy";

type Props = { sheet: "workspace" | "new-chat" | null; close: () => void; project: "A.all" | "workbench"; preview: () => void; onSend: () => void };

/** The two reference sheets share focus management, dismissal and a full-width bottom anchor. */
export function ReferenceSheets({ sheet, close, project, preview, onSend }: Props) {
	const [draft, setDraft] = useState("");
	const [type, setType] = useState("local");
	const workspace = sheet === "workspace";
	return (
		<Dialog
			open={!!sheet}
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogPortal>
				<DialogOverlay className="bg-black/50 backdrop-blur-none" />
				<Primitive.Content
					onOpenAutoFocus={(event) => event.preventDefault()}
					aria-describedby="reference-sheet-description"
					className={`fixed bottom-0 left-1/2 z-(--z-dialog) flex w-full max-w-[480px] -translate-x-1/2 flex-col rounded-t-[11px] border-t border-[#d5d5d5] bg-[#f9f9f9] text-[#202124] outline-none ${workspace ? "min-h-[366px] px-[15px] pb-[40px]" : "min-h-[488px] px-[19px] pb-[39px]"}`}
				>
					<span aria-hidden="true" className="mx-auto mb-[20px] mt-[15px] h-[8px] w-[50px] shrink-0 rounded-full bg-[#bfc2c8]" />
					<DialogDescription id="reference-sheet-description" className="sr-only">
						{workspace ? r.workspace : r.newChat}
					</DialogDescription>
					{workspace ? (
						<>
							<DialogTitle className="px-[10px] text-[15px] leading-[24px] font-normal text-text-secondary">{r.email}</DialogTitle>
							<p className="mb-[6px] mt-[21px] px-[10px] text-[15px] leading-[20px] text-text-secondary">{r.workspace}</p>
							<Button variant="ghost" onClick={close} className="h-[60px] justify-start gap-[15px] rounded-[16px] bg-[#ededf0] px-[10px] text-[20px] font-normal">
								<span className="grid size-[40px] shrink-0 place-items-center rounded-[12px] bg-[#36cbb7] text-[20px] font-medium text-white">{r.avatar}</span>
								<span className="min-w-0 flex-1 truncate text-left">{r.workspaceName}</span>
								<Check className="size-[21px] shrink-0 text-[#62656a]" />
							</Button>
							<div className="mt-[15px] border-t border-[#e7e7eb] pt-[12px]">
								{[
									{ text: r.createWorkspace, icon: Plus },
									{ text: r.invite, icon: UsersRound },
								].map(({ text, icon: Icon }) => (
									<Button key={text} variant="ghost" onClick={preview} className="h-[66px] w-full justify-start gap-[15px] rounded-xl px-[10px] text-[19px] font-normal">
										<span className="grid size-[45px] shrink-0 place-items-center rounded-[15px] bg-[#e2e3e8]">
											<Icon className="size-[22px]" strokeWidth={1.5} />
										</span>
										{text}
									</Button>
								))}
							</div>
						</>
					) : (
						<>
							<div className="relative mb-[16px] flex h-[16px] items-center justify-center">
								<DialogTitle className="text-[18px] font-semibold">{r.newChat}</DialogTitle>
								<IconButton label={r.close} onClick={close} className="absolute -right-[4px] -top-[16px] text-text-secondary [&_svg]:size-[23px]">
									<X />
								</IconButton>
							</div>
							<div className="space-y-[6px]">
								<div className="flex h-[58px] items-center rounded-[16px] border border-[#e2e2e6] bg-[#f0f0f2] px-[16px]">
									<span className="w-[95px] shrink-0 text-[15px] text-text-secondary">{r.machine}</span>
									<Button variant="ghost" onClick={preview} className="h-[40px] min-w-0 flex-1 justify-start gap-[10px] rounded-[8px] bg-[#ededf0] px-[15px] text-[18px] font-normal text-[#aaa]">
										<Monitor className="size-[18px]" />
										{r.machine}
									</Button>
								</div>
								<div className="flex h-[68px] items-center rounded-[16px] border border-[#e2e2e6] bg-[#f0f0f2] px-[16px]">
									<span className="w-[95px] shrink-0 text-[15px] text-text-secondary">{r.type}</span>
									<div className="flex h-[49px] min-w-0 flex-1 items-center rounded-[7px] bg-[#e2e3e8] p-[5px]">
										{[
											{ key: "local", text: r.local, icon: Folder },
											{ key: "github", text: r.github, icon: Github },
											{ key: "chat", text: r.chats, icon: MessageCircle },
										].map(({ key, text, icon: Icon }) => (
											<Button key={key} variant="ghost" aria-pressed={type === key} onClick={() => setType(key)} className={`h-[40px] min-w-0 flex-1 gap-[5px] rounded-[6px] px-[4px] text-[17px] font-normal ${type === key ? "border border-[#c7c9ce] bg-white shadow-sm" : "text-text-secondary"}`}>
												<Icon className="size-[17px]" strokeWidth={1.5} />
												{text}
											</Button>
										))}
									</div>
								</div>
								<div className="flex h-[58px] items-center rounded-[16px] border border-[#e2e2e6] bg-[#f0f0f2] px-[16px]">
									<span className="w-[95px] shrink-0 text-[15px] text-text-secondary">{r.project}</span>
									<Button variant="ghost" onClick={preview} className="h-[40px] min-w-0 flex-1 justify-start gap-[10px] rounded-[8px] bg-[#e8e9ed] px-[15px] text-[18px] font-normal">
										<Folder className="size-[18px]" />
										{project}
									</Button>
								</div>
								<div className="flex h-[62px] items-center rounded-[16px] border border-[#e2e2e6] bg-[#f0f0f2] px-[16px]">
									<span className="w-[95px] shrink-0 text-[15px] text-text-secondary">{r.mode}</span>
									<div className="flex h-[45px] min-w-0 flex-1 items-center rounded-[7px] bg-[#e2e3e8] p-[2px]">
										<Button variant="ghost" onClick={preview} className="h-[40px] min-w-0 flex-1 gap-[9px] rounded-[7px] border border-[#c7c9ce] bg-white px-[6px] text-[17px] font-normal shadow-sm">
											<Folder className="size-[18px]" />
											{r.localFiles}
										</Button>
										<Button variant="ghost" disabled className="h-[40px] min-w-0 flex-1 gap-[9px] px-[6px] text-[17px] font-normal text-text-secondary">
											<GitBranch className="size-[18px]" />
											{r.worktree}
										</Button>
									</div>
								</div>
							</div>
							<div className="mt-[19px]">
								<ReferenceComposer draft={draft} setDraft={setDraft} preview={preview} onSubmit={onSend} />
							</div>
						</>
					)}
					<div aria-hidden="true" className="pointer-events-none absolute bottom-[11px] left-1/2 h-[6px] w-[157px] -translate-x-1/2 rounded-full bg-[#999]" />
				</Primitive.Content>
			</DialogPortal>
		</Dialog>
	);
}
