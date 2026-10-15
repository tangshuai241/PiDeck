/** Parse the visible local-time field without silently correcting invalid times. */
export function parseTaskTime(value: string): { hour: number; minute: number } | undefined {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? { hour, minute } : undefined;
}
