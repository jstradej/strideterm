import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadUiPackageDescriptor } from "./ui-package-descriptor.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function packageRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-ui-package-"));
  roots.push(root);
  await mkdir(path.join(root, "ui-package"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "fonts"), { recursive: true });
  await writeFile(path.join(root, "assets", "main.js"), "entry");
  await writeFile(path.join(root, "fonts", "icon.ttf"), "font");
  await writeFile(path.join(root, "splash.png"), "image");
  await writeFile(path.join(root, "index.html"), '<script type="module" src="./assets/main.js"></script>');
  const manifest = {
    schemaVersion: 1,
    entries: {
      "/assets/main.js": { size: 5, sha256: "a".repeat(64), mime: "text/javascript" },
      "/fonts/icon.ttf": { size: 4, sha256: "b".repeat(64), mime: "font/ttf" },
      "/splash.png": { size: 5, sha256: "c".repeat(64), mime: "image/png" },
    },
    entrypoints: ["/assets/main.js"],
    imports: { "/assets/main.js": [] },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = `/ui-package/manifest-${digest}.json`;
  await writeFile(path.join(root, manifestPath.slice(1)), bytes);
  await writeFile(
    path.join(root, "ui-package-descriptor.json"),
    JSON.stringify({ schemaVersion: 1, manifestPath, manifestSha256: digest }),
  );
  return { root, manifest, bytes, digest, manifestPath };
}

describe("loadUiPackageDescriptor", () => {
  test("returns an exact descriptor only when manifest and current HTML entry match", async () => {
    const fixture = await packageRoot();
    expect(await loadUiPackageDescriptor(fixture.root)).toEqual({
      schemaVersion: 1,
      manifestPath: fixture.manifestPath,
      manifestSha256: fixture.digest,
    });
    await writeFile(
      path.join(fixture.root, "index.html"),
      '<script type="module" src="./new-watch-build.js"></script>',
    );
    expect(await loadUiPackageDescriptor(fixture.root)).toBeNull();
  });

  test("fails closed on manifest digest mismatch, unknown keys, unsafe paths and malformed sizes", async () => {
    const fixture = await packageRoot();
    await writeFile(
      path.join(fixture.root, "ui-package-descriptor.json"),
      JSON.stringify({
        schemaVersion: 1,
        manifestPath: fixture.manifestPath,
        manifestSha256: "0".repeat(64),
      }),
    );
    expect(await loadUiPackageDescriptor(fixture.root)).toBeNull();

    const withUnknown = { ...fixture.manifest, surprise: true };
    await replaceManifest(fixture.root, withUnknown);
    expect(await loadUiPackageDescriptor(fixture.root)).toBeNull();

    const withTraversal = {
      ...fixture.manifest,
      entries: { ...fixture.manifest.entries, "/../secret": fixture.manifest.entries["/assets/main.js"] },
    };
    await replaceManifest(fixture.root, withTraversal);
    expect(await loadUiPackageDescriptor(fixture.root)).toBeNull();

    const withHiddenSegment = {
      ...fixture.manifest,
      entries: {
        ...fixture.manifest.entries,
        "/assets/.private/secret.js": fixture.manifest.entries["/assets/main.js"],
      },
    };
    await replaceManifest(fixture.root, withHiddenSegment);
    expect(await loadUiPackageDescriptor(fixture.root)).toBeNull();

    const oversized = {
      ...fixture.manifest,
      entries: {
        "/assets/main.js": { size: Number.MAX_SAFE_INTEGER + 1, sha256: "a".repeat(64), mime: "text/javascript" },
      },
    };
    await replaceManifest(fixture.root, oversized);
    expect(await loadUiPackageDescriptor(fixture.root)).toBeNull();
  });
});

async function replaceManifest(root: string, manifest: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(manifest));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = `/ui-package/manifest-${digest}.json`;
  await writeFile(path.join(root, manifestPath.slice(1)), bytes);
  await writeFile(
    path.join(root, "ui-package-descriptor.json"),
    JSON.stringify({ schemaVersion: 1, manifestPath, manifestSha256: digest }),
  );
}
