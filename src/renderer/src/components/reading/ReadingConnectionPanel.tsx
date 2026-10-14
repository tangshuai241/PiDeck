/**
 * 连接面板：服务地址 + 密码 + 是否记住密码。
 *
 * 两条硬规则：
 * - 密码只经 `desktopApi.reading.connect` 交给主进程安全存储，界面不落盘、不问用户把密码发到聊天里；
 * - 401（needsConnection）是正常路径：就地输入再连，不是错误弹窗，也不清空用户已选的书。
 */
import { useState } from "react";
import { KeyRound, LockKeyhole, PlugZap, Unplug } from "lucide-react";
import { t } from "../../i18n";
import { READING_DEFAULT_BASE_URL, type ReadingConnectionView } from "../../../../shared/types/reading";
import { Button } from "../ui-shadcn/button";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Input } from "../ui-shadcn/input";

export function ReadingConnectionPanel(props: { connection: ReadingConnectionView | null; secureStorageAvailable: boolean; busy: boolean; onConnect: (input: { baseUrl: string; password: string; rememberPassword: boolean }) => void; onDisconnect: () => void }) {
	const [baseUrl, setBaseUrl] = useState(props.connection?.baseUrl ?? READING_DEFAULT_BASE_URL);
	const [password, setPassword] = useState("");
	const [rememberPassword, setRememberPassword] = useState(props.connection?.rememberPassword ?? false);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<label className="text-micro text-muted-foreground" htmlFor="reading-base-url">
					{t("reading.connectionBaseUrl")}
				</label>
				<Input id="reading-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={props.busy} spellCheck={false} />
			</div>
			<div className="flex flex-col gap-1">
				<label className="text-micro text-muted-foreground" htmlFor="reading-password">
					{t("reading.connectionPassword")}
				</label>
				<Input id="reading-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={props.busy} autoComplete="off" />
			</div>
			<label className="flex items-center gap-2 text-caption text-foreground">
				<Checkbox checked={rememberPassword} onCheckedChange={(checked) => setRememberPassword(checked === true)} disabled={props.busy || !props.secureStorageAvailable} />
				<span>{t("reading.connectionRemember")}</span>
			</label>
			<p className="text-micro leading-4 text-muted-foreground">{t("reading.connectionHint")}</p>
			{!props.secureStorageAvailable && <p className="text-micro leading-4 text-danger">{t("reading.connectionSecureUnavailable")}</p>}
			{props.connection?.credentialStored && (
				<p className="flex items-center gap-1.5 text-micro text-muted-foreground">
					<LockKeyhole className="size-3 shrink-0" aria-hidden="true" />
					{t("reading.connectionStored")}
				</p>
			)}
			<div className="flex items-center gap-2">
				<Button size="sm" disabled={props.busy} onClick={() => props.onConnect({ baseUrl: baseUrl.trim(), password, rememberPassword })}>
					<PlugZap className="size-3.5" aria-hidden="true" />
					{t("reading.connectionSubmit")}
				</Button>
				<Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onDisconnect}>
					<Unplug className="size-3.5" aria-hidden="true" />
					{t("reading.connectionDisconnect")}
				</Button>
			</div>
			{props.connection?.authRequired === true && (
				<p className="flex items-center gap-1.5 text-micro text-muted-foreground">
					<KeyRound className="size-3 shrink-0" aria-hidden="true" />
					{t("reading.connectionAuthRequired")}
				</p>
			)}
		</div>
	);
}
