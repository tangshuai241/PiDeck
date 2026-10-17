/**
 * CuaService — main-process assembly for the CUA capability (Plan A / T7).
 *
 * Responsibilities:
 *   - Own the singleton CuaGate + CuaEngine.
 *   - Start the in-process MCP Streamable HTTP host (CuaMcpHttpHost) on
 *     127.0.0.1 with a random bearer token.
 *   - Wire the gate's approval handler to the renderer dialog via CuaIpcManager.
 *   - Register/unregister the `pideck-cua` MCP entry in ~/.pi/agent/mcp.json.
 *
 * Lifecycle is driven by the `cuaEnabled` setting: the host only listens (and
 * the pi MCP entry only exists) while CUA is enabled. This keeps the default
 * posture "off": no listener, no pi config mutation.
 *
 * Everything Electron-specific lives in CuaIpcManager, so this module is a thin
 * orchestrator that the main index can register with quitCleanup.
 */

import { randomBytes } from "node:crypto";
import { desktopCapturer, type BrowserWindow } from "electron";
import { CuaEngine } from "./CuaEngine";
import { CuaGate } from "./CuaGate";
import { CuaMcpHttpHost } from "./CuaMcpHttpHost";
import { CuaScreen } from "./CuaScreen";
import { ensureCuaMcpRegistered, unregisterCuaMcp } from "./CuaMcpRegistration";
import { CuaIpcManager, type CuaIpcDeps } from "../ipc/cuaIpc";

export type CuaServiceDeps = {
	/** Current main window (may be null before/after window lifecycle). */
	getMainWindow: () => BrowserWindow | null;
	/** Structured logger. */
	log: (domain: string, message: string, details?: Record<string, unknown>) => void;
	/**
	 * 免审批设置的实时读取（cuaAutoApprove）：每次写操作 check 时解析，
	 * 改设置无需重启/重接线。缺省视为关闭。
	 */
	getAutoApprove?: () => boolean;
	/** 截图落盘（轨迹回看）：返回内容寻址引用；未注入时不落盘。 */
	saveScreenshot?: (base64: string, mimeType: string) => Promise<string | null>;
};

export class CuaService {
	private deps: CuaServiceDeps;
	private gate: CuaGate;
	private engine: CuaEngine;
	private screen: CuaScreen;
	private ipc: CuaIpcManager;
	private host: CuaMcpHttpHost | null = null;
	private running = false;

	constructor(deps: CuaServiceDeps) {
		this.deps = deps;
		// Gate starts CLOSED and only opens while the MCP host is actually
		// listening (start()) — previously it was hard-coded on at construction,
		// so cua:get-state reported enabled=true even when cuaEnabled=false and
		// no endpoint existed (state misreport).
		this.gate = new CuaGate({
			enabled: false,
			autoApprove: () => this.deps.getAutoApprove?.() ?? false,
		});
		this.engine = new CuaEngine({ defaultDelayMs: 80 }, this.gate);
		this.screen = new CuaScreen({
			saveScreenshot: deps.saveScreenshot,
			// 旧 source id → Electron 显示 id（只在小尺寸缩略图请求上做一次映射，不参与截图）。
			resolveDisplayIdFromSource: async (sourceId) => {
				try {
					if (!String(sourceId).startsWith("screen:")) return undefined;
					const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
					const matched = sources.find((source) => String(source.id) === String(sourceId));
					return matched ? String(matched.display_id) : undefined;
				} catch {
					return undefined;
				}
			},
		});

		const ipcDeps: CuaIpcDeps = {
			gate: this.gate,
			mainWindow: deps.getMainWindow,
			log: deps.log,
		};
		this.ipc = new CuaIpcManager(ipcDeps);
		this.ipc.register();

		// Route approvals straight to the renderer dialog (in-process, no HTTP hop).
		this.gate.setApprovalHandler(this.ipc.createApprovalHandler());
	}

	isRunning(): boolean {
		return this.running;
	}

	/** Start the HTTP host and register with pi. Idempotent. */
	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		const authToken = randomBytes(32).toString("hex");
		this.host = new CuaMcpHttpHost(
			{ port: 0, authToken },
			{
				engine: this.engine,
				gate: this.gate,
				screen: this.screen,
				onLog: (level, message) => this.deps.log("cua", message, { level }),
			},
		);

		try {
			await this.host.start();
			const url = this.host.getUrl();
			if (url) {
				const result = ensureCuaMcpRegistered({ url, bearerToken: authToken });
				this.deps.log("cua", `CUA MCP registered at ${url}`, { written: result.written });
			}
			this.gate.setEnabled(true);
		} catch (error) {
			this.running = false;
			this.gate.setEnabled(false);
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("cua", `CUA service start failed: ${message}`);
			throw error;
		}
	}

	/** Stop the host and unregister from pi. Idempotent. */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		// Close the kill switch first so nothing squeezes through mid-shutdown.
		this.gate.setEnabled(false);

		try {
			unregisterCuaMcp();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.deps.log("cua", `CUA MCP unregister failed: ${message}`);
		}

		const host = this.host;
		this.host = null;
		if (host) {
			try {
				await host.stop();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.deps.log("cua", `CUA HTTP host stop failed: ${message}`);
			}
		}
	}

	/** Full teardown for app quit. */
	async dispose(): Promise<void> {
		await this.stop();
		this.screen.dispose();
		this.ipc.dispose();
	}

	/** 截图/局部查看装配（主进程装配层用来登记图片协议与帧存储）。 */
	getScreen(): CuaScreen {
		return this.screen;
	}
}
