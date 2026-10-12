/**
 * 按 key 串行化的异步互斥。
 *
 * 文稿的准备与分发要跨多个 await（读运行时、冻结基稿、落盘、发 RPC），而存储层的
 * revision CAS 只在单次同步读改写内有效。没有这把锁时，同一工作的两次并发
 * prepare/start 会双双通过 activeOperationId 检查，出现两条操作记录或两次 approve。
 *
 * 实现要点：同一个 key 的调用按提交顺序串行；不同 key 互不影响；等待者出错不
 * 影响其它等待者；任务结束后立即释放队列，不留常驻结构（长会话不会泄漏）。
 */
export class KeyedMutex {
	private readonly chains = new Map<string, Promise<unknown>>();

	/** 在 key 的串行队列里执行 `task`；返回 task 自己的结果或异常。 */
	async run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(key) ?? Promise.resolve();
		// 排队本身不允许失败传播：前一个任务抛错时后续任务仍要执行。
		const queued = previous.then(
			() => undefined,
			() => undefined,
		);
		const current = queued.then(task);
		const guard = current.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(key, guard);
		try {
			return await current;
		} finally {
			// 队列尾还是自己时清掉条目，避免 Map 随会话数无界增长。
			if (this.chains.get(key) === guard) this.chains.delete(key);
		}
	}

	/** 正在排队/执行的 key 数（诊断与测试用）。 */
	pendingKeys(): string[] {
		return [...this.chains.keys()];
	}
}
