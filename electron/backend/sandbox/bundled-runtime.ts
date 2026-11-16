import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_SRT_VERSION } from "../../shared/sandbox.js";

const RUNTIME_MODULE = path.join("node_modules", "@anthropic-ai", "sandbox-runtime", "package.json");

function isCurrentBundle(dir: string): boolean {
  if (!existsSync(path.join(dir, RUNTIME_MODULE))) return false;
  try {
    return readFileSync(path.join(dir, "VERSION"), "utf8").trim() === SANDBOX_SRT_VERSION;
  } catch {
    return false;
  }
}

/**
 * The folder holding `node_modules/@anthropic-ai/sandbox-runtime` that ships with the app: `resources/sandbox-runtime`
 * when packaged (`extraResources`), else the build output `dist-electron/sandbox-runtime` found above this module
 * (development, tests). A bundle built for another pinned version is not offered. Null when there is none.
 */
export function findBundledSandboxRuntime(
  resourcesPath: string | undefined = process.resourcesPath,
  startDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string | null {
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, "sandbox-runtime");
    if (isCurrentBundle(packaged)) return packaged;
  }
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    const built = path.join(dir, "dist-electron", "sandbox-runtime");
    if (isCurrentBundle(built)) return built;
    if (path.dirname(dir) === dir) return null;
  }
}
