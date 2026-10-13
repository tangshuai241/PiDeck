/**
 * 测试用最小 ZIP 写入器（stored 条目）。
 *
 * 为什么需要：docx 检查器要读 OOXML 容器，而项目不引压缩库。测试要构造「内容相同、
 * 包不同」等合成文稿，就必须能生成合法 ZIP。这里只写 stored（不压缩）条目，
 * 足以覆盖中央目录解析、成员读取与包结构指纹三条路径。
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value;
	}
	return table;
})();

function crc32(buffer) {
	let crc = -1;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ -1) >>> 0;
}

/**
 * 构造 ZIP。`entries` 为 `{ name, content, deflate? }`；`deflate: true` 走 deflateRaw，
 * 用来覆盖压缩条目路径。
 */
export function buildZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), "utf8");
		const deflated = entry.deflate === true;
		const data = deflated ? deflateRawSync(raw) : raw;
		const crc = crc32(raw);
		const method = deflated ? 8 : 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, name, data);
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(20, 6);
		header.writeUInt16LE(0x0800, 8);
		header.writeUInt16LE(method, 10);
		header.writeUInt16LE(0, 12);
		header.writeUInt16LE(0, 14);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(data.length, 20);
		header.writeUInt32LE(raw.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt16LE(0, 30);
		header.writeUInt16LE(0, 32);
		header.writeUInt16LE(0, 34);
		header.writeUInt16LE(0, 36);
		header.writeUInt32LE(0, 38);
		header.writeUInt32LE(offset, 42);
		central.push(header, name);
		offset += local.length + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([...chunks, directory, end]);
}

/** 构造最小可用 docx：段落文本 + 可选标题样式。 */
export function buildDocxXml(paragraphs) {
	const body = paragraphs
		.map((paragraph) => {
			if (typeof paragraph === "string") return `<w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p>`;
			if (paragraph.kind === "trackedInsert") return `<w:p><w:ins w:id="1" w:author="a"><w:r><w:t>${escapeXml(paragraph.text)}</w:t></w:r></w:ins></w:p>`;
			if (paragraph.kind === "textBox") return `<w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>${escapeXml(paragraph.text)}</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>`;
			return `<w:p><w:pPr><w:pStyle w:val="${escapeXml(paragraph.styleId)}"/></w:pPr><w:r><w:t>${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
}

/** 最小 styles.xml：把 styleId 映射到可读名（Heading1 → heading 1）。 */
export function buildStylesXml(headings) {
	const styles = headings.map((heading) => `<w:style w:type="paragraph" w:styleId="${escapeXml(heading.styleId)}"><w:name w:val="${escapeXml(heading.name)}"/></w:style>`).join("");
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${styles}</w:styles>`;
}

function escapeXml(value) {
	return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
