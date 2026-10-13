import { test, expect } from "./fixtures";
import { makeSeedProject } from "./open-session";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 文件抽屉目录行「挂顶」（对齐 VSCode workbench.tree.stickyScroll 语义）回归：
 * - docs / examples / deep 三层逐级叠在面板顶部（父目录留在上一槽位当面包屑），每层不透明、不重叠；
 * - 超过上限的第 4 层（sub）不挂顶，随内容滚走（VSCode 只固定最外层 maxLineCount=3 条）。
 *
 * 关键前提（改坏了会静默失效）：
 * - 目录行只能相对「真正滚动的祖先」sticky，滚动层是 .files-panel；抽屉里的
 *   .drawer-content-frame 不滚、不参与。
 * - CollapsibleContent 不能用 overflow-hidden：它会变成「不滚动的 scrollport」，
 *   把子目录行的 sticky 全部截住（子目录不再挂顶）。改用 overflow-clip 只裁剪、
 *   不建滚动容器（见 WorkspaceSurface 的注释）。
 * - 没有正 z 值时挂顶行会被自己的子行盖住（兄弟层 .file-children 按绘制顺序在后）。
 */
const seedProject = makeSeedProject("FileTreeSticky");
test.use({ seedProjects: [seedProject] });

/** 挂顶栈：最外层三层（与 WorkspaceSurface 的 FILE_STICKY_MAX_LEVELS 一致） */
const STACK = [
	{ dir: "docs", filePrefix: "doc" },
	{ dir: "examples", filePrefix: "ex" },
	{ dir: "deep", filePrefix: "dp" },
] as const;
/** 第 4 层：超过挂顶上限，不应 sticky */
const DEEPER = { dir: "sub", filePrefix: "sb" } as const;
const ROW_HEIGHT = 28;

for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, `root-${String(i).padStart(3, "0")}.ts`), `export const r${i} = ${i};\n`);
}
mkdirSync(join(seedProject.path, ...STACK.map((level) => level.dir), DEEPER.dir), { recursive: true });
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, "docs", `doc-${String(i).padStart(3, "0")}.md`), `# doc ${i}\n`);
}
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, "docs", "examples", `ex-${String(i).padStart(3, "0")}.ts`), `export const e${i} = ${i};\n`);
}
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, ...STACK.map((level) => level.dir), `dp-${String(i).padStart(3, "0")}.ts`), `export const d${i} = ${i};\n`);
}
for (let i = 0; i < 40; i++) {
	writeFileSync(join(seedProject.path, ...STACK.map((level) => level.dir), DEEPER.dir, `sb-${String(i).padStart(3, "0")}.ts`), `export const s${i} = ${i};\n`);
}

