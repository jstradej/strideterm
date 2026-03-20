import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { APP_CONFIG } from "./config/app-config.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  root: resolve(__dirname, "src"),
  base: "./",
  clearScreen: false,
  server: {
    port: APP_CONFIG.renderer.devPort,
    strictPort: true,
    host: APP_CONFIG.renderer.devHost,
  },
  preview: {
    port: APP_CONFIG.renderer.previewPort,
    strictPort: true,
    host: APP_CONFIG.renderer.previewHost,
  },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.js"],
  },
});
