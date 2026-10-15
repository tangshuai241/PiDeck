/** Native semantic palette matched to the user-approved reference screens. */
export const palettes = {
	light: { background: "#f9f9f9", surface: "#ffffff", muted: "#ededf0", text: "#202124", secondary: "#626976", border: "#e4e5e8", primary: "#3866c2", onPrimary: "#ffffff", success: "#2b9d78", danger: "#b13535", selected: "#d3ddf1", field: "#e2e3e8", avatar: "#36cbb7", strong: "#191a1d" },
	dark: { background: "#111113", surface: "#1a1a1e", muted: "#242429", text: "#f3f3f5", secondary: "#a0a1ad", border: "#34343c", primary: "#90afff", onPrimary: "#15171d", success: "#6cdb9a", danger: "#ffabab", selected: "#293754", field: "#2c2d34", avatar: "#1d9c8d", strong: "#ececf0" },
};
export type Palette = typeof palettes.light;
