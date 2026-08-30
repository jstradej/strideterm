import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { createRequire } from "node:module";
import vue from "@vitejs/plugin-vue";
import { APP_CONFIG } from "./config/app-config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Resolve where node_modules actually lives — in worktrees it's typically
// shared from the parent repo, outside Vite's default fs.allow scope.
const require = createRequire(import.meta.url);
// monaco-editor stopped exposing ./package.json via its "exports" map (0.56+),
// so resolve its entry point and walk back to the enclosing node_modules dir.
const monacoPathParts = require.resolve("monaco-editor").split(sep);
const sharedNodeModules = monacoPathParts.slice(0, monacoPathParts.lastIndexOf("node_modules") + 1).join(sep);

// Node 26 ships its own `localStorage`/`sessionStorage` globals. Without
// `--localstorage-file` they read back as `undefined`, and vitest's jsdom
// environment only copies a jsdom window key onto `globalThis` when the key
// isn't there already or sits on its hardcoded allowlist — that list covers
// `Storage`, not the two instances. So Node's empty built-ins win and every
// test touching `window.localStorage` fails with "Cannot read properties of
// undefined (reading 'removeItem')". Turning the built-ins off in the test
// workers lets jsdom install its real Storage.
//
// Probed rather than passed unconditionally: the flag only exists on Node
// versions that have Web Storage, and CI still runs Node 22. `in` doesn't
// invoke the getter, so this doesn't trip Node's ExperimentalWarning.
const testExecArgv = "localStorage" in globalThis ? ["--no-experimental-webstorage"] : [];

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
    // App.vue references the splash image as a root-absolute public asset
    // ("/splash.png"), which the browser resolves against publicDir but the
    // test transformer reads as a filesystem path. Test-only alias so App.vue
    // can be mounted in jsdom; the dev server and the build are untouched.
    alias: { "/splash.png": resolve(__dirname, "src/public/splash.png") },
    execArgv: testExecArgv,
  },
});
