import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("last selected edition survives restart and is isolated by service", () => {
	const cache = new Map();
	const storage = { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: (key) => cache.delete(key) };
	const { readReadingLastBook, writeReadingLastBook } = loadTsCommonJs("src/renderer/src/utils/readingLastBook.ts");
	writeReadingLastBook("http://127.0.0.1:1234", { workId: "w1", editionId: "e1" }, storage);
	assert.deepEqual(JSON.parse(JSON.stringify(readReadingLastBook("http://127.0.0.1:1234", storage))), { workId: "w1", editionId: "e1" });
	assert.equal(readReadingLastBook("http://127.0.0.1:5678", storage), null);
	writeReadingLastBook("http://127.0.0.1:1234", null, storage);
	assert.equal(readReadingLastBook("http://127.0.0.1:1234", storage), null);
});

test("invalid or unavailable selection cache never prevents opening the reader", () => {
	const { readReadingLastBook, writeReadingLastBook } = loadTsCommonJs("src/renderer/src/utils/readingLastBook.ts");
	for (const raw of ["{", "null", '{"workId":"w1"}', '{"workId":"","editionId":"e1"}', "x".repeat(5000)]) {
		assert.equal(readReadingLastBook("http://127.0.0.1:1234", { getItem: () => raw }), null);
	}
	const blocked = {
		getItem: () => {
			throw new Error("blocked");
		},
		setItem: () => {
			throw new Error("blocked");
		},
		removeItem: () => {
			throw new Error("blocked");
		},
	};
	assert.equal(readReadingLastBook("http://127.0.0.1:1234", blocked), null);
	assert.doesNotThrow(() => writeReadingLastBook("http://127.0.0.1:1234", { workId: "w1", editionId: "e1" }, blocked));
});
