import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** Controlled IPC lets each test retire a picker before its request settles. */
function createHarness(initial = {}) {
	const host = quickMessageHookHost();
	const requests = [];
	const notices = [];
	let writes = 0;
	let options = { sessionId: "catalog-session", backend: "pi", projectId: "project-a", enabled: true, ...initial };
	const request = (backend, projectId, force) => {
		const deferred = Promise.withResolvers();
		requests.push({ ...deferred, backend, projectId, force });
		return deferred.promise;
	};
	const { useBackendModelCatalog } = createTsSandbox({
		globals: { Error },
		stubs: {
			react: {
				...host.react,
				useState(initialValue) {
					const [value, setValue] = host.react.useState(initialValue);
					return [
						value,
						(next) => {
							writes++;
							setValue(next);
						},
					];
				},
			},
			"../desktopApi": {
				desktopApi: {
					projects: { listModelsReport: (projectId, force) => request("pi", projectId, force) },
					sessions: { listDshModels: () => request("dsh") },
				},
			},
			"../i18n": { t: (key) => `localized:${key}` },
			"../utils/notice": { showNotice: (...args) => notices.push(args) },
		},
	})("src/renderer/src/hooks/useBackendModelCatalog.ts");
	return {
		requests,
		notices,
		get writes() {
			return writes;
		},
		render(patch = {}) {
			options = { ...options, ...patch };
			return host.render(() => useBackendModelCatalog(options));
		},
		unmount: host.unmount,
	};
}

/** Full report/model fixtures keep assertions on the public hook result. */
function report(id = "model-a") {
	return {
		models: [{ provider: "provider-a", id, name: id }],
		ok: true,
		reason: null,
		version: "1.0.0",
		detail: "",
		source: "cli",
		at: 1,
	};
}

const settle = () => new Promise(setImmediate);

function assertNoCatalog(value) {
	assert.equal(value.models.length, 0);
	assert.equal(value.report, null);
}

test("disabled catalog stays lazy, including manual reload", () => {
	const h = createHarness({ enabled: false });
	const value = h.render();
	value.reload(true);
	assert.equal(h.requests.length, 0);
	assertNoCatalog(value);
	assert.equal(value.loading, false);
	assert.equal(value.refreshing, false);
	h.unmount();
});

test("Pi catalog publishes its report and does not refetch on unchanged renders", async () => {
	const h = createHarness();
	h.render();
	assert.equal(h.render().loading, true);
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].projectId, "project-a");
	assert.equal(h.requests[0].force, false);
	const next = report();
	h.requests[0].resolve(next);
	await settle();
	const value = h.render();
	assert.equal(value.models, next.models);
	assert.equal(value.report, next);
	assert.equal(value.loading, false);
	assert.equal(value.refreshing, false);
	assert.equal(h.requests.length, 1);
	h.unmount();
});

for (const outcome of ["success", "failure"]) {
	for (const retirement of ["close", "unmount"]) {
		test(`late catalog ${outcome} cannot write state or show a notice after ${retirement}`, async () => {
			const h = createHarness();
			h.render();
			if (retirement === "close") h.render({ enabled: false });
			else h.unmount();
			const writesAfterRetirement = h.writes;
			if (outcome === "success") h.requests[0].resolve(report("retired"));
			else h.requests[0].reject(new Error("retired failure"));
			await settle();
			assert.equal(h.writes, writesAfterRetirement);
			assert.equal(h.notices.length, 0);
			if (retirement === "close") {
				const value = h.render();
				assertNoCatalog(value);
				assert.equal(value.loading, false);
				assert.equal(value.refreshing, false);
				h.unmount();
			}
		});
	}

	test(`reopening ignores a retired ${outcome} without settling the new request`, async () => {
		const h = createHarness();
		h.render();
		h.render({ enabled: false });
		h.render({ enabled: true });
		assert.equal(h.requests.length, 2);
		if (outcome === "success") h.requests[0].resolve(report("retired"));
		else h.requests[0].reject(new Error("retired failure"));
		await settle();
		assertNoCatalog(h.render());
		assert.equal(h.render().loading, true);
		assert.equal(h.notices.length, 0);
		const current = report("current");
		h.requests[1].resolve(current);
		await settle();
		assert.equal(h.render().report, current);
		h.unmount();
	});
}

