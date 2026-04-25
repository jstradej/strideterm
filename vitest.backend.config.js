import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/backend/**/*.test.js", "electron/backend/**/*.test.ts"],
  },
});
