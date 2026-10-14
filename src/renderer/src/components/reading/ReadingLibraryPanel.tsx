/**
 * 书库面板：作品 + 每个作品下的具体版本。
 *
 * 契约要求「一个作品的不同版本共存」：版本是独立行，各自显示自己的 rel 与大小/时间，
 * 不合并、不取「最新一个」代替其它版本。`book` 参数只允许用服务端返回的 rel，
 * 界面不构造路径（这里的 rel 只用来显示与区分版本）。
 */
import { BookOpen, RefreshCw } from "lucide-react";
import { t } from "../../i18n";
import type { ReadingEdition, ReadingWork } from "../../../../shared/types/reading";
import { Button } from "../ui-shadcn/button";
import { formatI18nDateTime } from "../../i18n";

export function ReadingLibraryPanel(props: { works: ReadingWork[]; loading: boolean; selected: { workId: string; editionId: string } | null; onSelect: (next: { workId: string; editionId: string }) => void; onRefresh: () => void }) {
	return (
		<section className="flex min-h-0 shrink-0 flex-col gap-2">
			<header className="flex shrink-0 items-center justify-between gap-2">
				<span className="text-caption font-medium text-foreground">{t("reading.libraryTitle")}</span>
				<Button variant="ghost" size="sm" className="shrink-0" disabled={props.loading} onClick={props.onRefresh}>
					<RefreshCw className={props.loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
					{t("reading.libraryRefresh")}
				</Button>
			</header>
			{props.works.length === 0 && !props.loading && <p className="text-micro text-muted-foreground">{t("reading.libraryEmpty")}</p>}
			<ul className="flex flex-col gap-2">
				{props.works.map((work) => (
					<li key={work.workId} className="flex flex-col gap-1">
						<div className="flex items-center gap-1.5">
							<BookOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="min-w-0 truncate text-caption text-foreground">{work.title}</span>
							<span className="shrink-0 text-micro text-muted-foreground">{t("reading.libraryEditionCount", { count: work.editions.length })}</span>
						</div>
						{work.author && <span className="pl-5 text-micro text-muted-foreground">{work.author}</span>}
						<ul className="flex flex-col gap-1 pl-5">
							{work.editions.map((edition) => (
								<li key={edition.editionId}>
									<button type="button" onClick={() => props.onSelect({ workId: work.workId, editionId: edition.editionId })} className={`flex w-full flex-col gap-0.5 rounded-sm px-2 py-1 text-left hover:bg-accent/40 ${isSelected(props.selected, work.workId, edition.editionId) ? "bg-accent/60" : ""}`}>
										<span className="min-w-0 truncate text-caption text-foreground">{editionLabel(edition)}</span>
										<span className="min-w-0 truncate text-micro text-muted-foreground">{editionMeta(edition)}</span>
									</button>
								</li>
							))}
						</ul>
					</li>
				))}
			</ul>
		</section>
	);
}

function isSelected(selected: { workId: string; editionId: string } | null, workId: string, editionId: string): boolean {
	return selected !== null && selected.workId === workId && selected.editionId === editionId;
}

/** 版本标题：优先服务端给的标题，否则用文件名（rel 的最后一段），不猜书名。 */
function editionLabel(edition: ReadingEdition): string {
	if (edition.title && edition.title.trim().length > 0) return edition.title;
	const parts = edition.rel.split(/[\\/]/);
	return parts[parts.length - 1] ?? edition.rel;
}

/** 版本副行：相对路径 + 大小 + 时间，用来区分同名的不同版本。 */
function editionMeta(edition: ReadingEdition): string {
	const size = edition.size > 0 ? `${Math.max(1, Math.round(edition.size / 1024))} KB` : "—";
	const stamp = edition.mtime > 0 ? formatI18nDateTime(edition.mtime) : "—";
	return `${edition.rel} · ${size} · ${stamp}`;
}
