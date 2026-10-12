/**
 * 指令指纹：与生产同一算法（`node:crypto` 的 sha256 十六进制小写）。
 * 单独放一个 helper，避免测试各自实现导致"指纹算法漂移也照样绿"。
 */
import { createHash } from "node:crypto";

export function instructionDigest(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
