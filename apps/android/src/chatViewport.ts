import type { RemoteMessage } from "../../../packages/tpa-remote/src/types";

/** Follow is controlled by human scrolling, never by list measurements or token arrival. */
export class ChatViewport {
	following = true;
	unread = false;
	private disclosure = false;
	scroll(distance: number, fromGesture: boolean) {
		if (!fromGesture) return;
		this.following = distance < 48;
		if (this.following) this.unread = false;
	}
	disclose() {
		this.disclosure = true;
	}
	pause() {
		this.following = false;
	}
	output() {
		this.disclosure = false;
		if (!this.following) this.unread = true;
	}
	resize() {
		return this.following && !this.disclosure;
	}
	latest() {
		this.following = true;
		this.unread = false;
		this.disclosure = false;
	}
}

/** Reconnect metadata alone does not mean the user missed newly generated content. */
export function outputChanged(previous: RemoteMessage[], next: RemoteMessage[]): boolean {
	return (
		previous.length !== next.length ||
		next.some((item, index) => {
			const old = previous[index];
			return !old || old.id !== item.id || old.text !== item.text || old.thinking !== item.thinking || old.tool?.detail !== item.tool?.detail || old.tool?.status !== item.tool?.status;
		})
	);
}

/** Completed turns keep their outline visible; manual overrides have priority. */
export function processIsOpen(id: string, overrides: ReadonlyMap<string, boolean>) {
	return overrides.get(id) ?? true;
}
