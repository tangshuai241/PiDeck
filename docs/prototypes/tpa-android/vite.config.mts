import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { defineConfig } from "vite";

/** Isolated design preview: does not boot Electron or connect to a host. */
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	base: "./",
	plugins: [react(), tailwind()],
	resolve: { alias: { "@": fileURLToPath(new URL("../../../src/renderer/src", import.meta.url)) } },
	build: { emptyOutDir: false },
	server: { host: "127.0.0.1" },
});
