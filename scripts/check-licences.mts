#!/usr/bin/env tsx
/**
 * The licence gate for the desktop app's shipped dependencies.
 *
 * The mobile monorepo has one of these (`strideterm-mobile/scripts/check-licences.mjs`), and the
 * production hardening plan §7 asks for the gate in BOTH repositories — a permissive-only dependency
 * tree on one side and an unread copyleft obligation on the other is not a supply chain anybody has
 * checked.
 *
 * WHAT IT READS. `package-lock.json` for the SET of packages, and each package's own installed
 * `package.json` for its licence. No child process: `npm ls --json` would answer both questions in one
 * call, but invoking it portably means either `shell: true` (a deprecation warning and an injection
 * surface for no benefit) or `npm.cmd`, which Node's `spawnSync` now refuses outright on Windows. The
 * lockfile is also the more honest source for "what ships": it is what `npm ci` installs, and its
 * `dev` flag is what separates the artifact from the toolchain.
 *
 * Dev dependencies are deliberately out of scope — they are not in the artifact, and holding a test
 * runner to the same standard as a shipped library is the kind of noise that gets a gate switched off.
 *
 * A package in the lockfile that is not installed is an OPTIONAL native dependency this platform did
 * not build (`bufferutil`, `cpu-features`). It is counted and NAMED in the output rather than silently
 * skipped, because it may be in the artifact on another platform and somebody has to have looked at it.
 *
 * ALLOWLIST, NOT DENYLIST. An unrecognised licence fails, and the resolution is to read it and decide
 * rather than to widen the list until the command passes. A denylist passes everything nobody thought
 * of, and the failure mode here is not a crash — it is a shipped binary carrying an obligation nobody
 * read.
 *
 * Usage: npx tsx scripts/check-licences.mts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Licences a shipped Electron app may carry, each with why it is acceptable. */
const ALLOWED = new Map<string, string>([
  ["MIT", "permissive, attribution only"],
  ["ISC", "permissive, attribution only — functionally MIT"],
  ["BSD-2-Clause", "permissive, attribution only"],
  ["BSD-3-Clause", "permissive, attribution plus a no-endorsement clause"],
  ["Apache-2.0", "permissive, attribution plus an explicit patent grant"],
  ["0BSD", "permissive, no attribution required"],
  ["Unlicense", "public-domain dedication"],
  ["CC0-1.0", "public-domain dedication"],
  ["CC-BY-4.0", "attribution licence, acceptable for data/asset packages"],
  ["BlueOak-1.0.0", "permissive, plain-language equivalent of MIT"],
  ["Python-2.0", "permissive; appears only as a dual-licence alternative"],
  ["MIT-0", "permissive, no attribution required"],
  ["Zlib", "permissive, attribution optional"],
  ["WTFPL", "public-domain-equivalent"],
]);

/**
 * Packages accepted on a recorded decision rather than from metadata.
 *
 * Each needs a reason. An escape hatch with no reason attached is how an allowlist becomes decoration.
 */
const DECIDED = new Map<string, string>([["strideterm", "first-party: this application"]]);

interface Manifest {
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  optional?: boolean;
}

interface LockEntry {
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  version?: string;
}

/**
 * Normalises the spellings of one licence into an SPDX id. A dual licence passes if either side does.
 *
 * `(MIT OR Apache-2.0)` is a real and common declaration, and refusing it would be refusing a package
 * that offers a licence this project accepts.
 */
function normalise(raw: string | { type?: string } | { type?: string }[] | undefined): string | null {
  if (!raw) return null;
  const value = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0]?.type ?? "") : (raw.type ?? "");
  if (!value) return null;
  const alternatives = value
    .replace(/^\(|\)$/g, "")
    .split(/\s+OR\s+/i)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (alternatives.length > 1) {
    const permitted = alternatives.find((entry) => ALLOWED.has(canonical(entry)));
    return permitted ? canonical(permitted) : canonical(alternatives[0]!);
  }
  return canonical(value);
}

/** The SPDX id for the spellings that actually appear in this tree. Anything else passes through. */
function canonical(value: string): string {
  const map: Record<string, string> = {
    mit: "MIT",
    isc: "ISC",
    "apache-2.0": "Apache-2.0",
    "apache 2.0": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "bsd-2-clause": "BSD-2-Clause",
    "bsd-3-clause": "BSD-3-Clause",
    bsd: "BSD-3-Clause",
    "0bsd": "0BSD",
    unlicense: "Unlicense",
    "cc0-1.0": "CC0-1.0",
    "cc-by-4.0": "CC-BY-4.0",
    "blueoak-1.0.0": "BlueOak-1.0.0",
    "python-2.0": "Python-2.0",
    "mit-0": "MIT-0",
    zlib: "Zlib",
    wtfpl: "WTFPL",
  };
  return map[value.toLowerCase()] ?? value;
}

/**
 * The licence declared by a package's own installed manifest, read at the path the LOCKFILE gives.
 *
 * The lock key is the real on-disk location — `node_modules/a/node_modules/b` for a nested copy — so
 * using it rather than `node_modules/<name>` is what keeps a deduped package from being reported as
 * "not installed". That distinction matters here: "not installed" is supposed to mean an optional
 * native dependency this platform did not build, and a misclassified `iconv-lite` would make the
 * exemption list meaningless.
 */
function manifestLicence(lockPath: string): string | { type?: string } | { type?: string }[] | undefined {
  const manifest = path.join(process.cwd(), lockPath, "package.json");
  if (!existsSync(manifest)) return undefined;
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Manifest;
  return parsed.license ?? parsed.licenses;
}

const lock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
  packages?: Record<string, LockEntry>;
};

const findings: string[] = [];
const notInstalled: string[] = [];
const seen = new Set<string>();
let decided = 0;

for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
  // "" is the root project; `dev`/`devOptional` are the toolchain, which does not ship.
  if (lockPath === "" || entry.dev === true || entry.devOptional === true) continue;
  // A nested `node_modules/a/node_modules/b` entry is package `b`; only the last segment names it.
  const name = lockPath.split("node_modules/").pop();
  if (!name) continue;
  const key = `${name}@${entry.version ?? "?"}`;
  if (seen.has(key)) continue;
  seen.add(key);

  if (DECIDED.has(name)) {
    decided++;
    continue;
  }
  const licence = normalise(manifestLicence(lockPath));
  if (!licence) {
    if (!existsSync(path.join(process.cwd(), lockPath))) {
      notInstalled.push(key);
    } else {
      findings.push(`${key}: no licence field in its own manifest — read the package and decide`);
    }
    continue;
  }
  if (!ALLOWED.has(licence)) findings.push(`${key}: ${licence} is not on the allowlist`);
}

if (seen.size < 10) {
  console.error(`licence gate FAILED: only ${seen.size} packages resolved from package-lock.json`);
  process.exit(1);
}

if (findings.length > 0) {
  console.error(`licence gate FAILED — ${findings.length} finding(s):\n`);
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error(
    "\nRead the licence, decide deliberately, and either add the SPDX id to ALLOWED (with why it is" +
      " acceptable) or the package to DECIDED (with why it is exempt). Do not widen the list to make" +
      " this pass.",
  );
  process.exit(1);
}

console.log(
  `licence gate OK: ${seen.size} production packages checked against ${ALLOWED.size} permissive ` +
    `licences, ${decided} exempt by recorded decision` +
    (notInstalled.length > 0
      ? `\n  optional native dependencies not built on this platform, so not read here: ${notInstalled.join(", ")}`
      : ""),
);
