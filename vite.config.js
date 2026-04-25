import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import vue from "@vitejs/plugin-vue";
import { APP_CONFIG } from "./config/app-config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Resolve where node_modules actually lives — in worktrees it's typically
// shared from the parent repo, outside Vite's default fs.allow scope.
const require = createRequire(import.meta.url);
const sharedNodeModules = resolve(dirname(require.resolve("monaco-editor/package.json")), "..");

export default defineConfig({
  plugins: [vue()],
  root: resolve(__dirname, "src"),
  base: "./",
  clearScreen: false,
  server: {
    port: APP_CONFIG.renderer.devPort,
    strictPort: true,
    host: APP_CONFIG.renderer.devHost,
    fs: {
      // Worktrees share node_modules from the parent repo dir, which lives
      // outside the Vite project root. Allow it so Monaco workers / fonts load.
      allow: [resolve(__dirname), sharedNodeModules],
    },
  },
  preview: {
    port: APP_CONFIG.renderer.previewPort,
    strictPort: true,
    host: APP_CONFIG.renderer.previewHost,
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/vue/") ||
            id.includes("node_modules/pinia/") ||
            id.includes("node_modules/@vue/")
          ) {
            return "vendor-vue";
          }
          if (id.includes("node_modules/@xterm/")) {
            return "vendor-xterm";
          }
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.js"],
  },
});
