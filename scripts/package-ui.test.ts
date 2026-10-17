import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { packageUi } from "./package-ui.js";

const roots: string[] = [];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-package-export-"));
  roots.push(root);
  const source = path.join(root, "source");
  const output = path.join(root, "artifact");
  await mkdir(path.join(source, "assets"), { recursive: true });
  const app = Buffer.from("export {};");
  await writeFile(path.join(source, "assets/app.js"), app);
  await writeFile(path.join(source, "index.html"), '<script type="module" src="assets/app.js"></script>');
  await writeFile(path.join(source, "config.json"), "secret");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      entries: { "/assets/app.js": { size: app.length, sha256: digest(app), mime: "text/javascript" } },
      entrypoints: ["/assets/app.js"],
      imports: {},
    }),
  );
  const manifestHash = digest(manifest);
  await mkdir(path.join(source, "ui-package"));
  await writeFile(path.join(source, `ui-package/manifest-${manifestHash}.json`), manifest);
  await writeFile(
    path.join(source, "ui-package-descriptor.json"),
    JSON.stringify({
      schemaVersion: 1,
      manifestPath: `/ui-package/manifest-${manifestHash}.json`,
      manifestSha256: manifestHash,
    }),
  );
  return { source, output, manifestHash };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("writes only manifest entries and metadata under the manifest digest", async () => {
  const f = await fixture();
  const destination = await packageUi(f.source, f.output);
  expect(path.basename(destination)).toBe(f.manifestHash);
  expect((await readdir(destination, { recursive: true })).map((entry) => entry.replaceAll("\\", "/")).sort()).toEqual(
    [
      "assets",
      "assets/app.js",
      "ui-package",
      "ui-package/manifest-" + f.manifestHash + ".json",
      "ui-package-descriptor.json",
    ].sort(),
  );
  expect(await readFile(path.join(destination, "assets/app.js"), "utf8")).toBe("export {};");
});

it("reuses an unchanged immutable package and rejects a corrupt existing one", async () => {
  const f = await fixture();
  const first = await packageUi(f.source, f.output);
  expect(await packageUi(f.source, f.output)).toBe(first);
  await writeFile(path.join(first, "assets/app.js"), "tampered");
  await expect(packageUi(f.source, f.output)).rejects.toThrow("Existing immutable package is corrupt");
});

it("rejects corrupt source bytes before creating an artifact", async () => {
  const f = await fixture();
  await writeFile(path.join(f.source, "assets/app.js"), "bad");
  await expect(packageUi(f.source, f.output)).rejects.toThrow("integrity check");
  await expect(readdir(f.output)).rejects.toThrow();
});

it("rejects traversal entries", async () => {
  const f = await fixture();
  const manifest = {
    schemaVersion: 1,
    entries: { "/assets/../secret.js": { size: 0, sha256: "0".repeat(64), mime: "text/javascript" } },
    entrypoints: ["/assets/../secret.js"],
    imports: {},
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const hash = digest(bytes);
  await writeFile(path.join(f.source, "ui-package", `manifest-${hash}.json`), bytes);
  await writeFile(
    path.join(f.source, "ui-package-descriptor.json"),
    JSON.stringify({ schemaVersion: 1, manifestPath: `/ui-package/manifest-${hash}.json`, manifestSha256: hash }),
  );
  await expect(packageUi(f.source, f.output)).rejects.toThrow("Invalid UI package descriptor");
});

it("removes its staging directory after a staged write fails", async () => {
  const f = await fixture();
  let writes = 0;
  await expect(
    packageUi(f.source, f.output, async (filename, bytes) => {
      writes++;
      if (writes === 2) throw new Error("simulated disk write failure");
      await writeFile(filename, bytes, { flag: "wx" });
    }),
  ).rejects.toThrow("simulated disk write failure");
  expect(writes).toBe(2);
  expect(await readdir(f.output)).toEqual([]);
});
