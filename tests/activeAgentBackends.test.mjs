import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { isActiveAgentBackend, normalizeDefaultAgentBackend } = loadTsCommonJs("src/shared/activeAgentBackends.ts");
const { readWelcomeBackendPreference, resolveGuidePageBackend } = loadTsCommonJs("src/renderer/src/utils/chatSessionBootstrap.ts", { globals: { localStorage: { getItem: () => "acp:legacy" } } });
test("active backends retain Pi, DSH, image generation and video generation", () => {
	for (const backend of ["pi", "dsh", "imagegen", "videogen"]) {
		assert.equal(isActiveAgentBackend(backend), true);
		assert.equal(normalizeDefaultAgentBackend(backend), backend);
	}
	for (const backend of ["acp", "future", null, undefined, {}, ""]) {
		assert.equal(isActiveAgentBackend(backend), false);
		assert.equal(normalizeDefaultAgentBackend(backend), "pi");
	}
});
test("legacy welcome ACP preferences cannot create another ACP session", () => {
	assert.equal(readWelcomeBackendPreference(), undefined);
	assert.equal(resolveGuidePageBackend({ override: "acp", effectiveDefault: "pi" }), "pi");
	assert.equal(resolveGuidePageBackend({ effectiveDefault: "acp" }), "pi");
	assert.equal(resolveGuidePageBackend({ override: "dsh", effectiveDefault: "dsh" }), "dsh");
});
