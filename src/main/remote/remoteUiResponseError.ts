/**
 * 手机回答问答请求被协调器拒绝时的稳定错误码。
 *
 * 只有「确定没送达」的拒绝才转成确定错误（问题已处理 / 运行时已变化）；
 * 其他异常保持 undefined，由调用方按原有「送达未知」机制处理。
 *
 * 用稳定 code 判断而不是 instanceof：远程层不加载会话协调器实现，
 * 错误码是跨层契约（SessionRuntimeCommandError.code）。
 */
import { isRecord } from "../../../packages/tpa-remote/src/crypto";

export function remoteUiResponseError(error: unknown): "RUNTIME_CHANGED" | "QUESTION_CLOSED" | undefined {
	if (!isRecord(error) || typeof error.code !== "string") return undefined;
	if (error.code === "SESSION_RUNTIME_CHANGED") return "RUNTIME_CHANGED";
	if (error.code === "SESSION_COMMAND_FAILED") return "QUESTION_CLOSED";
	return undefined;
}
