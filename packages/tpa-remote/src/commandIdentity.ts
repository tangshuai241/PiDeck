/** Include every executable field; connection challenge/time must not change retry identity. */
export function commandIdentity(method: string, fields: Record<string, unknown>): string {
	const identity = [method, fields.sessionId ?? null, fields.text ?? null, fields.target ?? null, fields.questionId ?? null, fields.answer ?? null, fields.projectId ?? null, fields.title ?? null, fields.task ?? null];
	// Keep pre-upgrade outstanding receipts valid when no new executable field is present.
	if (fields.model !== undefined || fields.entryId !== undefined) identity.push(fields.model ?? null, fields.entryId ?? null);
	return JSON.stringify(identity);
}