for (const enabled of [true, false]) {
	for (const patch of [{ projectId: "project-b" }]) {
		const dimension = Object.keys(patch)[0];
		test(`switching ${dimension} hides an accepted old catalog on the first render (enabled=${enabled})`, async () => {
			const h = createHarness();
			h.render();
			h.requests[0].resolve(report("old-scope"));
			await settle();
			assert.equal(h.render().report.ok, true);
			// Consumers use report.ok to discard missing welcome preferences. An effect-only
			// reset is too late: the first new-scope render must not authorize that deletion.
			assertNoCatalog(h.render({ ...patch, enabled }));
			assertNoCatalog(h.render());
			assert.equal(h.requests.length, enabled ? 2 : 1);
			if (enabled) {
				const next = report("new-scope");
				h.requests[1].resolve(next);
				await settle();
				assert.equal(h.render().models, next.models);
			}
			h.unmount();
		});
	}
}

test("same-source sessions reuse the accepted catalog without starting a new lookup", async () => {
	const h = createHarness();
	h.render();
	const accepted = report();
	h.requests[0].resolve(accepted);
	await settle();
	assert.equal(h.render({ sessionId: "another-session" }).report, accepted);
	assert.equal(h.requests.length, 1);
	h.unmount();
});

test("closing a refresh clears busy flags but retains accepted same-scope data", async () => {
	const h = createHarness();
	h.render();
	const accepted = report();
	h.requests[0].resolve(accepted);
	await settle();
	h.render().reload(true);
	assert.equal(h.render().refreshing, true);
	h.render({ enabled: false });
	const closed = h.render();
	assert.equal(closed.report, accepted);
	assert.equal(closed.loading, false);
	assert.equal(closed.refreshing, false);
	h.requests[1].resolve(report("discarded-refresh"));
	await settle();
	assert.equal(h.render().report, accepted);
	h.render({ enabled: true });
	assert.equal(h.requests.length, 3);
	const reopened = report("reopened");
	h.requests[2].resolve(reopened);
	await settle();
	assert.equal(h.render().report, reopened);
	h.unmount();
});

test("manual refresh supersedes initial load and owns the mutually exclusive busy state", async () => {
	const h = createHarness();
	h.render();
	h.render().reload(true);
	assert.equal(h.requests[1].force, true);
	assert.equal(h.render().refreshing, true);
	assert.equal(h.render().loading, false);
	h.requests[0].resolve(report("superseded"));
	await settle();
	assertNoCatalog(h.render());
	assert.equal(h.render().refreshing, true);
	const refreshed = report("refreshed");
	h.requests[1].resolve(refreshed);
	await settle();
	assert.equal(h.render().report, refreshed);
	assert.equal(h.render().refreshing, false);
	h.unmount();
});

test("current pi failure remains visible and a manual retry can recover", async () => {
	const h = createHarness();
	h.render();
	const detail = "catalog unavailable";
	h.requests[0].reject(new Error(detail));
	await settle();
	const failed = h.render();
	assert.equal(failed.models.length, 0);
	assert.equal(failed.report.ok, false);
	assert.equal(failed.report.reason, "cli-failed");
	assert.equal(failed.report.detail, detail);
	assert.deepEqual(h.notices, [[detail, 4000]]);
	assert.equal(failed.loading, false);
	failed.reload(true);
	const recovered = report("recovered");
	h.requests[1].resolve(recovered);
	await settle();
	assert.equal(h.render().models, recovered.models);
	assert.equal(h.render().refreshing, false);
	h.unmount();
});