test("file tree directory rows stick to the top while scrolling", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 侧栏默认停在「聊天」分段，工作区项目行在「项目」分段下
	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "FileTreeSticky" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true", { timeout: 5000 });

	// 逐层展开（子目录懒加载，等第一个子行出现再展开下一层）
	const dirRows = window.locator(".files-panel .file-node-row.directory");
	const fileNames = window.locator(".files-panel .file-node-name");
	const stackNames = STACK.map((level) => level.dir);
	for (const level of [...STACK, DEEPER]) {
		await expect(dirRows.filter({ hasText: new RegExp(`^${level.dir}$`) }).first()).toBeVisible({ timeout: 15_000 });
		await dirRows
			.filter({ hasText: new RegExp(`^${level.dir}$`) })
			.first()
			.click();
		await expect(fileNames.filter({ hasText: new RegExp(`^${level.filePrefix}-000\\.`) }).first()).toBeVisible({ timeout: 15_000 });
	}

	/** 滚到最深层文件列表中部，返回各层目录行相对面板顶部的位置 */
	const measure = () =>
		window.evaluate(
			(input) => {
				const panel = document.querySelector(".files-panel") as HTMLElement;
				const panelTop = panel.getBoundingClientRect().top;
				const alphaOf = (color: string) => {
					const parts = color
						.match(/rgba?\(([^)]+)\)/)?.[1]
						.split(",")
						.map((part) => part.trim());
					return parts ? (parts.length === 4 ? Number(parts[3]) : 1) : null;
				};
				const rowByName = (name: string) => Array.from(document.querySelectorAll<HTMLElement>(".files-panel .file-node-row.directory")).find((row) => row.querySelector(".file-node-name")?.textContent === name);
				const anchor = Array.from(document.querySelectorAll<HTMLElement>(".files-panel .file-node-row")).find((row) => row.textContent?.includes(input.anchorFile));
				if (!anchor) return null;
				panel.scrollTop = anchor.getBoundingClientRect().top - panelTop + panel.scrollTop + 120;
				return {
					scrollTop: Math.round(panel.scrollTop),
					paddingTop: Number.parseFloat(getComputedStyle(panel).paddingTop),
					anchorTopRelPanel: Math.round(anchor.getBoundingClientRect().top - panelTop),
					// 抽屉底色（bg-background）是挂顶行必须对齐的底色，任何主题下都应一致
					drawerBackground: getComputedStyle(document.querySelector(".detail-drawer") as HTMLElement).backgroundColor,
					rows: input.names.map((name) => {
						const row = rowByName(name);
						if (!row) return null;
						const style = getComputedStyle(row);
						return { name, topRelPanel: Math.round(row.getBoundingClientRect().top - panelTop), position: style.position, backgroundAlpha: alphaOf(style.backgroundColor), backgroundColor: style.backgroundColor };
					}),
				};
			},
			{ names: [...stackNames, DEEPER.dir], anchorFile: "sb-020.ts" },
		);

	// 期望：第 i 层停在「内容区顶部 + i × 行高」
	const expectedOffsets = (paddingTop: number) => stackNames.map((_, index) => Math.round(paddingTop) + index * ROW_HEIGHT);
	// 鼠标从行上移开并等过渡结束：hover 高亮与 transition-base 会让底色暂时偏离抽屉底色
	await window.mouse.move(5, 5);
	await window.waitForTimeout(300);
	// 展开是 200ms 高度动画：动画期间 CollapsibleContent 只有几 px，目录行的 containing block
	// 随之缩水、没有可挂顶的余量（子层会停在自然位置）。轮询到稳态再断言，否则量到的是动画中间态。
	await expect
		.poll(
			async () => {
				const snapshot = await measure();
				if (!snapshot || snapshot.rows.some((row) => row === null)) return "pending";
				// 只比挂顶栈（最外层三层）；第 4 层 sub 不挂顶，位置随内容变化
				const offsets = snapshot.rows.slice(0, stackNames.length).map((row) => row!.topRelPanel);
				const expected = expectedOffsets(snapshot.paddingTop);
				return offsets.join(",") === expected.join(",") ? "settled" : offsets.join(",");
			},
			{ timeout: 10_000 },
		)
		.toBe("settled");
	const sticky = await measure();
	expect(sticky, "file tree rows must be present").not.toBeNull();
	const report = sticky!;

	// 前置：确实滚进了最深层（锚点行已滚到面板顶部之上）
	expect(report.scrollTop).toBeGreaterThan(500);
	expect(report.anchorTopRelPanel).toBeLessThan(0);
	// 最外层三层逐级挂顶：第 i 层在「内容区顶部 + i × 行高」，父目录留在上方当面包屑
	const stack = report.rows.slice(0, stackNames.length).map((row, index) => {
		expect(row, `directory row ${stackNames[index]} must be present`).not.toBeNull();
		return row!;
	});
	expect(stack.map((row) => row.topRelPanel)).toEqual(expectedOffsets(report.paddingTop));
	for (const row of stack) {
		expect(row.position).toBe("sticky");
		// 挂顶行必须不透明、且与抽屉底色同一 token：半透明/异色底会让下层行文字透出来（读写困难）
		expect(row.backgroundAlpha, "sticky header background must be fully opaque").toBe(1);
		expect(row.backgroundColor, "sticky header background must match the drawer surface").toBe(report.drawerBackground);
	}
	// 超过挂顶上限的第 4 层不 sticky（VSCode 只固定最外层 maxLineCount 条，更深的随内容滚走）
	const deeper = report.rows[stackNames.length];
	expect(deeper, `directory row ${DEEPER.dir} must be present`).not.toBeNull();
	expect(deeper!.position).toBe("static");
});
