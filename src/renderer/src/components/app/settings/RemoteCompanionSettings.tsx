import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Smartphone, ShieldCheck, Copy } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { writeClipboard } from "../../../utils/clipboard";
import type { RemoteCompanionStatus } from "../../../../../shared/types/remoteCompanion";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui-shadcn/dialog";

/** Owns status polling and ephemeral pairing data; nothing is stored in global atoms. */
export function RemoteCompanionSettings() {
	const [status, setStatus] = useState<RemoteCompanionStatus>();
	const [pairing, setPairing] = useState("");
	const [qr, setQr] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [confirm, setConfirm] = useState(false);
	useEffect(() => {
		let disposed = false;
		let reading = false;
		const refresh = async () => {
			if (reading) return;
			reading = true;
			try {
				const result = await desktopApi.remoteCompanion.getStatus();
				if (!disposed && result.ok) {
					setStatus(result.status);
					if (result.status.paired) {
						setPairing("");
						setQr("");
					}
				}
			} catch {
				if (!disposed) setError(true);
			} finally {
				reading = false;
			}
		};
		void refresh();
		const timer = window.setInterval(() => {
			void refresh();
		}, 2000);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}, []);
	useEffect(() => {
		if (!pairing) return;
		const timer = window.setTimeout(() => {
			setPairing("");
			setQr("");
		}, 10 * 60_000);
		return () => window.clearTimeout(timer);
	}, [pairing]);
	async function create() {
		setBusy(true);
		setError(false);
		try {
			const result = await desktopApi.remoteCompanion.createPairing();
			if (!result.ok || !result.pairing) {
				setError(true);
				return;
			}
			const image = await QRCode.toDataURL(result.pairing, { width: 300, margin: 2 });
			setPairing(result.pairing);
			setQr(image);
			setStatus(result.status);
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	}
	async function revoke() {
		setBusy(true);
		setError(false);
		try {
			const result = await desktopApi.remoteCompanion.revoke();
			if (result.ok) {
				setStatus(result.status);
				setPairing("");
				setQr("");
				setConfirm(false);
			} else setError(true);
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	}
	const stateText = !status?.configured ? t("remoteCompanion.notConfigured") : status.paired ? t("remoteCompanion.paired", { name: status.deviceName ?? t("remoteCompanion.phone") }) : status.connected ? t("remoteCompanion.waiting") : t("remoteCompanion.disconnected");
	return (
		<section className="mb-8 rounded-2xl border border-border-subtle bg-settings-surface p-6">
			<div className="flex gap-3">
				<Smartphone className="mt-1 size-5 shrink-0 text-primary" />
				<div>
					<h2 className="text-lg">{t("remoteCompanion.title")}</h2>
					<p className="mt-2 text-sm leading-6 text-text-secondary">{t("remoteCompanion.description")}</p>
					<p className="mt-3 text-sm" role="status">
						{stateText}
					</p>
				</div>
			</div>
			{error && (
				<p className="mt-4 text-sm text-danger" role="alert">
					{t("remoteCompanion.error")}
				</p>
			)}
			<div className="mt-5 flex flex-wrap gap-3">
				<Button
					disabled={busy || !status?.configured || status.paired}
					onClick={() => {
						void create();
					}}
				>
					{t("remoteCompanion.pair")}
				</Button>
				<Button variant="outline" disabled={busy || !status?.configured || (!status.paired && !status.enabled)} onClick={() => setConfirm(true)}>
					{t("remoteCompanion.revoke")}
				</Button>
			</div>
			{qr && (
				<div className="mt-5 flex flex-wrap items-center gap-5">
					<img className="size-60 rounded-xl" src={qr} alt={t("remoteCompanion.qrAlt")} />
					<div className="max-w-sm">
						<p className="text-sm leading-7">{t("remoteCompanion.qrHint")}</p>
						<Button
							variant="outline"
							className="mt-3"
							onClick={() => {
								writeClipboard(pairing);
							}}
						>
							<Copy />
							{t("remoteCompanion.copy")}
						</Button>
					</div>
				</div>
			)}
			<p className="mt-5 flex items-start gap-2 text-xs leading-6 text-text-secondary">
				<ShieldCheck className="mt-1 size-4 shrink-0" />
				{t("remoteCompanion.security")}
			</p>
			<Dialog open={confirm} onOpenChange={setConfirm}>
				<DialogContent>
					<DialogTitle>{t("remoteCompanion.revokeTitle")}</DialogTitle>
					<DialogDescription>{t("remoteCompanion.revokeDescription")}</DialogDescription>
					<div className="flex justify-end gap-3">
						<Button variant="outline" onClick={() => setConfirm(false)}>
							{t("common.cancel")}
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								void revoke();
							}}
						>
							{t("remoteCompanion.revoke")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</section>
	);
}
