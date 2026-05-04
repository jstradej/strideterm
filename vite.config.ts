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
    // Watch mode (dev.ps1's vite build --watch) keeps a long-lived dist/
    // that the remote server re-serves to live mobile/web sessions. Wiping
    // it on every rebuild deletes the chunks the page is still importing
    // dynamically (lazy components like GitPane/SettingsDialog), which
    // surfaces as "Failed to load module script" in the client.
    emptyOutDir: process.env.VITE_BUILD_WATCH !== "1",
    rollupOptions: {
      output: {
        // In watch mode, drop content hashes from chunk names so a rebuild
        // overwrites files in place instead of producing new-hash files
        // alongside stale ones (which would either bloat dist/ or, with
        // emptyOutDir, vanish out from under live pages). Production builds
        // keep the hash for cache-busting.
        chunkFileNames: process.env.VITE_BUILD_WATCH === "1" ? "assets/[name].js" : "assets/[name]-[hash].js",
        entryFileNames: process.env.VITE_BUILD_WATCH === "1" ? "assets/[name].js" : "assets/[name]-[hash].js",
        assetFileNames:
          process.env.VITE_BUILD_WATCH === "1" ? "assets/[name][extname]" : "assets/[name]-[hash][extname]",
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
    include: ["**/*.test.js", "**/*.test.ts"],
    // Polyfill window.matchMedia so jsdom-mounted components that call
    // useIsNarrow / responsive composables don't crash with "matchMedia
    // is not a function" the moment they hit onMounted.
    setupFiles: [resolve(__dirname, "test/vitest-setup.ts")],
  },
});
