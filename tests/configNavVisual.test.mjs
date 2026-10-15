import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("model and tool navigation shares settings surfaces without legacy overrides", () => {
	const styles = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	const navigation = readFileSync("src/renderer/src/config/ConfigNavigation.tsx", "utf8");
	assert.match(modal, /orientation="vertical"/);
	assert.match(modal, /<ConfigNavigation\s+activeValue=\{sectionTabValue\(section,\s*tab\)\}/);
	assert.match(navigation, /<TabsTrigger\s/);
	assert.match(navigation, /w-\[216px\]/);
	assert.match(navigation, /max-\[820px\]:w-\[176px\]/);
	assert.match(navigation, /data-\[state=active\]:shadow-none/);
	assert.match(navigation, /layoutId=\{reduceMotion\s*\?\s*undefined\s*:\s*highlightId\}/);
	assert.doesNotMatch(styles, /\.config-nav-btn[^{]*\{/);
});
