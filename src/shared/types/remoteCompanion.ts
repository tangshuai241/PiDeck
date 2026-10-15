/** Renderer receives connection status, never host routing or device private keys. */
export type RemoteCompanionStatus = { configured: boolean; enabled: boolean; connected: boolean; paired: boolean; deviceName?: string; error?: string };
export type RemoteCompanionResult = { ok: true; status: RemoteCompanionStatus; pairing?: string } | { ok: false; error: string };
