/**
 * 工作目录名的 Windows 物理安全（真机缺陷回归）。
 *
 * 证据（live-acceptance/windows-physical-folder-counterexample.json）：同一件工作
 * dw_6dfb3d5e8add480f919beb5d 下面出现**两个**物理目录：
 * - `…-制作《桥梁监测安排》正式-Word-报告（DOCX），成品文件名「桥梁监测安排.`（结尾是点，Node namespaced fs 建的）
 * - `…-制作《桥梁监测安排》正式-Word-报告（DOCX），成品文件名「桥梁监测安排`（不带点，原生 Pi 的 Python 写入 36873 字节 DOCX 的那个）
 *
 * 原因：`buildWorkFolder` 先按共享标题策略归一，再 `slice(0, 40)` 截断，而截断正好落在
 * 「桥梁监测安排.docx」的点上；Windows 会把结尾的点归一到不带点的同名兄弟目录，
 * 于是 Node 与 Python 各写一边，宿主在带点目录里只看到空 staging，成果认不到。
 *
 * 修法：在**所有截断与空白转换之后**，把生成目录名的结尾点/空格去掉（Windows 禁止），
 * 清空后只剩 workId。跨平台同一套规则，不做平台猜测、不针对某种工具打补丁。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { SESSION_ID, createHarness, plain } from "./helpers/documentWorkServiceHarness.mjs";

const shared = loadTsCommonJs("src/shared/documentWork.ts");

/** 真机那条标题：第 40 个字符正好是「桥梁监测安排.docx」里的点。 */
const CRITICAL_TITLE = "制作《桥梁监测安排》正式 Word 报告（DOCX），成品文件名「桥梁监测安排.docx」";
const CRITICAL_BASENAME = "制作《桥梁监测安排》正式-Word-报告（DOCX），成品文件名「桥梁监测安排";

test("截断边界落在 .docx 的点上：生成的目录名不得以点结尾", () => {
	const folder = shared.buildWorkFolder("dw_abc", CRITICAL_TITLE);
	assert.equal(folder, `dw_abc-${CRITICAL_BASENAME}`, "点必须被去掉，其余内容与顺序保持不变");
	assert.equal(folder.endsWith("."), false, "Windows 不允许目录名以点结尾");
	assert.equal(folder.endsWith(" "), false, "Windows 不允许目录名以空格结尾");
});

test("多个结尾点/空格、全点标题与常规标题", () => {
	// 常规中文标题不受影响（可读性保持）。
	assert.equal(shared.buildWorkFolder("dw_abc", "季度报告"), "dw_abc-季度报告");
	// 多个结尾点与混入的空格：结果仍不得以点或空格结尾。
	for (const title of ["报告...", "报告. . .", "报告 .", "报告…", "报告. "]) {
		const folder = shared.buildWorkFolder("dw_abc", title);
		assert.equal(folder.startsWith("dw_abc"), true, title);
		assert.equal(/[. ]$/.test(folder), false, `${title} -> ${folder}`);
	}
	// 全是点 / 清洗后为空：只剩 workId，绝不生成 `dw_abc-.` 这类名字。
	assert.equal(shared.buildWorkFolder("dw_abc", "..."), "dw_abc");
	assert.equal(shared.buildWorkFolder("dw_abc", "   "), "dw_abc");
	assert.equal(shared.buildWorkFolder("dw_abc", "///"), "dw_abc");
	// Windows 保留字符仍在（既有行为）与长度边界。
	assert.equal(shared.buildWorkFolder("dw_abc", "季度:报告/草稿?"), "dw_abc-季度报告草稿");
	assert.ok(shared.buildWorkFolder("dw_abc", CRITICAL_TITLE).length <= 28 + 1 + 40, "workId 前缀 + 40 字标题的上界不变");
	// 目录名与 workId 身份前缀的约定不变（记录主键/路径推导依赖它）。
	assert.equal(shared.buildWorkFolder("dw_6dfb3d5e8add480f919beb5d", "季度报告"), "dw_6dfb3d5e8add480f919beb5d-季度报告");
	assert.equal(shared.sanitizeWorkTitle("报告. . .", "文稿工作"), "报告. . .", "展示标题保留原文，不受目录名清理影响");
});

test("真实建档：磁盘上只有一个物理目录，且路径元数据与之一致", async () => {
	const harness = createHarness();
	try {
		// 走真实服务建档（真实文件系统：ensureWorkDirectory 真的建目录）。
		const root = await harness.domain.store.registerOutputRoot(harness.outputRoot, "文稿");
		const created = await harness.domain.service.createWork({ requestId: "req-folder", sessionId: SESSION_ID, sourceTurnId: "turn-1", outputRootId: root.outputRootId, title: CRITICAL_TITLE });
		assert.equal(created.ok, true, JSON.stringify(created));
		const view = plain(created.value);

		// 物理事实：输出根下恰好一个目录，名字不以点/空格结尾。
		const entries = readdirSync(harness.outputRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
		assert.equal(entries.length, 1, `输出根下不得出现同一前缀的兄弟目录：${JSON.stringify(entries)}`);
		assert.equal(/[. ]$/.test(entries[0]), false, "生成的目录名不得以点/空格结尾");
		assert.equal(entries[0].startsWith(view.workId), true, "目录名必须以 workId 为前缀");

		// 记录元数据与磁盘一致：workDirectory 就是那一个物理目录，且真的存在。
		const record = await harness.domain.store.getRecord(view.workId);
		assert.equal(basename(record.workDirectory), entries[0]);
		assert.equal(existsSync(record.workDirectory), true);
		assert.equal(record.workDirectory, join(harness.outputRoot, entries[0]));

		// 展示标题与界面对外字段不受目录名清理影响。
		assert.equal(view.title, shared.sanitizeWorkTitle(CRITICAL_TITLE, "文稿工作"));
		assert.equal(view.outputRootLabel, "文稿");
		assert.equal(view.versions.length, 0);
	} finally {
		await harness.cleanup();
	}
});
