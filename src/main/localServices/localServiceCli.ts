import { execFile, spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

/** 一次性命令结果：只回 stdout 或稳定原因码，stderr 原文（可能含令牌）不上抛。 */
export type LocalServiceCommandResult = { ok: true; stdout: string } | { ok: false; reason: string };

/** 长驻命令只回「起没起来」：不等退出，所以没有 stdout。 */
export type LocalServiceSpawnResult = { ok: true } | { ok: false; reason: string };

export type LocalServiceCli = {
	/** 一次性命令：读 stdout，带超时（超时即失败，不留悬挂子进程）。 */
	run(args: string[], timeoutMs: number): Promise<LocalServiceCommandResult>;
	/** 长驻命令：立刻返回、不等待退出（服务自己接管进程）。 */
	spawnDetached(args: string[]): LocalServiceSpawnResult;
};

/** 命令名/参数只允许安全字符：两者都来自主进程适配器常量，这里兜住「以后有人把外部输入接进来」。 */
const COMMAND_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_=./:@+-]{1,160}$/;

/**
 * Windows 上 npm 全局命令是 `.cmd` 垫片，Node 24 直接 spawn 会 EINVAL，
 * 必须经 `cmd.exe /d /s /c` 走（同 src/main/ipc/systemIpc.ts 的探测形态）。
 * 整行作为一个 verbatim 参数传入，不做字符串插值拼 shell。
 */
export function localServiceInvocation(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
	if (!COMMAND_PATTERN.test(command)) throw new Error("invalid-service-command");
	for (const arg of args) if (!ARGUMENT_PATTERN.test(arg)) throw new Error("invalid-service-argument");
	if (process.platform !== "win32") return { command, args, windowsVerbatimArguments: false };
	return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", [command, ...args].join(" ")], windowsVerbatimArguments: true };
}

export function createLocalServiceCli(options: { command: string; env?: () => NodeJS.ProcessEnv | undefined }): LocalServiceCli {
	return {
		run(args, timeoutMs) {
			let invocation: ReturnType<typeof localServiceInvocation>;
			try {
				invocation = localServiceInvocation(options.command, args);
			} catch {
				return Promise.resolve({ ok: false, reason: "cli-failed" });
			}
			return new Promise((resolve) => {
				execFile(invocation.command, invocation.args, { env: options.env?.(), timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
					if (error) {
						resolve({ ok: false, reason: "cli-failed" });
						return;
					}
					resolve({ ok: true, stdout: String(stdout ?? "") });
				});
			});
		},
		spawnDetached(args) {
			let invocation: ReturnType<typeof localServiceInvocation>;
			try {
				invocation = localServiceInvocation(options.command, args);
			} catch {
				return { ok: false, reason: "start-failed" };
			}
			try {
				const child = spawn(invocation.command, invocation.args, { env: options.env?.(), detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
				// 未处理的 error 事件会直接崩主进程；spawn 失败在回调里同步返回不可靠，这里兜住。
				child.on("error", () => undefined);
				child.unref();
				return { ok: true };
			} catch {
				return { ok: false, reason: "start-failed" };
			}
		},
	};
}

/**
 * 终止一个 pid 的命令形态（纯函数，便于断言；参数永远是数组，不经 shell 拼接）。
 * taskkill 是 System32 里的真 exe（不是 .cmd 垫片），所以不需要经 cmd.exe。
 * 非法 pid 返回 null：pid 只来自适配器自己的报告，这里再兜一道，避免误杀。
 */
export function killLocalServiceInvocation(pid: number, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } | null {
	if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return null;
	return platform === "win32" ? { command: "taskkill", args: ["/pid", String(pid), "/t", "/f"] } : { command: "kill", args: ["-TERM", String(pid)] };
}

/**
 * 停止服务：外部 CLI 没有 stop 子命令，只能按 pid 终止。
 * Windows 用 `taskkill /t /f` 连子进程一起收（bili 是 node 进程）；pid 只来自适配器自己的报告，
 * 不做任何猜测，避免误杀。返回值只表示「终止动作是否成功」，真实状态一律再查一次。
 */
export function killLocalServiceProcess(pid: number, options: { platform?: NodeJS.Platform; timeoutMs?: number } = {}): Promise<boolean> {
	const invocation = killLocalServiceInvocation(pid, options.platform ?? process.platform);
	if (!invocation) return Promise.resolve(false);
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(ok);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(invocation.command, invocation.args, { windowsHide: true, stdio: "ignore" });
		} catch {
			finish(false);
			return;
		}
		timer = setTimeout(() => {
			child.kill();
			finish(false);
		}, options.timeoutMs ?? 10_000);
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}
