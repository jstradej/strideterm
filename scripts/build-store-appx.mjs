import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";

import { readStoreIdentity } from "./store-appx-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const name = process.argv[i];
  const value = process.argv[i + 1];
  if (!["--prepackaged", "--output"].includes(name) || !value || value.startsWith("--") || args.has(name)) {
    throw new Error(`Expected optional --prepackaged <path> or --output <path>; invalid argument: ${name}`);
  }
  args.set(name, value);
  i += 1;
}

function resolveWorkspacePath(input, fallback) {
  const resolved = path.resolve(repoRoot, input ?? fallback);
  const relative = path.relative(repoRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the repository workspace: ${resolved}`);
  }
  return resolved;
}

const appDir = resolveWorkspacePath(args.get("--prepackaged"), path.join("release", "win-unpacked"));
const outputDir = resolveWorkspacePath(args.get("--output"), path.join("release", "store-appx"));

function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
}

async function main() {
  const buildPurpose = process.env.MS_STORE_BUILD_PURPOSE ?? "store";
  if (buildPurpose !== "store" && buildPurpose !== "validation") {
    throw new Error("MS_STORE_BUILD_PURPOSE must be 'store' or 'validation'.");
  }

  const storeConfig = readStoreIdentity();
  if (storeConfig.status === "skipped") {
    const message =
      "Microsoft Store AppX build skipped: set all three MS_STORE_* repository variables after confirming the Partner Center product identity.";
    console.warn(`::warning::${message}`);
    console.warn(message);
    writeSummary(`## Microsoft Store package\n\nSkipped: ${message}`);
    return;
  }

  if (!existsSync(path.join(appDir, "strIDEterm.exe")) || !existsSync(path.join(appDir, "resources", "app.asar"))) {
    throw new Error(`Windows app payload not found at ${appDir}. Run the standard Windows release build first.`);
  }
  if (existsSync(outputDir)) throw new Error(`Store AppX output directory already exists: ${outputDir}`);

  for (const name of Object.keys(process.env)) {
    if (/^(?:WIN_)?CSC_/i.test(name)) delete process.env[name];
  }

  const artifacts = await build({
    projectDir: repoRoot,
    publish: "never",
    prepackaged: appDir,
    targets: Platform.WINDOWS.createTarget("appx", Arch.x64),
    config: {
      directories: { output: outputDir },
      appx: {
        identityName: storeConfig.identity.identityName,
        publisher: storeConfig.identity.publisher,
        publisherDisplayName: storeConfig.identity.publisherDisplayName,
        applicationId: "strIDEterm",
        displayName: "strIDEterm",
        languages: ["en-US"],
      },
      win: { signAndEditExecutable: false },
    },
  });

  if (artifacts.length === 0) throw new Error("electron-builder did not produce a Store AppX artifact.");
  const message =
    buildPurpose === "validation"
      ? `Built x64 validation-only AppX from ${path.relative(repoRoot, appDir)}: ${artifacts.join(", ")}. This temporary-identity package is not for Store submission.`
      : `Built unsigned x64 Store AppX from ${path.relative(repoRoot, appDir)}: ${artifacts.join(", ")}. Microsoft signs accepted Store packages.`;
  console.log(message);
  const summaryTitle =
    buildPurpose === "validation" ? "AppX validation build (not for Store submission)" : "Microsoft Store AppX package";
  writeSummary(`## ${summaryTitle}\n\n${message}`);
}

await main();
