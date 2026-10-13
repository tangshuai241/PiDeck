/**
 * 用户轮指纹与准备摘要：授权与幂等都依赖这两把稳定哈希。
 *
 * 放在独立文件的原因：主进程、扩展镜像与测试都要引用同一份归一化规则；
 * 内联在编排服务里会让「谁改了指纹算法」难以定位。
 */
import { stableStringify } from "../../shared/documentWork";
import type { DocumentWorkPreparation } from "../../shared/types/documentWork";
import { hashText } from "./documentWorkPaths";

/** 用户轮的正文指纹：CRLF 归一 + 首尾去空白，两侧（主进程/渲染层/扩展）必须逐字节一致。 */
export function hashTurnText(text: string): string {
	return hashText(text.replace(/\r\n?/g, "\n").trim());
}

/** 准备记录指纹不含自身 digest 字段，字段顺序不影响结果。 */
export function preparationDigestOf(preparation: DocumentWorkPreparation): string {
	return hashText(stableStringify({ ...preparation, digest: undefined }));
}
