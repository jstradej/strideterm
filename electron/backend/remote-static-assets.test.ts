/**
 * What the real remote server answers for the client bundle: the type of each asset (the relay
 * connector compresses by type) and how long a WebView may keep it.
 *
 * Two dist layouts, both as Vite writes them (vite.config.ts): a production build names every chunk
 * `assets/[name]-[hash]` and loads `assets/index-<hash>.js`; dev.ps1's watch build
 * (`VITE_BUILD_WATCH=1`) writes unhashed `assets/[name].js` over the same files on every rebuild.
 */
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { startRemoteServer } from "./remote-server.js";

const IMMUTABLE = "private, max-age=31536000, immutable";
const REVALIDATE = "private, no-cache";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const roots: string[] = [];
const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function dist(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-dist-"));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  return root;
}

function indexHtml(entry: string): string {
  return `<!doctype html><html><head><script type="module" crossorigin src="./assets/${entry}"></script></head><body></body></html>`;
}

async function serve(staticRoot: string): Promise<string> {
  const port = await freePort();
  const runtime = {
    getPayload: () => ({
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: "static-assets-token" } },
        profiles: [{ id: "default" }],
        workspaces: [],
        windowSlots: [],
      },
    }),
    getInitialState: async () => ({}),
    setRemoteInfo: () => undefined,
    listRemoteUrls: () => [],
    on: () => () => undefined,
    off: () => undefined,
  };
  servers.push(
    await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot,
    }),
  );
  return `http://127.0.0.1:${port}`;
}

const monacoCodiconPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.resolve("monaco-editor"))),
  "../../esm/vs/base/browser/ui/codicons/codicon/codicon.ttf",
);
const realCodiconTtf = () => readFile(monacoCodiconPath);

describe("remote client static assets", () => {
  test("every asset type the bundle ships carries its real Content-Type", async () => {
    const origin = await serve(
      await dist({
        "index.html": indexHtml("index-AbCd1234.js"),
        "assets/index-AbCd1234.js": "export {};",
        "assets/codicon-DF1abBS2.ttf": await realCodiconTtf(),
        "assets/face-Q1w2E3r4.woff2": Buffer.from("wOF2"),
        "assets/face-Q1w2E3r4.woff": Buffer.from("wOFF"),
        "assets/logo-Zx9_Yw8-.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        "favicon.ico": Buffer.from([0, 0, 1, 0]),
      }),
    );
    const typeOf = async (asset: string) => (await fetch(`${origin}/${asset}`)).headers.get("content-type");
    expect(await typeOf("assets/codicon-DF1abBS2.ttf")).toBe("font/ttf");
    expect(await typeOf("assets/face-Q1w2E3r4.woff2")).toBe("font/woff2");
    expect(await typeOf("assets/face-Q1w2E3r4.woff")).toBe("font/woff");
    expect(await typeOf("assets/logo-Zx9_Yw8-.png")).toBe("image/png");
    expect(await typeOf("favicon.ico")).toBe("image/x-icon");
  });

  test("a production build's hashed chunks are immutable; unhashed files and index.html are not", async () => {
    const origin = await serve(
      await dist({
        "index.html": indexHtml("index-AbCd1234.js"),
        "assets/index-AbCd1234.js": "export {};",
        "assets/vendor-xterm-BTXhE-UR.js": "export {};",
        "assets/codicon-DF1abBS2.ttf": await realCodiconTtf(),
        // `publicDir` files keep their names in every build.
        "splash.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      }),
    );
    const cacheOf = async (asset: string) => (await fetch(`${origin}/${asset}`)).headers.get("cache-control");
    expect(await cacheOf("assets/index-AbCd1234.js")).toBe(IMMUTABLE);
    expect(await cacheOf("assets/vendor-xterm-BTXhE-UR.js")).toBe(IMMUTABLE);
    expect(await cacheOf("assets/codicon-DF1abBS2.ttf")).toBe(IMMUTABLE);
    expect(await cacheOf("splash.png")).toBe(REVALIDATE);
    expect(await cacheOf("")).toBe("no-store");
    expect(await cacheOf("index.html")).toBe("no-store");
  });

  test("a watch build is revalidated throughout, even a name that looks hashed", async () => {
    const root = await dist({
      "index.html": indexHtml("index.js"),
      "assets/index.js": "export {};",
      // An unhashed watch-build chunk whose name ends in eight word characters.
      "assets/wsl-launcher.js": "export {};",
    });
    const origin = await serve(root);
    const cacheOf = async (asset: string) => (await fetch(`${origin}/${asset}`)).headers.get("cache-control");
    expect(await cacheOf("assets/index.js")).toBe(REVALIDATE);
    expect(await cacheOf("assets/wsl-launcher.js")).toBe(REVALIDATE);
    // And it still revalidates cheaply.
    const first = await fetch(`${origin}/assets/wsl-launcher.js`);
    const etag = first.headers.get("etag")!;
    expect((await fetch(`${origin}/assets/wsl-launcher.js`, { headers: { "If-None-Match": etag } })).status).toBe(304);
  });

  test("a watch build over an old production dist stops promising the leftovers are immutable", async () => {
    const root = await dist({
      "index.html": indexHtml("index-AbCd1234.js"),
      "assets/index-AbCd1234.js": "export {};",
      "assets/index.js": "export {};",
    });
    const origin = await serve(root);
    const cacheOf = async (asset: string) => (await fetch(`${origin}/${asset}`)).headers.get("cache-control");
    expect(await cacheOf("assets/index-AbCd1234.js")).toBe(IMMUTABLE);
    // dev.ps1 starts: the watch build rewrites index.html (emptyOutDir is off, the old chunks stay).
    await writeFile(path.join(root, "index.html"), indexHtml("index.js"));
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(root, "index.html"), later, later);
    expect(await cacheOf("assets/index-AbCd1234.js")).toBe(REVALIDATE);
  });
});
