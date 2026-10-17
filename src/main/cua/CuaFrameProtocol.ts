/**
 * `pideck-cua-img://frame/<ref>` 协议：把 CUA 截图（轨迹回看）交给渲染层 `<img>` 直接加载。
 *
 * 与生图 `pideck-img://` 同构：引用名是内容寻址的 sha256 + 扩展名，经过
 * ImageBlobStore.resolvePath 的白名单与目录归属校验；内容不变，可长缓存。
 * 单独一个 scheme 是因为目录和清理生命周期不同（见 CuaFrameStore）。
 */

import { protocol } from "electron";
import { readFile, stat } from "node:fs/promises";
import { CUA_FRAME_PROTOCOL, CUA_SCREENSHOT_REF_RE } from "../../shared/types/cua";
import type { CuaFrameStore } from "./CuaFrameStore";

/** 读取字节上界：与截图落盘的单张上限一致（原生 JPEG 数百 KB，留足余量）。 */
const CUA_FRAME_MAX_BYTES = 32 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	avif: "image/avif",
};

function mimeFor(ref: string): string {
	const ext = ref.slice(ref.lastIndexOf(".") + 1).toLowerCase();
	return MIME_BY_EXT[ext] ?? "image/jpeg";
}

function parseRef(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "frame") return null;
		const ref = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
		return CUA_SCREENSHOT_REF_RE.test(ref) ? ref : null;
	} catch {
		return null;
	}
}

export function registerCuaFrameProtocol(store: CuaFrameStore): void {
	protocol.handle(CUA_FRAME_PROTOCOL, async (request) => {
		const ref = parseRef(request.url);
		if (!ref) return new Response("forbidden", { status: 403 });
		const file = store.resolvePath(ref);
		if (!file) return new Response("forbidden", { status: 403 });
		try {
			const info = await stat(file);
			if (info.size > CUA_FRAME_MAX_BYTES) return new Response("payload too large", { status: 413 });
			const data = await readFile(file);
			return new Response(data, {
				headers: {
					"Content-Type": mimeFor(ref),
					"Cache-Control": "public, max-age=31536000, immutable",
				},
			});
		} catch {
			return new Response("not found", { status: 404 });
		}
	});
}
