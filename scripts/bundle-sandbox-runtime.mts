import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The sandbox runtime (`@anthropic-ai/sandbox-runtime`, pinned by SANDBOX_SRT_VERSION) with the closure of its
 * production dependencies, written to `dist-electron/sandbox-runtime/node_modules/…` and shipped OUTSIDE app.asar
 * (`extraResources`). The app never imports it: strIDEterm copies this tree to where the sandbox runs (the host,
 * or the WSL distro), so a user never installs it with npm. The folder stays real files because bubblewrap executes
 * the seccomp helpers in the package's `vendor/` folder.
 */
export const RUNTIME_PACKAGE = "@anthropic-ai/sandbox-runtime";

export interface ClosureMember {
  name: string;
  version: string;
  dir: string;
}

interface Manifest {
  name?: string;
  version?: string;
  license?: unknown;
  dependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Manifest;
}

/** Node's lookup for a package, started at the depending package's own folder, so its nested versions win. */
function resolvePackageDir(name: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`${name} (needed by ${fromDir}) is not installed.`);
  }
}

/** The runtime and everything its production `dependencies` reach, one entry per name. */
export function collectClosure(appRoot: string): ClosureMember[] {
  const rootDir = resolvePackageDir(RUNTIME_PACKAGE, appRoot);
  const members = new Map<string, ClosureMember>();
  const queue = [rootDir];
  while (queue.length) {
    const dir = queue.shift() as string;
    const manifest = readManifest(dir);
    const name = manifest.name as string;
    const version = manifest.version as string;
    const known = members.get(name);
    if (known) {
      if (known.version !== version) {
        throw new Error(
          `Two versions of ${name} are needed (${known.version} and ${version}); the flat sandbox runtime tree holds one.`,
        );
      }
      continue;
    }
    members.set(name, { name, version, dir });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      queue.push(resolvePackageDir(dependency, dir));
    }
  }
  return [...members.values()];
}

export interface LicenceRow {
  name: string;
  version: string;
  license: string;
  licenceFile: boolean;
}

export function licenceOf(member: ClosureMember): LicenceRow {
  const raw = readManifest(member.dir).license;
  const license = typeof raw === "string" ? raw : ((raw as { type?: string } | undefined)?.type ?? "unknown");
  const licenceFile = readdirSync(member.dir).some((file) => /^(?:licen[cs]e|notice|copying)/iu.test(file));
  return { name: member.name, version: member.version, license, licenceFile };
}

export function bundleSandboxRuntime(appRoot: string, outDir: string): LicenceRow[] {
  const closure = collectClosure(appRoot);
  rmSync(outDir, { recursive: true, force: true });
  for (const member of closure) {
    const target = path.join(outDir, "node_modules", ...member.name.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    // A closure member that resolved to a nested folder lands flat above; the package's own `node_modules` is not copied.
    cpSync(member.dir, target, {
      recursive: true,
      dereference: true,
      filter: (source) => source !== path.join(member.dir, "node_modules"),
    });
  }
  const runtime = closure.find((member) => member.name === RUNTIME_PACKAGE) as ClosureMember;
  writeFileSync(path.join(outDir, "VERSION"), runtime.version);
  return closure.map(licenceOf);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = path.join(appRoot, "dist-electron", "sandbox-runtime");
  const rows = bundleSandboxRuntime(appRoot, outDir);
  for (const row of rows) {
    console.log(`${row.name}@${row.version}\t${row.license}\t${row.licenceFile ? "licence file" : "NO LICENCE FILE"}`);
  }
  console.log(`bundled the sandbox runtime and ${rows.length - 1} dependencies -> dist-electron/sandbox-runtime`);
}
