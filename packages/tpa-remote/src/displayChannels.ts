/** Separate only known reasoning wrappers; quoted examples and user/tool text stay intact. */
export function displayChannels(message: { role: string; text: string; thinking?: string; textTruncated?: boolean }): { text: string; thinking: string } {
	const thinking = message.thinking ?? "";
	if (message.role !== "assistant" || !thinking) return { text: message.text, thinking };
	let text = message.text;
	// A thought can itself discuss closing tags. Match its full known value first.
	const leading = `<thinking>${thinking}</thinking>`;
	if (text.startsWith(leading)) text = text.slice(leading.length);
	// Old hosts sent a tail window after embedding reasoning. Recover its closing boundary.
	const close = text.indexOf("</thinking>");
	if (message.textTruncated && close >= 0 && !text.slice(0, close).includes("<thinking>") && thinking.endsWith(text.slice(0, close))) text = text.slice(close + 11);
	const tokens = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1[^\n]*(?:\n|$)|$)|(`+)[^\n]*?\2|<thinking>([\s\S]*?)(?:<\/thinking>|$)/g;
	text = text.replace(tokens, (whole: string, fence: string | undefined, inline: string | undefined, thought: string | undefined) => {
		if (fence || inline || thought === undefined || !thought) return whole;
		// The independent channel is evidence that this is transport markup, not prose.
		return thinking.includes(thought) ? "" : whole;
	});
	return { text, thinking };
}
