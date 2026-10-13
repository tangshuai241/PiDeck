/**
 * 写接口的事务：去重台账 + 按 work 串行 + 副作用不重复。
 *
 * 三条硬性语义（评审结论）：
 * 1. **先去重再校验**：同 requestId 同载荷直接返回原回执（成功、失败、unknown 都算），
 *    不能因为「revision 已经推进」就用 CAS 拒绝替代幂等；
 * 2. **同 requestId 异载荷显式冲突**，不按后来的载荷执行；
 * 3. **锁覆盖整个事务**：读取→验证→操作/active 写入→回执在同一个 work 锁内完成，
 *    否则并发两个 start 会各自写出一份 operation，留下幽灵 dispatching。
 *
 * 锁顺序（不可颠倒，避免环）：
 * `runtime:<sessionId>`（最外层，由租约注册表在 start 期间持有）
 * → `tx:<workId>` / `tx:<sessionId>`（本类的事务锁）
 * → store 内部的 `work:<workId>` / `session-index:*`（最内层，生命周期最短）。
 */
import { isRecord, workFailure, workSuccess, type WorkResult } from "../../shared/documentWork";
import { parseWorkError } from "../../shared/documentWorkRecords";
import type { DocumentWorkStore } from "./DocumentWorkStore";
import { failureOfDetail, safeDetail } from "./documentWorkReceipts";

function receiptOf<T>(result: WorkResult<T>): unknown {
	return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
}

export type TransactionInput<T> = {
	/** 事务锁的键空间：同一件工作的所有写操作互斥。 */
	lockKey: string;
	requestId: string;
	requestDigest: string;
	/**
	 * 命中台账时把存下来的值变成当前结果。允许异步，因为有些回执只存标识
	 * （例如「建立工作」只存 workId），需要按当前状态重新取一份快照。
	 * 返回 undefined 表示台账内容不可用，调用方按不可重放处理。
	 */
	decodeValue: (value: unknown) => Promise<T | undefined> | T | undefined;
	action: () => Promise<WorkResult<T>>;
};

/** 失败回执：与具体结果类型无关，因此可以直接当 `WorkResult<T>` 返回。 */
function decodeFailedReceipt(payload: unknown): WorkResult<never> | undefined {
	if (!isRecord(payload) || payload.ok !== false) return undefined;
	const error = parseWorkError(payload.error);
	return error ? { ok: false, error } : undefined;
}

function decodeSuccessPayload(payload: unknown): { found: true; value: unknown } | { found: false } {
	if (!isRecord(payload)) return { found: false };
	// 新格式：{ ok: true, value }；旧格式：直接存成功值。
	return payload.ok === true ? { found: true, value: payload.value } : { found: true, value: payload };
}

export class DocumentWorkTransaction {
	constructor(private readonly store: DocumentWorkStore) {}

	/** 只关心结果时用它；需要区分「本次真的执行了」用 `runWithOutcome`。 */
	async run<T>(input: TransactionInput<T>): Promise<WorkResult<T>> {
		return (await this.runWithOutcome(input)).result;
	}

	/**
	 * 执行一次可重放的写事务。成功与失败都会落台账，因此重放不会重新执行副作用。
	 * `executed` 为 false 表示命中台账（重放）：调用方不得再做任何带副作用的后续动作。
	 */
	async runWithOutcome<T>(input: TransactionInput<T>): Promise<{ result: WorkResult<T>; executed: boolean }> {
		return this.store.runExclusive(input.lockKey, async () => {
			// 去重先于一切校验：CAS 冲突不能替代幂等。
			const ledger = await this.store.readIdempotent(input.requestId, input.requestDigest);
			if (ledger.kind === "conflict") return { result: workFailure<T>("IDEMPOTENCY_CONFLICT"), executed: false };
			if (ledger.kind === "hit") {
				const failed = decodeFailedReceipt(ledger.payload);
				if (failed) return { result: failed, executed: false };
				const stored = decodeSuccessPayload(ledger.payload);
				if (!stored.found) return { result: workFailure<T>("IO_ERROR", "receipt_unreadable"), executed: false };
				const value = await input.decodeValue(stored.value);
				return { result: value === undefined ? workFailure<T>("IO_ERROR", "receipt_unreadable") : workSuccess(value), executed: false };
			}
			let result: WorkResult<T>;
			try {
				result = await input.action();
			} catch (error) {
				// 动作抛错也要留下可重放的回执，否则重放会再执行一次副作用。
				const detail = error instanceof Error ? error.name : "unknown";
				result = failureOfDetail<T>("IO_ERROR", safeDetail(detail));
			}
			const stored = await this.store.writeIdempotent(input.requestId, input.requestDigest, receiptOf(result));
			if (!stored) return { result: workFailure<T>("IO_ERROR", "receipt_write_failed"), executed: true };
			return { result, executed: true };
		});
	}

	/**
	 * 用最终结果补齐回执（例如分发之后的失败/unknown）。
	 * 只在载荷指纹一致时覆盖；指纹不一致说明是同 requestId 的另一份载荷，必须留给冲突判定。
	 */
	async finalizeReceipt<T>(requestId: string, requestDigest: string, result: WorkResult<T>): Promise<void> {
		const ledger = await this.store.readIdempotent(requestId, requestDigest);
		if (ledger.kind === "conflict") return;
		await this.store.writeIdempotent(requestId, requestDigest, receiptOf(result));
	}
}
