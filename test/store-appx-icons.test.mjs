import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STORE_APPX_ICON_SPECS, validateStoreAppxIcons } from "../scripts/store-appx-icons.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appxIconsDir = path.join(repoRoot, "assets", "appx");

test("Store AppX includes every custom package logo at the required dimensions", async () => {
  assert.equal(STORE_APPX_ICON_SPECS.length, 4);
  await validateStoreAppxIcons(appxIconsDir);
});

test("missing a required AppX logo fails before electron-builder can use sample artwork", async () => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "strideterm-appx-icons-"));
  try {
    await cp(appxIconsDir, temporaryDir, { recursive: true });
    await rm(path.join(temporaryDir, "Wide310x150Logo.png"));

    await assert.rejects(
      validateStoreAppxIcons(temporaryDir),
      /refusing electron-builder sample fallback:[\s\S]*Wide310x150Logo\.png is missing \(expected 310x150\)/,
    );
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test("incorrect AppX logo dimensions fail before packaging", async () => {
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), "strideterm-appx-icons-"));
  try {
    await cp(appxIconsDir, temporaryDir, { recursive: true });
    const logoPath = path.join(temporaryDir, "StoreLogo.png");
    const logo = await readFile(logoPath);
    logo.writeUInt32BE(49, 16);
    await writeFile(logoPath, logo);

    await assert.rejects(validateStoreAppxIcons(temporaryDir), /StoreLogo\.png must be 50x50; found 49x50/);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
});
