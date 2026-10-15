import { type ComponentProps, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, FileText, FolderOpen, MessageCircle, Monitor, Moon, Plus, ShieldCheck, Sparkles, Square, Sun, Wifi, WifiOff } from "lucide-react";
import { Button as SharedButton } from "@/components/ui-shadcn/button";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui-shadcn/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui-shadcn/dialog";
import { copy as c } from "./copy";
import "./theme.css";

type Tab = "home" | "files" | "devices";
type Phase = "awaiting" | "running" | "done" | "stopped";
type Message = { id: number; role: "user" | "assistant"; text: string };
const touch = "min-h-12 rounded-2xl";
const initialMessages: Message[] = [{ id: 1, role: "user", text: c.userMessage }, { id: 2, role: "assistant", text: c.assistantMessage }];

/** Keep preview controls on explicit semantic text and surface tokens. */
function Button({ variant = "default", className, ...props }: ComponentProps<typeof SharedButton>) {
	return <SharedButton variant={variant} className={cn(variant === "default" ? "text-primary-foreground" : "text-text-primary", variant === "outline" && "bg-bg-panel dark:bg-bg-panel", className)} {...props} />;
}

/** Owns only local simulation state; no network, model, file or host calls. */
function usePrototype() {
	const [tab, setTab] = useState<Tab>("home");
	const [chat, setChat] = useState<string | null>(null);
	const [dark, setDark] = useState(false);
	const [online, setOnline] = useState(true);
	const [paired, setPaired] = useState(true);
	const [phase, setPhase] = useState<Phase>("awaiting");
	const [expanded, setExpanded] = useState(false);
	const [draft, setDraft] = useState("");
	const [messages, setMessages] = useState<Message[]>(initialMessages);
	const [stream, setStream] = useState("");
	const [cursor, setCursor] = useState(0);
	const [preview, setPreview] = useState(false);
	const [revoke, setRevoke] = useState(false);
	const nextId = useRef(3);
	const conversations = useRef(new Map<string, { messages: Message[]; draft: string }>());
	const busy = stream.length > 0;
	useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
	useEffect(() => { if (chat) conversations.current.set(chat, { messages, draft }); }, [chat, messages, draft]);
	useEffect(() => {
		if (!stream || !online) return;
		const timer = window.setInterval(() => setCursor((current) => Math.min(current + 3, stream.length)), 45);
		return () => window.clearInterval(timer);
	}, [stream, online]);
	useEffect(() => {
		if (!stream || cursor < stream.length) return;
		setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: stream }]);
		setStream("");
		setCursor(0);
		if (phase === "running") setPhase("done");
	}, [stream, cursor, phase]);
	/** Changing contexts ends simulated output rather than leaking it to another chat. */
	function openChat(title: string) {
		const saved = conversations.current.get(title);
		setTab("home"); setChat(title); setDraft(saved?.draft ?? ""); setStream(""); setCursor(0);
		setMessages(saved?.messages ?? (title === c.chatTitle ? initialMessages : [{ id: nextId.current++, role: "assistant", text: title === c.readTitle ? c.readMessage : c.emptyMessage }]));
		if (phase === "running") setPhase("stopped");
	}
	/** Sending stays explicit after reconnect; drafts are never automatically replayed. */
	function send() {
		if (!online || !paired || busy || !draft.trim()) return;
		setMessages((current) => [...current, { id: nextId.current++, role: "user", text: draft.trim() }]);
		setDraft(""); setCursor(0); setStream(c.simulatedAnswer);
	}
	function approve() { if (!online || !paired || busy) return; setPhase("running"); setExpanded(true); setCursor(0); setStream(c.simulatedDone); }
	function stop() {
		if (cursor) setMessages((current) => [...current, { id: nextId.current++, role: "assistant", text: stream.slice(0, cursor) }]);
		setStream(""); setCursor(0); if (phase === "running") setPhase("stopped");
	}
	return { tab, setTab, chat, setChat, dark, setDark, online, setOnline, paired, setPaired, phase, expanded, setExpanded, draft, setDraft, messages, stream, cursor, busy, preview, setPreview, revoke, setRevoke, openChat, send, approve, stop };
}

