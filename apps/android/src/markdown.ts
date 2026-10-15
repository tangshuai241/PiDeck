import type { Root, Nodes, Table } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

// Match desktop markdownPlugins.ts: single tildes occur in temperatures and short paths.
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });

/** Native adapter for the desktop Streamdown remark/GFM grammar; never executes HTML. */
export function parseNativeMarkdown(source: string): Root {
	const literal: Root = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: source }] }] };
	// Remote previews are bounded to 12k. Pathological structure falls back without losing text.
	if (source.length > 12000) return literal;
	try {
		const tree = parser.parse(source);
		const queue: { node: Nodes; depth: number }[] = [{ node: tree, depth: 0 }];
		let count = 0;
		while (queue.length) {
			const item = queue.pop();
			if (!item) break;
			if (++count > 1600 || item.depth > 24) return literal;
			if ("children" in item.node) for (const child of item.node.children) queue.push({ node: child, depth: item.depth + 1 });
		}
		return tree;
	} catch {
		return literal;
	}
}

/** Extract visible text without interpreting HTML or following URLs. */
export function markdownText(node: Nodes): string {
	if ("value" in node) return node.value;
	if ("children" in node) return node.children.map(markdownText).join("");
	return "";
}

/** Mobile links have no desktop filesystem or intent privileges. */
export function safeMarkdownUrl(value: string): string | undefined {
	if (/[\u0000-\u0020\u007f]/.test(value)) return;
	if (/^(https?:\/\/|mailto:)/i.test(value)) return value;
}

/** Bound individual columns, with horizontal scrolling owned by the table view. */
export function tableColumnWidths(table: Table): number[] {
	return (table.children[0]?.children ?? []).map((_, index) => {
		const sizes = table.children.map((row) => Array.from(markdownText(row.children[index] ?? { type: "text", value: "" })).reduce((size, char) => size + (/[^\x00-\xff]/.test(char) ? 13 : 7), 16));
		return Math.min(180, Math.max(64, ...sizes));
	});
}
