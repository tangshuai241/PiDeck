import { useState } from "react";
import { Archive, CalendarClock, ChevronLeft, Clock3, FileCode2, Folder, FolderOpen, Folders, Laptop, MessageSquareText, Plus, Search, Settings, Settings2 as SlidersHorizontal, PenLine } from "lucide-react";
import { GitHubMark as Github } from "./GitHubMark";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { cn } from "@/lib/utils";
import { Frame, IconButton } from "./chrome";
import { r } from "./referenceCopy";

export type HomeRoute = "home" | "tasks" | "projects" | "project";

/** Lucide folder plus the rear outline matches the reference's stacked folder silhouette. */
function ReferenceFolderIcon({ className }: { className?: string; strokeWidth?: number; fill?: string }) {
	return (
		<span className={cn("relative inline-block size-[28px]", className)}>
			<span className="absolute bottom-[1px] left-0 h-[20px] w-[24px] rounded-bl-[2px] border-b-[2.5px] border-l-[2.5px] border-current" />
			<Folder className="absolute right-0 top-0 size-[24px] fill-current" strokeWidth={1.5} />
		</span>
	);
}
type Props = { route: HomeRoute; navigate: (route: HomeRoute | "task-new") => void; openWorkspace: () => void; openChat: () => void; openNewChat: () => void; preview: () => void; project: "A.all" | "workbench"; chooseProject: (name: "A.all" | "workbench") => void };

/** The floating three-tab rail follows the supplied home and project variants. */
function BottomRail({ route, navigate, openNewChat, preview }: Pick<Props, "route" | "navigate" | "openNewChat" | "preview">) {
	const project = route === "project";
	const entries = project
		? [
				{ name: r.chats, icon: MessageSquareText, key: "project" },
				{ name: r.files, icon: FileCode2, key: "files" },
				{ name: r.settings, icon: Settings, key: "settings" },
			]
		: [
				{ name: r.chats, icon: MessageSquareText, key: "home" },
				{ name: r.tasks, icon: Clock3, key: "tasks" },
				{ name: r.projects, icon: ReferenceFolderIcon, key: "projects" },
			];
	return (
		<nav aria-label={project ? "项目导航" : "主导航"} className="flex shrink-0 items-center gap-[14px] px-5 pb-[35px] pt-3">
			<div className="flex h-[71px] min-w-0 flex-1 items-center rounded-full border border-[#dcdcdf] bg-[#f0f0f2] p-[9px] shadow-[0_7px_15px_#00000018]">
				{entries.map(({ name, key, icon: Icon }) => (
					<Button
						key={key}
						variant="ghost"
						aria-current={route === key ? "page" : undefined}
						onClick={() => {
							if (key === "home" || key === "tasks" || key === "projects") navigate(key);
							else if (key !== "project") preview();
						}}
						className={cn("h-[54px] min-w-0 flex-1 flex-col gap-[1px] rounded-full px-0 py-0 text-[14px] leading-[18px] font-normal text-text-secondary hover:bg-[#e5e6e9]", route === key && "bg-[#d3ddf1] text-[#608cf0] hover:bg-[#d3ddf1]")}
					>
						<Icon strokeWidth={2.4} fill={key === "projects" || (key === "project" && route === key) || key === "home" ? "currentColor" : "none"} className={cn("size-[28px]", (key === "home" || key === "project") && "[&_path]:stroke-bg-app")} />
						{name}
					</Button>
				))}
			</div>
			<IconButton label={r.write} onClick={openNewChat} className="size-[71px] shrink-0 bg-[#191a1d] text-white shadow-[0_5px_10px_#00000020] hover:bg-[#292a2e]">
				<PenLine strokeWidth={1.8} />
			</IconButton>
		</nav>
	);
}

