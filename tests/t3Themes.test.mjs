import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const palettes = JSON.parse(readFileSync("src/renderer/src/themes/t3-palettes.json", "utf8"));
const { getT3OrbColors, themeOrbStyle } = loadTsCommonJs("src/renderer/src/themes/t3Themes.ts");
const { SKIN_PRESETS } = loadTsCommonJs("src/renderer/src/themePresets.ts");
const { applyAppearanceAttributes } = loadTsCommonJs("src/renderer/src/themeAppearance.ts");

test("all six T3 themes use their own paired palettes for previews and selection", () => {
	assert.deepEqual(
		palettes.map((palette) => palette.id),
		["t3-code", "t3-chat", "t3-grove", "t3-ocean", "t3-ember", "t3-iris"],
	);
	for (const palette of palettes) {
		const preset = SKIN_PRESETS.find((item) => item.id === palette.id);
		assert.equal(preset.previewSurfaces.accent, palette.light.accent);
		for (const mode of ["light", "dark"]) {
			const root = { dataset: {} };
			applyAppearanceAttributes(root, { theme: mode, themeSkin: palette.id, accent: "default" }, false);
			assert.equal(root.dataset.appearance, palette.id);
			assert.equal(root.dataset.theme, mode);
			const colors = getT3OrbColors(palette.id, mode);
			assert.equal(colors.canvas, palette[mode].canvas);
			if (palette.id !== "t3-code") assert.equal(colors.messageAction, palette[mode].messageAction);
			assert.ok(themeOrbStyle(colors, mode).backgroundImage.includes(colors.accent));
		}
	}
	assert.equal(getT3OrbColors("unknown", "light"), undefined);
});

test("T3 Code artwork preserves the source's violet glow and Oklab falloff", () => {
	assert.equal(getT3OrbColors("t3-code", "light").messageAction, "#4f46e5");
	assert.equal(getT3OrbColors("t3-code", "dark").messageAction, "#8b9cff");
	const light = themeOrbStyle(getT3OrbColors("t3-code", "light"), "light");
	assert.ok(light.backgroundColor.includes("80%"));
	assert.ok(light.backgroundImage.includes("72% 22% in oklab"));
	assert.ok(light.backgroundImage.includes("72%, transparent) 28%, transparent 58%"));
});

test("generated theme tokens match the authoritative T3 palette data", () => {
	execFileSync(process.execPath, ["scripts/generate-t3-theme-css.mjs", "--check"]);
});
