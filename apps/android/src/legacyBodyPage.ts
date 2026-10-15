export type BodyPageState = { thinking: boolean; quote: string; lineStart: boolean; pending: string };
export const initialBodyPageState = (): BodyPageState => ({ thinking: false, quote: "", lineStart: true, pending: "" });

/** Older hosts paginate embedded reasoning. Carry only parser state, never whole history. */
export function legacyBodyPage(chunk: string, previous: BodyPageState, final: boolean): { text: string; state: BodyPageState } {
	const state = { ...previous, pending: "" };
	const input = previous.pending + chunk;
	let text = "";
	for (let i = 0; i < input.length; ) {
		const rest = input.slice(i);
		const tag = state.thinking ? "</thinking>" : "<thinking>";
		const canTag = state.thinking || (!state.quote && state.lineStart);
		if (canTag && !final && tag.startsWith(rest)) {
			state.pending = rest;
			break;
		}
		if (canTag && rest.startsWith(tag)) {
			state.thinking = !state.thinking;
			i += tag.length;
			continue;
		}
		if (state.thinking) {
			i++;
			continue;
		}
		const char = input[i];
		if (char === "`" || (char === "~" && (state.lineStart || state.quote.startsWith("~")))) {
			let end = i + 1;
			while (input[end] === char) end++;
			const run = input.slice(i, end);
			if (!final && end === input.length && run.length < 100) {
				state.pending = run;
				break;
			}
			if (state.quote === run) state.quote = "";
			else if (!state.quote && (char === "`" || run.length >= 3)) state.quote = run;
			text += run;
			state.lineStart = false;
			i = end;
			continue;
		}
		text += char;
		state.lineStart = char === "\n" || (state.lineStart && (char === " " || char === "\t"));
		i++;
	}
	return { text, state };
}
