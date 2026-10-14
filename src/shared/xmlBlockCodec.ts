/**
 * 自包含 XML 块的编解码基元（主进程 / 渲染进程共用）。
 *
 * 为什么独立成文件：引用块（expandedRefBlocks）与工作台材料块（workbenchMaterialBlocks）
 * 分属两个域，但都用同一套属性转义与闭合标签消毒。放在这里让两个域单向依赖本模块，
 * 避免「材料块 ↔ 引用块」互相 import 形成环。
 *
 * 边界：只做字符级转义/反转义与闭合标签改写，不解析块结构、不认识任何业务字段。
 */

/** XML 属性转义（label / name / messageId / 材料元数据可能含引号、尖括号、换行）。 */
export function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** XML 属性反转义（仅处理本模块生成的四种实体）。 */
export function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

/** 正文里的闭合标签会提前截断解析：写入前改写成无害形态（`</tag>` → `</tag_>`）。 */
export function sanitizeBlockClosingTag(value: string, tagName: string): string {
	return value.replace(new RegExp(`</${tagName}>`, "gi"), `</${tagName}_>`);
}
