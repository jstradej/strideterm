import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface UiPackageDescriptor {
  schemaVersion: 1;
  manifestPath: string;
  manifestSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function validPackagePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[?#%\\\0-\x1f\x7f]/.test(value))
    return false;
  try {
    const segments = value.split("/").slice(1);
    if (!segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")) return false;
    if (segments.some((segment) => segment.startsWith("."))) return false;
    return (
      (/^\/(?:assets|fonts|icons)\//.test(value) ||
        ["/favicon.ico", "/favicon.svg", "/logo.svg", "/splash.png", "/manifest.webmanifest"].includes(value)) &&
      !/\.(?:map|html?)$/i.test(value) &&
      !/^\/(?:api|ws|private|plugins|ui-package)(?:\/|$)/i.test(value) &&
      !segments.some((segment) => ["private", "plugins"].includes(segment.toLowerCase()))
    );
  } catch {
    return false;
  }
}

export async function loadUiPackageDescriptor(staticRoot: string): Promise<UiPackageDescriptor | null> {
  try {
    const descriptor = JSON.parse(
      await readFile(path.join(staticRoot, "ui-package-descriptor.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      !exactKeys(descriptor, ["schemaVersion", "manifestPath", "manifestSha256"]) ||
      descriptor.schemaVersion !== 1 ||
      typeof descriptor.manifestPath !== "string" ||
      typeof descriptor.manifestSha256 !== "string" ||
      !SHA256.test(descriptor.manifestSha256) ||
      descriptor.manifestPath !== `/ui-package/manifest-${descriptor.manifestSha256}.json`
    )
      return null;

    const manifestBytes = await readFile(path.join(staticRoot, descriptor.manifestPath.slice(1)));
    if (
      manifestBytes.byteLength > MAX_MANIFEST_BYTES ||
      createHash("sha256").update(manifestBytes).digest("hex") !== descriptor.manifestSha256
    )
      return null;
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
    if (!exactKeys(manifest, ["schemaVersion", "entries", "entrypoints", "imports"]) || manifest.schemaVersion !== 1)
      return null;
    if (!manifest.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) return null;
    const rawEntries = manifest.entries as Record<string, unknown>;
    const urls = Object.keys(rawEntries);
    if (!urls.length || urls.length > MAX_ENTRIES) return null;
    let totalBytes = 0;
    for (const [url, rawEntry] of Object.entries(rawEntries)) {
      if (!validPackagePath(url) || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null;
      const entry = rawEntry as Record<string, unknown>;
      if (
        !exactKeys(entry, ["size", "sha256", "mime"]) ||
        !Number.isSafeInteger(entry.size) ||
        (entry.size as number) < 0 ||
        (entry.size as number) > MAX_ENTRY_BYTES ||
        typeof entry.sha256 !== "string" ||
        !SHA256.test(entry.sha256) ||
        typeof entry.mime !== "string" ||
        ![
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
        ].includes(entry.mime) ||
        entry.mime !== entry.mime.toLowerCase()
      )
        return null;
      totalBytes += entry.size as number;
      if (totalBytes > MAX_PACKAGE_BYTES) return null;
    }
    const entrypoints = manifest.entrypoints;
    if (
      !Array.isArray(entrypoints) ||
      !entrypoints.length ||
      entrypoints.length > 64 ||
      entrypoints.some((entry) => !validPackagePath(entry) || !Object.hasOwn(rawEntries, entry))
    )
      return null;
    if (!manifest.imports || typeof manifest.imports !== "object" || Array.isArray(manifest.imports)) return null;
    for (const [url, deps] of Object.entries(manifest.imports as Record<string, unknown>)) {
      if (
        !Object.hasOwn(rawEntries, url) ||
        !Array.isArray(deps) ||
        deps.length > 256 ||
        deps.some((dep) => !validPackagePath(dep) || !Object.hasOwn(rawEntries, dep))
      )
        return null;
    }

    const html = await readFile(path.join(staticRoot, "index.html"), "utf8");
    const moduleEntries = [...html.matchAll(/<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/gi)].map(
      (match) => `/${decodeURIComponent(match[1].replace(/^\.\//, ""))}`,
    );
    if (!moduleEntries.length || moduleEntries.some((entry) => !entrypoints.includes(entry))) return null;
    return { schemaVersion: 1, manifestPath: descriptor.manifestPath, manifestSha256: descriptor.manifestSha256 };
  } catch {
    return null;
  }
}
