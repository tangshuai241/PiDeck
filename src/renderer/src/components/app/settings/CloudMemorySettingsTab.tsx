/**
 * 设置 → 云端记忆（N04）：连接、明确开关、已确认人格版本与离线状态、同步状态占位。
 *
 * 边界：
 * - 不提供人格编辑器/发布入口：发布走现有云端用户确认入口，本页只读已发布版本；
 * - 密码只在提交时经 IPC 交给主进程（safeStorage 加密落盘），渲染层不留存、不回填；
 * - 同步状态只显示事实占位：未收到 Pi 运行时的原生 RPC 状态时不显示成「队列已清空」；
 * - 开关只按用户操作，改动提示「新会话或重启运行时后生效」，不自动终止会话。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Switch } from "../../ui-shadcn/switch";
import { t, type TranslationKey } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { useCloudMemory } from "../../../hooks/settings/useCloudMemory";
import type { CloudMemoryErrorCode, CloudMemoryErrorInfo } from "../../../../../shared/types/cloudMemory";
import { SettingRow } from "./SettingRows";
import { SettingsSection } from "./SettingsStorageTab";

const ERROR_KEYS: Record<CloudMemoryErrorCode, string> = {
	invalidInput: "settings.cloudMemory.errors.invalidInput",
	invalidBaseUrl: "settings.cloudMemory.errors.invalidBaseUrl",
	secureStorageUnavailable: "settings.cloudMemory.errors.secureStorageUnavailable",
	unauthorized: "settings.cloudMemory.errors.unauthorized",
	scopeMissing: "settings.cloudMemory.errors.scopeMissing",
	principalMismatch: "settings.cloudMemory.errors.principalMismatch",
	offline: "settings.cloudMemory.errors.offline",
	notConfigured: "settings.cloudMemory.errors.notConfigured",
	featureDisabled: "settings.cloudMemory.errors.featureDisabled",
	personaUnverified: "settings.cloudMemory.errors.personaUnverified",
	internalError: "settings.cloudMemory.errors.internalError",
};

/** 未知/未来错误码的统一兜底文案键（不把主进程的 message 当界面文案）。 */
const UNKNOWN_ERROR_KEY = "settings.cloudMemory.errors.unknown";

/** sender 相位 → 词典键（固定枚举；未知值走 unknownState，不直接显示原始码）。 */
const SYNC_STATE_KEYS: Record<string, TranslationKey> = {
	idle: "settings.cloudMemory.sync.state.idle",
	sending: "settings.cloudMemory.sync.state.sending",
	retrying: "settings.cloudMemory.sync.state.retrying",
	disabled: "settings.cloudMemory.sync.state.disabled",
	auth_blocked: "settings.cloudMemory.sync.state.authBlocked",
	scope_mismatch: "settings.cloudMemory.sync.state.scopeMismatch",
	owner_blocked: "settings.cloudMemory.sync.state.ownerBlocked",
	oversized: "settings.cloudMemory.sync.state.oversized",
	stopped: "settings.cloudMemory.sync.state.stopped",
};

/** 相位展示优先级：受阻类 > 暂停/重试 > 正常态（同一时刻只展示最需要用户关注的一条）。 */
const SYNC_STATE_PRIORITY = ["auth_blocked", "scope_mismatch", "owner_blocked", "oversized", "disabled", "retrying", "sending", "stopped", "idle"] as const;

function describeSyncStates(states: readonly string[]): string {
	for (const state of SYNC_STATE_PRIORITY) {
		if (states.includes(state)) return t(SYNC_STATE_KEYS[state]);
	}
	return states.length > 0 ? t("settings.cloudMemory.sync.state.unknownState") : t("settings.cloudMemory.sync.unknown");
}

/**
 * 错误码 → 词典键。主进程的 message 是内部短语（也可能是英文环境下的中文），
 * 界面只按 code 取当前语言文案；码表里没有的码走 unknown，不回显 message。
 */
function describeError(error: CloudMemoryErrorInfo): string {
	const key = ERROR_KEYS[error.code] ?? UNKNOWN_ERROR_KEY;
	return t(key as TranslationKey);
}