/** Home, schedule and project screens share only the chrome visible in their references. */
export function HomeScreens(props: Props) {
	const { route, navigate, openWorkspace, openNewChat, preview, project, chooseProject } = props;
	const [search, setSearch] = useState("");
	const isProject = route === "project";
	const isTasks = route === "tasks";
	const projectLetter = project === "A.all" ? "A" : "W";
	const searchField = (placeholder: string) => (
		<div className={`relative min-w-0 flex-1 ${isProject ? "" : "mr-[6px]"}`}>
			<Search className="pointer-events-none absolute left-[16px] top-1/2 size-[18px] -translate-y-1/2 text-text-secondary" strokeWidth={1.8} />
			<Input aria-label={placeholder} placeholder={placeholder} value={search} onChange={(event) => setSearch(event.target.value)} className="h-[45px] rounded-full border-[#dfe0e4] bg-[#e2e3e8] pl-[41px] pr-3 text-[16px] font-normal text-text-secondary shadow-none placeholder:text-text-secondary md:text-[16px]" />
		</div>
	);
	return (
		<Frame clock={route === "home" ? "5:36" : "5:37"}>
			<header className={`flex h-[65px] shrink-0 items-center gap-[10px] pl-[15px] pb-[1px] ${isProject ? "pr-[15px]" : "pr-[20px]"}`}>
				{isProject ? (
					<>
						<IconButton
							label="返回项目"
							onClick={() => {
								setSearch("");
								navigate("projects");
							}}
							className="size-[45px] bg-[#e1e2e7] [&_svg]:size-[24px]"
						>
							<ChevronLeft />
						</IconButton>
						<span className={cn("grid size-[30px] shrink-0 place-items-center rounded-[7px] text-[16px] text-white", project === "A.all" ? "bg-[#88cf32]" : "bg-[#cb3688]")}>{projectLetter}</span>
					</>
				) : (
					<Button aria-label={r.account} onClick={openWorkspace} className="size-[45px] shrink-0 rounded-full bg-[#36cbb7] p-0 text-[21px] font-medium text-white hover:bg-[#36cbb7]">
						{r.avatar}
					</Button>
				)}
				{!isTasks && searchField(route === "projects" ? r.searchProjects : r.searchChats)}
				{isTasks && <span className="flex-1" />}
				{!isTasks && (
					<IconButton label={route === "projects" ? r.addProject : r.archive} onClick={preview} className={cn("size-[45px] border border-border-subtle [&_svg]:size-[25px]", isProject ? "bg-[#e1e2e7]" : "mr-[10px]")}>
						{route === "projects" ? <Plus /> : <Archive strokeWidth={1.8} />}
					</IconButton>
				)}
				{!isProject && (
					<IconButton label={r.settings} onClick={preview} className="size-[45px] border border-border-subtle [&_svg]:size-[26px]">
						<Settings strokeWidth={1.9} />
					</IconButton>
				)}
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{(route === "home" || route === "project") && (
					<>
						<div className="flex justify-end px-5 pt-[15px]">
							<IconButton label={r.filter} onClick={preview} className="size-[40px] border border-[#dcdde1] bg-[#e2e3e8] text-text-secondary [&_svg]:size-[22px]">
								<SlidersHorizontal strokeWidth={1.5} />
							</IconButton>
						</div>
						<div className="mx-[15px] mt-[22px] grid min-h-[88px] place-items-center rounded-[21px] border border-[#e3e3e7] bg-[#f0f0f2] px-4 text-center text-[17px] text-text-secondary">{isProject || search ? r.noMatch : r.noChats}</div>
					</>
				)}
				{route === "projects" && (
					<>
						<div className="mx-[15px] mt-[9px] inline-flex h-[38px] items-center rounded-full bg-[#eeeef0] px-2">
							<Button variant="ghost" className="h-9 gap-2 rounded-full px-[10px] text-[16px] font-normal" onClick={preview}>
								<Laptop className="size-[18px]" />
								{r.local}
							</Button>
							<Button variant="ghost" className="h-9 gap-2 rounded-full px-[10px] text-[16px] font-normal text-text-secondary" onClick={preview}>
								<Github className="size-[18px]" fill="currentColor" />
								{r.github}
							</Button>
						</div>
						<p className="mx-[25px] mb-[4px] mt-[25px] flex items-center gap-[8px] text-[16px]">
							<span className="size-[10px] rounded-full bg-[#c3c5ca]" />
							{r.host}
						</p>
						<div className="mx-[15px] rounded-[21px] border border-[#e3e3e7] bg-[#f0f0f2] px-[15px] py-[6px]">
							{[
								{ name: r.projectA, path: r.projectAPath, letter: "A", tone: "bg-[#88cf32]" },
								{ name: r.projectW, path: r.projectWPath, letter: "W", tone: "bg-[#cb3688]" },
							]
								.filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase()))
								.map((entry) => (
									<Button
										variant="ghost"
										key={entry.name}
										onClick={() => {
											chooseProject(entry.letter === "A" ? "A.all" : "workbench");
											setSearch("");
											navigate("project");
										}}
										className="h-[70px] w-full justify-start gap-[15px] rounded-xl p-0 text-left"
									>
										<span className={cn("grid size-[50px] shrink-0 place-items-center rounded-[15px] text-[24px] font-normal text-white", entry.tone)}>{entry.letter}</span>
										<span className="min-w-0">
											<span className="block text-[21px] leading-[29px] font-medium">{entry.name}</span>
											<span className="block truncate text-[15px] leading-[24px] font-normal text-text-secondary">{entry.path}</span>
										</span>
									</Button>
								))}
						</div>
					</>
				)}
				{isTasks && (
					<>
						<div className="mx-5 mt-[15px] flex items-center gap-[10px]">
							<h1 className="m-0 mr-auto text-[18px] font-normal">{r.tasks}</h1>
							<div className="relative w-[200px] max-w-[48vw]">
								<Search className="absolute left-[9px] top-[9px] size-[18px] text-text-secondary" />
								<Input aria-label={r.searchTasks} placeholder={r.searchTasks} className="h-9 rounded-[10px] border-[#d7d7d7] bg-[#eee] pl-9 text-[16px] shadow-inner placeholder:text-[#999] md:text-[16px]" />
							</div>
							<Button aria-label={r.newTask} onClick={() => navigate("task-new")} className="h-9 w-[43px] rounded-[10px] border border-[#555] bg-gradient-to-b from-[#333] to-[#191a1d] p-0 text-white shadow-sm [&_svg]:size-5">
								<Plus />
							</Button>
						</div>
						<div className="mx-5 mt-[94px] flex flex-col items-center text-center">
							<CalendarClock className="size-[25px] text-text-secondary" strokeWidth={1.9} />
							<h2 className="mb-[10px] mt-[10px] text-[18px] font-normal">{r.noTasks}</h2>
							<p className="m-0 max-w-[424px] text-[16px] leading-[24px] text-text-secondary">{r.noTasksBody}</p>
							<Button variant="outline" onClick={() => navigate("task-new")} className="mt-[17px] h-[37px] gap-[8px] rounded-[11px] border-[#d8d8d8] bg-gradient-to-b from-white to-[#fafafa] px-[15px] text-[16px] font-normal shadow-sm">
								<Plus className="size-[18px]" />
								{r.newTask}
							</Button>
						</div>
					</>
				)}
			</div>
			<BottomRail route={route} navigate={navigate} openNewChat={openNewChat} preview={preview} />
		</Frame>
	);
}
