/**
 * 用户轮正文指纹（渲染层版）：必须与主进程 `hashTurnText` 完全一致。
 *
 * 授权绑定的是「用户实际发送的那段文字」，因此归一化规则（CRLF → LF、首尾去空白）
 * 两侧必须逐字节相同；这里用 WebCrypto 计算，不引依赖。
 */
export async function hashUserTurnText(text: string): Promise<string> {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	const bytes = new TextEncoder().encode(normalized);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
