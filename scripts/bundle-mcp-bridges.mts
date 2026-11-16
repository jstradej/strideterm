import { build } from "vite";

/**
 * Self-contained copies of the MCP bridge entries, written to `dist-electron/mcp-bridges/<name>.mjs` and shipped
 * OUTSIDE app.asar (`extraResources`). A bridge that runs inside the agent sandbox on Windows is started by the
 * distro's own `node`, which can read neither the Windows executable nor an `.asar` archive; one file with its
 * dependencies inlined is all it needs. Development builds and native hosts keep using the compiled entries.
 */
const entries = {
  "review-bridge-mcp-stdio": "dist-electron/electron/backend/review-bridge-mcp-stdio.js",
  "ssh-mcp-stdio-entry": "dist-electron/electron/backend/ssh-mcp-stdio-entry.js",
  "internal-mcp-stdio-entry": "dist-electron/electron/backend/internal-mcp-stdio-entry.js",
};

let first = true;
for (const [name, input] of Object.entries(entries)) {
  await build({
    configFile: false,
    logLevel: "warn",
    ssr: { noExternal: true, target: "node" },
    build: {
      ssr: true,
      target: "node20",
      minify: false,
      emptyOutDir: first,
      outDir: "dist-electron/mcp-bridges",
      rollupOptions: {
        input: { [name]: input },
        output: { format: "es", entryFileNames: "[name].mjs", codeSplitting: false },
      },
    },
  });
  first = false;
}
console.log(`bundled ${Object.keys(entries).length} MCP bridges -> dist-electron/mcp-bridges`);