/** Mobile composition uses existing semantic tokens and shared UI primitives. */
function App() {
	const s = usePrototype();
	const scroll = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [s.cursor, s.messages, s.phase, s.chat]);
	const status = !s.paired ? c.revoked : s.online ? c.online : c.offline;
	const navItems = [{ key: "home", title: c.home, icon: MessageCircle }, { key: "files", title: c.files, icon: FolderOpen }, { key: "devices", title: c.devices, icon: Monitor }] satisfies { key: Tab; title: string; icon: typeof Monitor }[];
	const open = (title: string) => { follow.current = true; s.openChat(title); };
	const artifact = () => <Button variant="outline" className="h-auto min-h-24 w-full justify-start gap-4 whitespace-normal rounded-2xl border-border-subtle bg-bg-panel p-4 text-left" onClick={() => s.setPreview(true)}><span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><FileText className="size-6" /></span><span className="min-w-0 flex-1"><span className="block text-base">{c.fileTitle}</span><span className="mt-1 block text-xs text-text-secondary">{c.fileType} · {c.fileHint}</span></span><ChevronRight /></Button>;
	return <main className="min-h-screen bg-bg-app px-0 py-0 font-[family-name:var(--font-family-base)] text-text-primary sm:px-8 sm:py-10 motion-reduce:[&_*]:animate-none motion-reduce:[&_*]:transition-none">
		<div className="mx-auto grid max-w-5xl items-center gap-12 lg:grid-cols-[1fr_414px]">
			<aside className="hidden px-4 lg:block">
				<p className="text-xs tracking-[0.2em] text-primary">{c.badge}</p>
				<h1 className="mt-7 whitespace-pre-line text-5xl leading-[1.22] tracking-tight">{c.title}</h1>
				<p className="mt-6 max-w-sm text-base leading-8 text-text-secondary">{c.intro}</p>
				<div className="mt-12 space-y-6">{c.principles.map((item, index) => <div key={item.title} className="flex gap-5"><span className="pt-1 font-mono text-xs text-primary">{String(index + 1).padStart(2, "0")}</span><div><h2 className="text-base">{item.title}</h2><p className="mt-1 text-sm leading-6 text-text-secondary">{item.body}</p></div></div>)}</div>
				<p className="mt-12 text-xs text-text-secondary">{c.styleNote}</p>
			</aside>
			<section className="mx-auto w-full max-w-[440px] overflow-hidden bg-bg-app sm:rounded-[36px] sm:border sm:border-border-default sm:shadow-xl" aria-label={c.badge}>
				<div className="flex min-h-12 items-center justify-between gap-2 border-b border-border-subtle bg-bg-panel px-4"><span className="text-xs text-text-secondary">{c.demo}</span><Button variant="ghost" className="size-12 rounded-full" aria-label={c.themeLabel} aria-pressed={s.dark} onClick={() => s.setDark(!s.dark)}>{s.dark ? <Sun /> : <Moon />}</Button></div>
				<header className="flex items-center justify-between px-6 pb-4 pt-6"><span className="text-2xl tracking-tight">{c.brand}<span className="ml-1 text-primary">.</span></span><Button variant="ghost" className={`${touch} gap-2 px-3 text-xs`} onClick={() => s.setTab("devices")}><span className={`size-2 rounded-full ${s.online && s.paired ? "bg-success" : "bg-warning"}`} />{status}<ChevronDown className="size-3" /></Button></header>
				<div className="relative flex h-[620px] flex-col overflow-hidden sm:h-[650px]">
					{s.tab === "home" && !s.chat && <div className="flex-1 overflow-y-auto px-6 pb-6">
						<div className="pb-8 pt-3"><p className="text-xs text-text-secondary">{c.homeHint}</p><h2 className="mt-3 text-[27px] leading-snug tracking-tight">{c.greeting}</h2></div>
						<div className="rounded-3xl bg-primary/8 p-5"><div className="flex items-center gap-2 text-xs text-primary"><Sparkles className="size-4" />{s.phase === "done" ? c.done : c.attentionTag}</div><h3 className="mt-4 text-xl leading-8">{s.phase === "done" ? c.fileTitle : c.attention}</h3><p className="mt-2 text-sm leading-7 text-text-secondary">{s.phase === "done" ? c.simulatedDone : c.attentionBody}</p><Button className={`${touch} mt-5 w-full justify-between px-4`} onClick={() => open(c.chatTitle)}>{c.resume}<ArrowRight /></Button></div>
						<div className="mb-2 mt-7 flex items-center justify-between"><h3 className="text-sm text-text-secondary">{c.recent}</h3><Button variant="ghost" className={touch} onClick={() => open(c.blankTitle)}><Plus />{c.newChat}</Button></div>
						{[{ title: c.chatTitle, preview: c.recentPreview, time: c.last }, { title: c.readTitle, preview: c.readPreview, time: c.yesterday }].map((row) => <Button key={row.title} variant="ghost" className="h-auto min-h-24 w-full justify-start whitespace-normal rounded-2xl px-0 py-4 text-left" onClick={() => open(row.title)}><span className="flex w-full flex-col gap-2"><span className="flex items-center justify-between"><span className="text-base">{row.title}</span><span className="text-xs text-text-secondary">{row.time}</span></span><span className="text-sm leading-6 text-text-secondary">{row.preview}</span></span></Button>)}
					</div>}
					{s.tab === "home" && s.chat && <>
						<div className="flex shrink-0 items-center gap-3 px-4 pb-3"><Button variant="ghost" className="size-12 rounded-full" aria-label={c.back} onClick={() => s.setChat(null)}><ArrowLeft /></Button><div><h2 className="text-base">{s.chat}</h2><p className="mt-1 text-xs text-text-secondary">{c.recentHint}</p></div></div>
						<div ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 65; }} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-3" data-testid="timeline">
							{s.messages.map((message) => <div key={message.id} className={message.role === "user" ? "ml-7 rounded-[22px] rounded-br-md bg-bg-muted px-4 py-3 text-base leading-7" : "text-base leading-8"}><p className="whitespace-pre-wrap break-words">{message.text}</p>{message.role === "user" && <span className="mt-2 flex items-center justify-end gap-1 text-xs text-text-secondary"><CheckCheck className="size-3" />{c.sent}</span>}</div>)}
							{s.chat === c.chatTitle && <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-panel"><Button variant="ghost" className="h-auto min-h-14 w-full justify-between rounded-none px-4 text-sm" onClick={() => s.setExpanded(!s.expanded)} aria-expanded={s.expanded}><span className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-primary" />{s.phase === "done" ? c.done : s.phase === "running" ? c.running : s.phase === "stopped" ? c.stopped : c.progress}</span><ChevronDown className={s.expanded ? "rotate-180" : ""} /></Button>{s.expanded && <ol className="space-y-3 px-4 pb-4">{c.steps.map((step, index) => <li key={step} className="flex items-center gap-3 text-xs text-text-secondary"><span className="grid size-5 place-items-center rounded-full bg-primary/10 text-primary">{index === 0 || s.phase === "done" ? <Check className="size-3" /> : index + 1}</span>{step}</li>)}</ol>}</section>}
							{s.chat === c.chatTitle && (s.phase === "awaiting" || s.phase === "stopped") && <section className="rounded-2xl bg-primary/8 p-4"><h3 className="text-sm">{c.confirmTitle}</h3><p className="mt-2 text-sm leading-7 text-text-secondary">{c.confirmBody}</p><Button className={`${touch} mt-4 w-full`} disabled={!s.online || !s.paired || s.busy} onClick={s.approve}><Check />{c.approve}</Button><Button variant="ghost" className={`${touch} mt-1 w-full`} onClick={() => s.setDraft(c.reviseDraft)}>{c.revise}</Button></section>}
							{s.busy && <p className="whitespace-pre-wrap text-base leading-8" aria-label={c.sending}>{s.stream.slice(0, s.cursor)}<span className="ml-1 inline-block size-1.5 rounded-full bg-primary" /></p>}
							{s.chat === c.chatTitle && s.phase === "done" && artifact()}
						</div>
						<form className="shrink-0 bg-bg-app px-4 pb-4 pt-3" onSubmit={(event) => { event.preventDefault(); follow.current = true; s.send(); }}>
							{!s.online && <p role="status" className="mb-2 px-2 text-xs leading-5 text-text-secondary">{s.busy ? c.busyOffline : c.retained}</p>}
							<div className="rounded-3xl border border-border-default bg-bg-panel p-2 shadow-sm"><Textarea aria-label={c.placeholder} placeholder={c.placeholder} value={s.draft} onChange={(event) => s.setDraft(event.target.value)} className="min-h-14 max-h-32 resize-none border-0 bg-transparent px-3 py-3 text-base shadow-none focus-visible:ring-0" /><div className="flex justify-end">{s.busy ? <Button type="button" variant="secondary" className={touch} onClick={s.stop}><Square />{c.stop}</Button> : <Button type="submit" className="size-12 rounded-full" aria-label={c.send} disabled={!s.online || !s.paired || !s.draft.trim()}><ArrowRight className="size-5" /></Button>}</div></div>
						</form>
					</>}
					{s.tab === "files" && <div className="flex-1 overflow-y-auto px-6 pb-6"><h2 className="mt-3 text-[27px]">{c.files}</h2><p className="mb-8 mt-3 text-sm text-text-secondary">{c.filesHint}</p>{s.phase === "done" ? artifact() : <div className="mt-20 flex flex-col items-center text-center"><FolderOpen className="size-12 text-primary" /><p className="mt-5 text-base">{c.fileEmpty}</p><p className="mt-2 text-sm leading-7 text-text-secondary">{c.fileEmptyHint}</p><Button className={`${touch} mt-6`} onClick={() => open(c.chatTitle)}>{c.resume}<ArrowRight /></Button></div>}</div>}
					{s.tab === "devices" && <div className="flex-1 overflow-y-auto px-6 pb-6"><h2 className="mt-3 text-[27px]">{c.deviceTitle}</h2><p className="mt-3 text-sm leading-7 text-text-secondary">{c.deviceHint}</p><div className="mt-8 rounded-3xl border border-border-subtle bg-bg-panel p-5"><Monitor className="mb-6 size-10 text-primary" /><h3 className="text-lg">{c.computer}</h3><p className="mt-2 text-xs text-text-secondary">{s.paired ? c.deviceMeta : c.revoked}</p><div className="my-5 flex items-center gap-2 text-sm">{s.online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}{status}</div><p className="text-sm leading-7 text-text-secondary">{s.online ? c.onlineDetail : c.offlineDetail}</p><Button variant="outline" className={`${touch} mt-5 w-full`} disabled={!s.paired} onClick={() => s.setOnline(!s.online)}>{s.online ? c.disconnect : c.connect}</Button></div><div className="mt-7 flex gap-3"><ShieldCheck className="mt-1 size-5 shrink-0 text-primary" /><div><h3 className="text-sm">{c.privateTitle}</h3><p className="mt-2 text-xs leading-6 text-text-secondary">{c.privateBody}</p></div></div><Button variant="ghost" className={`${touch} mt-6 w-full`} onClick={() => { if (s.paired) s.setRevoke(true); else { s.setPaired(true); s.setOnline(true); } }}>{s.paired ? c.revoke : c.pair}</Button></div>}
				</div>
				<nav aria-label={c.accessibility} className="grid grid-cols-3 border-t border-border-subtle bg-bg-panel px-3 pb-5 pt-2">{navItems.map(({ key, title, icon: Icon }) => <Button key={key} variant="ghost" className={`h-16 flex-col gap-1 rounded-2xl text-xs ${s.tab === key ? "text-primary" : "text-text-secondary"}`} aria-current={s.tab === key ? "page" : undefined} onClick={() => s.setTab(key)}><span className={`grid h-7 w-14 place-items-center rounded-full ${s.tab === key ? "bg-primary/10" : ""}`}><Icon className="size-5" /></span>{title}</Button>)}</nav>
			</section>
		</div>
		<Dialog open={s.preview} onOpenChange={s.setPreview}><DialogContent className="max-h-[85dvh] max-w-md overflow-y-auto rounded-3xl"><DialogTitle>{c.previewTitle}</DialogTitle><DialogDescription>{c.previewNote}</DialogDescription><div className="my-3 space-y-7 rounded-2xl bg-bg-muted p-5">{c.previewSections.map((item) => <section key={item.title}><h3 className="text-base">{item.title}</h3><p className="mt-3 text-sm leading-7 text-text-secondary">{item.body}</p></section>)}</div><Button className={touch} onClick={() => { s.setPreview(false); open(c.chatTitle); s.setDraft(c.reviseFileDraft); }}>{c.reviseFile}<ArrowRight /></Button></DialogContent></Dialog>
		<Dialog open={s.revoke} onOpenChange={s.setRevoke}><DialogContent className="max-w-sm rounded-3xl"><DialogTitle>{c.revokeTitle}</DialogTitle><DialogDescription>{c.revokeBody}</DialogDescription><Button variant="outline" className={touch} onClick={() => s.setRevoke(false)}>{c.cancel}</Button><Button className={touch} onClick={() => { s.stop(); s.setPaired(false); s.setOnline(false); s.setRevoke(false); }}>{c.confirmRevoke}</Button></DialogContent></Dialog>
	</main>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
