import { createHash } from "node:crypto";
import { lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import posix from "node:path/posix";
import type { OutputBundle } from "rolldown";
import type { Plugin } from "vite";

type Entry = { size: number; sha256: string; mime: string };
const MIME: Record<string, string> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".webmanifest": "application/json",
};
const PACKAGE_MIMES = new Set([
  "application/javascript",
  "text/javascript",
  "text/css",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "application/font-woff",
  "application/wasm",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/x-icon",
  "application/json",
]);
const PACKAGE_ROOT_FILES = new Set([
  "/favicon.ico",
  "/favicon.svg",
  "/logo.svg",
  "/splash.png",
  "/manifest.webmanifest",
]);
function validPackagePath(url: string, mime: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//") || /[?#%\\\0-\x1f\x7f]/.test(url) || !PACKAGE_MIMES.has(mime))
    return false;
  const segments = url.slice(1).split("/");
  if (!segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.startsWith(".")))
    return false;
  if (/\.(?:map|htm|html)$/i.test(url) || /^\/(?:api|ws|private|plugins|ui-package)(?:\/|$)/i.test(url)) return false;
  if (segments.some((segment) => ["private", "plugins"].includes(segment.toLowerCase()))) return false;
  return /^\/(?:assets|fonts|icons)\//.test(url) || PACKAGE_ROOT_FILES.has(url);
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function createUiPackageExporter(): Plugin {
  let publicDir: string | false = false;
  let outDir = "";
  return {
    name: "strideterm-ui-package-exporter",
    enforce: "post",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
      outDir = config.build.outDir;
    },
    async generateBundle(_options, bundle: OutputBundle) {
      if (process.env.VITE_BUILD_WATCH === "1") return;
      const entries: Record<string, Entry> = {};
      const imports: Record<string, string[]> = {};
      const entrypoints: string[] = [];
      const outputFiles = new Set(Object.keys(bundle));
      const add = (url: string, data: Buffer, mime: string) => {
        if (!validPackagePath(url, mime)) return false;
        entries[url] = { size: data.byteLength, sha256: sha256(data), mime };
        return true;
      };
      for (const [file, item] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        if (
          /\.map$/i.test(file) ||
          /(^|\/)(plugins|private)(\/|$)/i.test(file) ||
          /\.html?$/i.test(file) ||
          file.split("/").some((segment) => segment.startsWith("."))
        )
          continue;
        if (item.type === "chunk") {
          const url = `/${file}`;
          if (!add(url, Buffer.from(item.code), "text/javascript") && item.isEntry) {
            throw new Error(`UI package entrypoint is outside the approved package paths: ${url}`);
          }
          const deps = [
            ...item.imports,
            ...(item.viteMetadata?.importedCss ?? []),
            ...(item.viteMetadata?.importedAssets ?? []),
          ]
            .filter((dep) => !/\.map$/i.test(dep) && outputFiles.has(dep))
            .map((dep) => `/${dep}`);
          imports[url] = [...new Set(deps)].sort();
          if (item.isEntry) entrypoints.push(url);
        } else {
          const data = Buffer.isBuffer(item.source) ? item.source : Buffer.from(item.source);
          add(`/${file}`, data, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
          if (file.endsWith(".css")) {
            const referenced = [...data.toString("utf8").matchAll(/url\(["']?([^"')]+)["']?\)/g)]
              .map((match) => match[1].trim())
              .filter((url) => url && !/^(data:|https?:|\/\/|#)/i.test(url))
              .map((url) => decodeURIComponent(url.split(/[?#]/, 1)[0]))
              .map((url) =>
                url.startsWith("/")
                  ? posix.normalize(url.slice(1))
                  : posix.normalize(posix.join(posix.dirname(file), url)),
              )
              .filter((dependency) => dependency !== ".." && !dependency.startsWith("../"))
              .map((dependency) => `/${dependency}`);
            imports[`/${file}`] = [...new Set(referenced)].sort();
          }
        }
      }
      if (
        publicDir &&
        (await lstat(publicDir)
          .then((s) => s.isDirectory())
          .catch(() => false))
      ) {
        async function addPublic(dir: string, prefix = ""): Promise<void> {
          const children = await readdir(dir, { withFileTypes: true });
          children.sort((a, b) => a.name.localeCompare(b.name));
          for (const item of children) {
            const filename = path.join(dir, item.name);
            const relative = prefix ? `${prefix}/${item.name}` : item.name;
            if (
              /(^|\/)(plugins|private)(\/|$)/i.test(relative) ||
              /\.map$/i.test(relative) ||
              /\.html?$/i.test(relative) ||
              relative.split("/").some((segment) => segment.startsWith("."))
            )
              continue;
            const stat = await lstat(filename);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) await addPublic(filename, relative);
            else if (stat.isFile() && !entries[`/${relative}`]) {
              add(
                `/${relative}`,
                await readFile(filename),
                MIME[path.extname(item.name).toLowerCase()] ?? "application/octet-stream",
              );
            }
          }
        }
        await addPublic(publicDir);
      }
      const manifest = { schemaVersion: 1, entries, entrypoints: entrypoints.sort(), imports };
      this.emitFile({ type: "asset", fileName: "ui-package/manifest-pending.json", source: JSON.stringify(manifest) });
    },
    async writeBundle() {
      if (process.env.VITE_BUILD_WATCH === "1") return;
      const pendingPath = path.join(outDir, "ui-package/manifest-pending.json");
      const pending = JSON.parse(await readFile(pendingPath, "utf8")) as {
        schemaVersion: 1;
        entries: Record<string, Entry>;
        entrypoints: string[];
        imports: Record<string, string[]>;
      };
      for (const [url, entry] of Object.entries(pending.entries)) {
        const relative = decodeURIComponent(url.replace(/^\//, ""));
        const filename = path.resolve(outDir, relative);
        if (!filename.startsWith(`${path.resolve(outDir)}${path.sep}`)) {
          throw new Error(`UI package entry escapes output directory: ${url}`);
        }
        let bytes: Buffer;
        try {
          const stat = await lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error("not a regular package file");
          }
          bytes = await readFile(filename);
        } catch (error) {
          throw new Error(`UI package entry is missing from build output: ${url}`, { cause: error });
        }
        entry.size = bytes.byteLength;
        entry.sha256 = sha256(bytes);
      }
      for (const [url, deps] of Object.entries(pending.imports)) {
        pending.imports[url] = deps.filter((dependency) => pending.entries[dependency]).sort();
      }
      const bytes = Buffer.from(JSON.stringify(pending));
      const digest = sha256(bytes);
      await writeFile(path.join(outDir, `ui-package/manifest-${digest}.json`), bytes);
      await writeFile(
        path.join(outDir, "ui-package-descriptor.json"),
        JSON.stringify({
          schemaVersion: 1,
          manifestPath: `/ui-package/manifest-${digest}.json`,
          manifestSha256: digest,
        }),
      );
      await unlink(pendingPath);
    },
  };
}
