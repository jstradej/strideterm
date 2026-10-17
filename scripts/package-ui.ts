import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadUiPackageDescriptor } from "../electron/backend/ui-package-descriptor.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function sourceFile(root: string, relative: string): Promise<Buffer> {
  const filename = path.resolve(root, ...relative.split("/"));
  const rootReal = await realpath(root);
  const fileReal = await realpath(filename);
  if (!fileReal.startsWith(`${rootReal}${path.sep}`)) throw new Error(`Package source path escapes root: ${relative}`);
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Package source is not a regular file: ${relative}`);
  return readFile(fileReal);
}

async function verifiedFiles(root: string, descriptor: { manifestPath: string; manifestSha256: string }) {
  const descriptorBytes = await sourceFile(root, "ui-package-descriptor.json");
  const parsedDescriptor = JSON.parse(descriptorBytes.toString("utf8")) as Record<string, unknown>;
  if (
    parsedDescriptor.schemaVersion !== 1 ||
    parsedDescriptor.manifestPath !== descriptor.manifestPath ||
    parsedDescriptor.manifestSha256 !== descriptor.manifestSha256 ||
    Object.keys(parsedDescriptor).length !== 3
  ) {
    throw new Error("UI package descriptor changed during export");
  }
  const manifestBytes = await sourceFile(root, descriptor.manifestPath.slice(1));
  if (hash(manifestBytes) !== descriptor.manifestSha256) throw new Error("UI package manifest changed during export");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    entries: Record<string, { size: number; sha256: string }>;
  };
  const files = new Map<string, Buffer>([
    ["ui-package-descriptor.json", descriptorBytes],
    [descriptor.manifestPath.slice(1), manifestBytes],
  ]);
  for (const [url, entry] of Object.entries(manifest.entries)) {
    const relative = url.slice(1);
    const segments = relative.split("/");
    if (
      !segments.length ||
      segments.some((part) => !part || part === "." || part === "..") ||
      path.isAbsolute(relative)
    )
      throw new Error(`Unsafe package path: ${url}`);
    const filename = path.resolve(root, ...segments);
    if (!filename.startsWith(`${path.resolve(root)}${path.sep}`))
      throw new Error(`Package path escapes source: ${url}`);
    const bytes = await sourceFile(root, relative);
    if (bytes.byteLength !== entry.size || hash(bytes) !== entry.sha256)
      throw new Error(`Package entry failed integrity check: ${url}`);
    files.set(relative, bytes);
  }
  return files;
}

async function matchesExisting(directory: string, files: Map<string, Buffer>): Promise<boolean> {
  try {
    const actual = new Set<string>();
    async function walk(dir: string, prefix = "") {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isSymbolicLink()) return false;
        if (item.isDirectory()) {
          if (!(await walk(path.join(dir, item.name), rel))) return false;
        } else if (item.isFile()) actual.add(rel);
        else return false;
      }
      return true;
    }
    if (!(await walk(directory)) || actual.size !== files.size) return false;
    for (const [relative, expected] of files) {
      if (!actual.has(relative) || !expected.equals(await readFile(path.join(directory, ...relative.split("/")))))
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function packageUi(
  source: string,
  output: string,
  writeArtifact: (filename: string, bytes: Buffer) => Promise<void> = (filename, bytes) =>
    writeFile(filename, bytes, { flag: "wx" }),
): Promise<string> {
  const sourceRoot = path.resolve(source);
  const outputRoot = path.resolve(output);
  const descriptor = await loadUiPackageDescriptor(sourceRoot);
  if (!descriptor) throw new Error(`Invalid UI package descriptor in ${sourceRoot}`);
  const sourceReal = await realpath(sourceRoot);
  const files = await verifiedFiles(sourceReal, descriptor);
  await mkdir(outputRoot, { recursive: true });
  if ((await lstat(outputRoot)).isSymbolicLink())
    throw new Error(`Artifact output root cannot be a symlink: ${outputRoot}`);
  const destination = path.join(outputRoot, descriptor.manifestSha256);
  try {
    const destinationStat = await lstat(destination);
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory())
      throw new Error(`Existing immutable package is not a regular directory: ${destination}`);
    if (!(await matchesExisting(destination, files)))
      throw new Error(`Existing immutable package is corrupt: ${destination}`);
    return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp(path.join(outputRoot, `.ui-package-${descriptor.manifestSha256}-`));
  try {
    for (const [relative, bytes] of files) {
      const target = path.resolve(temporary, ...relative.split("/"));
      if (!target.startsWith(`${temporary}${path.sep}`)) throw new Error(`Unsafe output path: ${relative}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeArtifact(target, bytes);
    }
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    const resolvedTemp = path.resolve(temporary);
    if (
      path.dirname(resolvedTemp) === outputRoot &&
      path.basename(resolvedTemp).startsWith(`.ui-package-${descriptor.manifestSha256}-`)
    ) {
      await rm(resolvedTemp, { recursive: true, force: true });
    }
    if (["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      if (await matchesExisting(destination, files)) return destination;
    }
    throw error;
  }
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const source = option(args, "--source", "dist");
  const output = option(args, "--output", "release/ui-package");
  packageUi(source, output)
    .then((directory) => console.log(directory))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
