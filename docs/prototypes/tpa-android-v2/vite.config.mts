import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** A separate review build keeps the first design available for comparison. */
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	base: "./",
	plugins: [react(), tailwind()],
	resolve: { alias: { "@": fileURLToPath(new URL("../../../src/renderer/src", import.meta.url)) } },
	build: { emptyOutDir: false, assetsInlineLimit: 1024 * 1024, outDir: fileURLToPath(new URL("../../../../../output/TPA/android-reference-v2", import.meta.url)) },
	server: { host: "127.0.0.1" },
});
