// node-pty starts every macOS PTY through its `spawn-helper` binary. An install
// can leave that file without its execute bit, and then every terminal fails
// with "posix_spawnp failed." This runs from postinstall (and is checked by the
// Unix dev launcher). It must never fail an install: anything unexpected is a
// warning, and Windows is a no-op.
import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

export function spawnHelperPaths(root = defaultRoot) {
  const pty = join(root, "node_modules", "node-pty");
  const candidates = [join(pty, "build", "Release", "spawn-helper")];
  const prebuilds = join(pty, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) candidates.push(join(prebuilds, dir, "spawn-helper"));
  }
  return candidates.filter((path) => existsSync(path));
}

export function nonExecutableSpawnHelpers(root = defaultRoot) {
  if (process.platform === "win32") return [];
  return spawnHelperPaths(root).filter((path) => {
    try {
      accessSync(path, constants.X_OK);
      return false;
    } catch {
      return true;
    }
  });
}

export function fixSpawnHelperPermissions(root = defaultRoot) {
  if (process.platform === "win32") return;
  for (const path of nonExecutableSpawnHelpers(root)) {
    try {
      chmodSync(path, statSync(path).mode | 0o111);
      console.log(`[postinstall] made node-pty spawn-helper executable: ${path}`);
    } catch (error) {
      console.warn(
        `[postinstall] could not make ${path} executable (${error.message}); terminals may fail with "posix_spawnp failed."`,
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    fixSpawnHelperPermissions();
  } catch (error) {
    console.warn(`[postinstall] node-pty spawn-helper check skipped: ${error.message}`);
  }
}
