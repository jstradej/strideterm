import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { NormalizedOutputOptions } from "rolldown";
import { createUiPackageExporter } from "./ui-package-exporter.js";

type Callable = (...args: never[]) => unknown;
function hookHandler<T extends Callable>(hook: T | { handler: T } | undefined): T | undefined {
  if (typeof hook === "function") return hook;
  return hook?.handler;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("UI package exporter", () => {
  test("exports deterministic public files and static graph with exact bytes, excluding HTML, maps, private and plugins", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ui-package-"));
    roots.push(root);
    const publicDir = path.join(root, "public");
    const outDir = path.join(root, "dist");
    await mkdir(path.join(publicDir, "plugins"), { recursive: true });
    await mkdir(path.join(publicDir, "private"), { recursive: true });
    await mkdir(path.join(publicDir, "assets", ".private"), { recursive: true });
    await writeFile(path.join(publicDir, "logo.svg"), "<svg/>");
    await writeFile(path.join(publicDir, "assets", "noise.png"), "noise");
    await writeFile(path.join(publicDir, "assets", ".private", "hidden.js"), "hidden");
    await writeFile(path.join(publicDir, "assets", "unsupported.bin"), "unsupported");
    await writeFile(path.join(publicDir, ".env"), "private");
    await writeFile(path.join(publicDir, "secret.json"), "{}");
    await writeFile(path.join(publicDir, "plugins", "x.js"), "plugin");
    await writeFile(path.join(publicDir, "private", "x.png"), "private");
    await writeFile(path.join(publicDir, "source.map"), "map");
    await writeFile(path.join(publicDir, "index.html"), "html");
    try {
      await symlink(path.join(publicDir, "secret.json"), path.join(publicDir, "linked.json"));
    } catch {
      /* Windows may deny symlink creation without Developer Mode. */
    }

    const plugin = createUiPackageExporter();
    await hookHandler(plugin.configResolved)?.call({} as never, { publicDir, build: { outDir } } as never);
    const emitted: { fileName: string; source: string | Uint8Array }[] = [];
    const bundle = {
      "index.html": { type: "asset", source: "<html>" },
      "assets/main.js": {
        type: "chunk",
        code: "import './main.css'; import('./lazy.js')",
        imports: ["assets/vendor.js"],
        dynamicImports: ["assets/lazy.js"],
        isEntry: true,
        viteMetadata: { importedCss: new Set(["assets/main.css"]), importedAssets: new Set(["assets/generated.png"]) },
      },
      "assets/vendor.js": {
        type: "chunk",
        code: "vendor",
        imports: [],
        dynamicImports: [],
        isEntry: false,
        viteMetadata: { importedCss: new Set() },
      },
      "assets/lazy.js": {
        type: "chunk",
        code: "lazy",
        imports: [],
        dynamicImports: [],
        isEntry: false,
        viteMetadata: { importedCss: new Set() },
      },
      "assets/main.css": {
        type: "asset",
        source: "@font-face{src:url('./font.woff2')}.noise{background:url('/assets/noise.png')}",
      },
      "assets/font.woff2": { type: "asset", source: "font" },
      "assets/generated.png": { type: "asset", source: "generated" },
      "assets/main.css.map": { type: "asset", source: "map" },
    } as never;
    const generateBundle = hookHandler(plugin.generateBundle);
    if (!generateBundle) throw new Error("generateBundle hook missing");
    await generateBundle.call(
      { emitFile: (file: (typeof emitted)[number]) => emitted.push(file) } as never,
      { dir: outDir } as NormalizedOutputOptions,
      bundle,
      false,
    );
    await mkdir(path.join(outDir, "assets"), { recursive: true });
    for (const [filename, content] of Object.entries({
      "assets/main.js": "import './main.css'; import('./lazy.js')\n",
      "assets/vendor.js": "vendor\n",
      "assets/lazy.js": "lazy\n",
      "assets/main.css": "@font-face{src:url('./font.woff2')}.noise{background:url('/assets/noise.png')}\n",
      "assets/font.woff2": "font\n",
      "assets/noise.png": "noise",
      "logo.svg": "<svg/>",
      "secret.json": "{}",
      "assets/generated.png": "generated\n",
    }))
      await writeFile(path.join(outDir, filename), content);
    await mkdir(path.join(outDir, "ui-package"), { recursive: true });
    const pending = emitted.find((file) => file.fileName === "ui-package/manifest-pending.json")!;
    await writeFile(path.join(outDir, pending.fileName), pending.source);
    const writeBundle = hookHandler(plugin.writeBundle);
    if (!writeBundle) throw new Error("writeBundle hook missing");
    await writeBundle.call({} as never, { dir: outDir } as never, {} as never);
    const manifestFiles = (await import("node:fs/promises")).readdir(path.join(outDir, "ui-package"));
    const manifestName = (await manifestFiles)[0];
    const manifestFile = { fileName: `ui-package/${manifestName}` };
    const manifestBytes = await readFile(path.join(outDir, manifestFile.fileName));
    const descriptor = JSON.parse(await readFile(path.join(outDir, "ui-package-descriptor.json"), "utf8"));
    const manifest = JSON.parse(manifestBytes.toString());
    expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(descriptor.manifestSha256);
    expect(descriptor.manifestPath).toBe(`/${manifestFile.fileName}`);
    expect(manifest.entries["/logo.svg"]).toMatchObject({ size: 6, mime: "image/svg+xml" });
    expect(manifest.entries["/index.html"]).toBeUndefined();
    expect(manifest.entries["/secret.json"]).toBeUndefined();
    expect(
      Object.keys(manifest.entries).some((key: string) => /private|plugins|\.map|linked|unsupported/.test(key)),
    ).toBe(false);
    expect(manifest.imports["/assets/main.js"]).toEqual([
      "/assets/generated.png",
      "/assets/main.css",
      "/assets/vendor.js",
    ]);
    expect(manifest.imports["/assets/main.css"]).toEqual(["/assets/font.woff2", "/assets/noise.png"]);
    expect(manifest.entries["/assets/lazy.js"]).toBeDefined();
    expect(await readFile(path.join(publicDir, "logo.svg"), "utf8")).toBe("<svg/>");
  });

  test("fails the build when a declared bundle file is missing after emission", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ui-package-missing-"));
    roots.push(root);
    const outDir = path.join(root, "dist");
    const plugin = createUiPackageExporter();
    await hookHandler(plugin.configResolved)?.call({} as never, { publicDir: false, build: { outDir } } as never);
    const emitted: { fileName: string; source: string | Uint8Array }[] = [];
    const generateBundle = hookHandler(plugin.generateBundle);
    if (!generateBundle) throw new Error("generateBundle hook missing");
    await generateBundle.call(
      { emitFile: (file: (typeof emitted)[number]) => emitted.push(file) } as never,
      { dir: outDir } as NormalizedOutputOptions,
      {
        "assets/main.js": {
          type: "chunk",
          code: "main",
          imports: [],
          dynamicImports: [],
          isEntry: true,
          viteMetadata: { importedCss: new Set() },
        },
      } as never,
      false,
    );
    await mkdir(path.join(outDir, "ui-package"), { recursive: true });
    const pending = emitted.find((file) => file.fileName === "ui-package/manifest-pending.json")!;
    await writeFile(path.join(outDir, pending.fileName), pending.source);
    const writeBundle = hookHandler(plugin.writeBundle);
    if (!writeBundle) throw new Error("writeBundle hook missing");
    await expect(writeBundle.call({} as never, { dir: outDir } as never, {} as never)).rejects.toThrow(
      "UI package entry is missing from build output: /assets/main.js",
    );
    await expect(readFile(path.join(outDir, "ui-package-descriptor.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
