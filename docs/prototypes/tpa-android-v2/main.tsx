import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui-shadcn/dialog";
import { ChatScreen } from "./ChatScreen";
import { HomeScreens, type HomeRoute } from "./HomeScreens";
import { ReferenceSheets } from "./ReferenceSheets";
import { TaskEditor } from "./TaskEditor";
import { c } from "./copy";
import { r } from "./referenceCopy";
import "./theme.css";

type Route = HomeRoute | "chat" | "task-new";
/** Direct review links select a known screenshot without adding controls to the depicted app. */
function initialRoute(): Route {
	const value = new URLSearchParams(location.search).get("screen");
	return value === "chat" || value === "tasks" || value === "projects" || value === "project" || value === "task-new" ? value : "home";
}

/** Own only local review navigation; no production backend or cloud state is touched. */
function App() {
	const [route, setRoute] = useState<Route>(initialRoute);
	const [sheet, setSheet] = useState<"workspace" | "new-chat" | null>(() => {
		const value = new URLSearchParams(location.search).get("sheet");
		return value === "workspace" || value === "new-chat" ? value : null;
	});
	const [project, setProject] = useState<"A.all" | "workbench">("workbench");
	const [notice, setNotice] = useState("");
	const preview = () => setNotice(c.previewNotice);
	return (
		<>
			{route === "chat" ? (
				<ChatScreen onBack={() => setRoute("home")} />
			) : route === "task-new" ? (
				<TaskEditor onClose={() => setRoute("tasks")} preview={preview} notify={setNotice} />
			) : (
				<HomeScreens route={route} navigate={setRoute} project={project} chooseProject={setProject} openWorkspace={() => setSheet("workspace")} openNewChat={() => setSheet("new-chat")} openChat={() => setRoute("chat")} preview={preview} />
			)}
			<ReferenceSheets sheet={sheet} close={() => setSheet(null)} project={project} preview={preview} onSend={() => setNotice(r.chatPreview)} />
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
		</>
	);
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
