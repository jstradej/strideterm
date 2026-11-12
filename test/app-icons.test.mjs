import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import snapConfig from "../electron-builder.snap.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { build } = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_COLOR_TYPE_RGBA = 6;

// electron-builder does not fail on a missing icon: it logs a warning and ships
// the default Electron icon, which is how the macOS build lost its icon.
test("every icon electron-builder is configured with exists", async () => {
  const configured = {
    "win.icon": build.win.icon,
    "nsis.installerIcon": build.nsis.installerIcon,
    "mac.icon": build.mac.icon,
    "linux.icon": build.linux.icon,
    "snap linux.icon": snapConfig.linux.icon,
  };
  for (const [key, iconPath] of Object.entries(configured)) {
    assert.ok(iconPath, `${key} is not set`);
    await assert.doesNotReject(access(path.join(repoRoot, iconPath)), `${key} points at missing ${iconPath}`);
  }
});

test("the macOS icon is a 1024x1024 RGBA PNG, the size the 512@2x icns entry is built from", async () => {
  const image = await readFile(path.join(repoRoot, build.mac.icon));
  assert.ok(image.subarray(0, 8).equals(PNG_SIGNATURE), `${build.mac.icon} is not a PNG`);
  assert.equal(image.toString("ascii", 12, 16), "IHDR");
  assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], [1024, 1024]);
  assert.equal(image[25], PNG_COLOR_TYPE_RGBA, "the squircle needs transparent corners");
});