export function CloudMemorySettingsTab() {
	const cloudMemory = useCloudMemory();
	const status = cloudMemory.status;
	const [baseUrl, setBaseUrl] = useState("");
	const [account, setAccount] = useState("");
	const [password, setPassword] = useState("");
	const [rememberSignIn, setRememberSignIn] = useState(true);
	const [showPersonaText, setShowPersonaText] = useState(false);
	const hydratedRef = useRef(false);

	// 首帧用后端状态填充表单（地址/账号/记住登录）；之后不再覆盖用户输入。
	useEffect(() => {
		if (hydratedRef.current || !status) return;
		hydratedRef.current = true;
		setBaseUrl(status.baseUrl);
		setAccount(status.account ?? "");
		setRememberSignIn(status.rememberSignIn);
	}, [status]);

	const submit = useCallback(async () => {
		// syncMode 已从界面移除（个人与项目可见对话都会归档），保留持久化字段并固定用 personal 召回模式
		const result = await cloudMemory.connect({ baseUrl: baseUrl.trim(), account: account.trim(), password, syncMode: "personal", rememberSignIn });
		if (result.ok) {
			setPassword("");
			showNotice(t("settings.cloudMemory.connectSuccess"), 5000);
		}
	}, [account, baseUrl, cloudMemory, password, rememberSignIn]);

	const canSubmit = baseUrl.trim().length > 0 && account.trim().length > 0 && password.length > 0 && cloudMemory.busy === null;
	const persona = status?.persona ?? null;
	const native = status?.native ?? null;
	const stateKey = `settings.cloudMemory.state.${status?.state ?? "notConfigured"}`;

	return (
		<div className="flex flex-col">
			{(cloudMemory.error ?? status?.lastError) && <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-caption text-foreground">{describeError(cloudMemory.error ?? status?.lastError ?? { code: "internalError", message: "" })}</div>}

			<SettingsSection title={t("settings.cloudMemory.connection.title")} description={t("settings.cloudMemory.connection.description")}>
				<SettingRow title={t("settings.cloudMemory.baseUrl")} description={t("settings.cloudMemory.baseUrlHint")} stacked>
					<Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://workbench.example.com" autoComplete="off" spellCheck={false} />
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.account")} stacked>
					<Input value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="username" spellCheck={false} />
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.password")} description={t("settings.cloudMemory.passwordHint")} stacked>
					<Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" spellCheck={false} />
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.remember")} description={t("settings.cloudMemory.rememberHint")}>
					<Switch checked={rememberSignIn} onCheckedChange={setRememberSignIn} aria-label={t("settings.cloudMemory.remember")} />
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.scope.archive")} description={t("settings.cloudMemory.scope.archiveHint")}>
					<></>
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.scope.wsl")} description={t("settings.cloudMemory.scope.wslHint")}>
					<></>
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.actions")} description={t("settings.cloudMemory.actionsHint")}>
					<div className="flex items-center gap-2">
						<Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
							{cloudMemory.busy === "connect" ? t("settings.cloudMemory.connecting") : status?.credentialStored ? t("settings.cloudMemory.reconnect") : t("settings.cloudMemory.connect")}
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={cloudMemory.busy !== null || !status?.credentialStored}
							onClick={() => {
								// 登出后立刻清掉输入框里的密码：不在 DOM 里留一个已经失效的秘密
								void cloudMemory.logout().then((result) => {
									if (result.ok) setPassword("");
								});
							}}
						>
							{cloudMemory.busy === "logout" ? t("settings.cloudMemory.loggingOut") : t("settings.cloudMemory.logout")}
						</Button>
					</div>
				</SettingRow>
			</SettingsSection>

			<SettingsSection title={t("settings.cloudMemory.switch.title")} description={t("settings.cloudMemory.switch.description")}>
				<SettingRow title={t("settings.cloudMemory.switch.enable")} description={t("settings.cloudMemory.switch.enableHint")}>
					<Switch checked={status?.enabled === true} onCheckedChange={(checked) => void cloudMemory.setEnabled(checked)} aria-label={t("settings.cloudMemory.switch.enable")} />
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.switch.syncScope")} description={t("settings.cloudMemory.switch.syncScopeHint")}>
					<Switch checked={status?.syncEnabled === true} onCheckedChange={(checked) => void cloudMemory.setSyncEnabled(checked)} aria-label={t("settings.cloudMemory.switch.syncScope")} />
				</SettingRow>
				{status?.restartRequired && (
					<SettingRow title={t("settings.cloudMemory.switch.restartRequired")} description={t("settings.cloudMemory.switch.restartRequiredHint")}>
						<></>
					</SettingRow>
				)}
			</SettingsSection>

			<SettingsSection title={t("settings.cloudMemory.persona.title")} description={t("settings.cloudMemory.persona.description")}>
				<SettingRow title={t("settings.cloudMemory.status")} description={t("settings.cloudMemory.statusHint")}>
					<span className="text-control">{t(stateKey as TranslationKey)}</span>
				</SettingRow>
				{persona ? (
					<>
						<SettingRow title={t("settings.cloudMemory.persona.revision")}>
							<span className="font-mono text-caption">{persona.revision.slice(0, 12)}</span>
						</SettingRow>
						<SettingRow title={t("settings.cloudMemory.persona.rawRevision")}>
							<span className="font-mono text-caption">{persona.rawRevision.slice(0, 12)}</span>
						</SettingRow>
						<SettingRow title={t("settings.cloudMemory.persona.updatedAt")}>{persona.updatedAt ? <span className="text-caption">{persona.updatedAt}</span> : <span className="text-caption text-muted-foreground">{t("settings.cloudMemory.persona.unknownTime")}</span>}</SettingRow>
						<SettingRow title={t("settings.cloudMemory.persona.fetchedAt")} description={persona.stale ? t("settings.cloudMemory.persona.staleHint") : undefined}>
							<span className="text-caption">
								{persona.fetchedAt}
								{persona.stale ? ` · ${t("settings.cloudMemory.persona.stale")}` : ""}
							</span>
						</SettingRow>
						<SettingRow title={t("settings.cloudMemory.persona.injection")}>
							<span className="text-caption">{persona.enabled ? t("settings.cloudMemory.persona.injectionOn") : t("settings.cloudMemory.persona.injectionOff")}</span>
						</SettingRow>
						<SettingRow stacked title={t("settings.cloudMemory.persona.text")} description={t("settings.cloudMemory.persona.textHint")}>
							<Button size="sm" variant="outline" onClick={() => setShowPersonaText((value) => !value)}>
								{showPersonaText ? t("settings.cloudMemory.persona.hideText") : t("settings.cloudMemory.persona.showText")}
							</Button>
							{showPersonaText && <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle/70 bg-bg-muted/30 p-2 text-caption">{persona.text || t("settings.cloudMemory.persona.emptyText")}</pre>}
						</SettingRow>
					</>
				) : (
					<SettingRow title={t("settings.cloudMemory.persona.none")} description={t("settings.cloudMemory.persona.noneHint")}>
						<></>
					</SettingRow>
				)}
				<SettingRow title={t("settings.cloudMemory.persona.refresh")} description={t("settings.cloudMemory.persona.refreshHint")}>
					<Button size="sm" variant="outline" disabled={cloudMemory.busy !== null || status?.enabled !== true} onClick={() => void cloudMemory.refreshPersona()}>
						{cloudMemory.busy === "refresh" ? t("settings.cloudMemory.persona.refreshing") : t("settings.cloudMemory.persona.refreshNow")}
					</Button>
				</SettingRow>
			</SettingsSection>

			<SettingsSection title={t("settings.cloudMemory.sync.title")} description={t("settings.cloudMemory.sync.description")}>
				<SettingRow title={t("settings.cloudMemory.sync.queue")} description={t("settings.cloudMemory.sync.queueHint")}>
					<span className="text-caption text-muted-foreground">{native === null || native.pendingCount === null ? t("settings.cloudMemory.sync.unknown") : t("settings.cloudMemory.sync.pending", { count: native.pendingCount })}</span>
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.sync.lastReceipt")} description={t("settings.cloudMemory.sync.lastReceiptHint")}>
					<span className="text-caption">{native?.lastReceiptAt ?? t("settings.cloudMemory.sync.unknown")}</span>
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.sync.counts")} description={t("settings.cloudMemory.sync.countsHint")}>
					<span className="text-caption">{native === null || (native.registered === null && native.failed === null) ? t("settings.cloudMemory.sync.unknown") : t("settings.cloudMemory.sync.countsValue", { registered: native.registered ?? 0, failed: native.failed ?? 0, sessions: native.sessions })}</span>
				</SettingRow>
				{native?.needsNewSession && (
					<SettingRow title={t("settings.cloudMemory.sync.needsNewSession")} description={t("settings.cloudMemory.sync.needsNewSessionHint")}>
						<></>
					</SettingRow>
				)}
				<SettingRow title={t("settings.cloudMemory.sync.phase")} description={t("settings.cloudMemory.sync.phaseHint")}>
					<span className="text-caption">{describeSyncStates(native?.syncStates ?? [])}</span>
				</SettingRow>
				{native?.lineagePartial && (
					<SettingRow title={t("settings.cloudMemory.sync.lineagePartial")} description={t("settings.cloudMemory.sync.lineagePartialHint")}>
						<></>
					</SettingRow>
				)}
				{native === null && (
					<SettingRow title={t("settings.cloudMemory.sync.none")} description={t("settings.cloudMemory.sync.noneHint")}>
						<></>
					</SettingRow>
				)}
			</SettingsSection>

			<SettingsSection title={t("settings.cloudMemory.security.title")} description={t("settings.cloudMemory.security.description")}>
				<SettingRow title={t("settings.cloudMemory.security.secureStorage")}>
					<span className="text-caption">{status?.secureStorageAvailable ? t("settings.cloudMemory.security.secureStorageAvailable") : t("settings.cloudMemory.security.secureStorageUnavailable")}</span>
				</SettingRow>
				<SettingRow title={t("settings.cloudMemory.security.credential")}>
					<span className="text-caption">{status?.credentialStored ? t("settings.cloudMemory.security.credentialStored") : t("settings.cloudMemory.security.credentialAbsent")}</span>
				</SettingRow>
				<SettingRow stacked title={t("settings.cloudMemory.security.paths")} description={t("settings.cloudMemory.security.pathsHint")}>
					<ul className="flex flex-col gap-0.5 font-mono text-caption text-muted-foreground">
						<li>{status?.paths.configFile ?? "-"}</li>
						<li>{status?.paths.authFile ?? "-"}</li>
						<li>{status?.paths.personaCacheFile ?? "-"}</li>
					</ul>
				</SettingRow>
			</SettingsSection>
		</div>
	);
}
