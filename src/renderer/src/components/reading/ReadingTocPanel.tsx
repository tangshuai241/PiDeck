/**
 * 目录面板：只列能进正文的章节。
 *
 * 「选合法 chapter/href」的落点在 utils/readingScope.isReadingChapterSelectable：
 * 前置页（frontmatter）与空 href 不进正文链路，界面上明确标注为不可读，而不是点了报错。
 */
import { ListTree } from "lucide-react";
import { t } from "../../i18n";
import type { ReadingTocItem } from "../../../../shared/types/reading";
import { isReadingChapterSelectable } from "../../utils/readingScope";

export function ReadingTocPanel(props: { toc: ReadingTocItem[]; activeHref: string | null; onOpen: (item: ReadingTocItem) => void }) {
	return (
		<section className="flex min-h-0 shrink-0 flex-col gap-2">
			<header className="flex shrink-0 items-center gap-1.5">
				<ListTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span className="text-caption font-medium text-foreground">{t("reading.tocTitle")}</span>
			</header>
			{props.toc.length === 0 && <p className="text-micro text-muted-foreground">{t("reading.tocEmpty")}</p>}
			<ul className="flex flex-col gap-0.5">
				{props.toc.map((item) => {
					const selectable = isReadingChapterSelectable(item);
					const active = selectable && props.activeHref !== null && props.activeHref.trim() === item.href.trim();
					return (
						<li key={`${item.pos}:${item.href}`}>
							<button type="button" disabled={!selectable} onClick={() => props.onOpen(item)} className={`flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left ${selectable ? "hover:bg-accent/40" : "opacity-60"} ${active ? "bg-accent/60" : ""}`}>
								<span className="min-w-0 flex-1 truncate text-caption text-foreground">{item.title.trim().length > 0 ? item.title : item.href}</span>
								{!selectable && <span className="shrink-0 text-micro text-muted-foreground">{t("reading.tocFrontmatter")}</span>}
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
