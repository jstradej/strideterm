#!/usr/bin/env node
/// <reference types="node" />
/**
 * check-package-age.mjs — reject recently-published npm packages.
 *
 * Compares the current package-lock.json against the last committed version.
 * For each new or changed dependency, queries the npm registry for its publish
 * date. Exits with code 1 if any package was published less than
 * MIN_AGE_DAYS days ago.
 *
 * Usage:
 *   node scripts/check-package-age.mjs [--min-age-days=N] [--allow=pkg@version,...]
 *
 * The --allow flag lets you bypass the age check for specific packages
 * (e.g., when updating a dependency specifically to fix a CVE).
 *
 * Why: a newly-compromised package won't have a CVE yet — npm audit can't
 * catch it. But the malicious version will have been published very recently.
 * Adding a minimum age quarantine catches this class of supply chain attack.
 */

import { execSync } from "node:child_process";
import { readFileSync, accessSync } from "node:fs";
import { join } from "node:path";

const MIN_AGE_DAYS = parseInt(process.argv.find((a) => a.startsWith("--min-age-days="))?.split("=")[1] || "1", 10);
const MIN_AGE_MS = MIN_AGE_DAYS * 24 * 60 * 60 * 1000;

// --allow=pkg@version,pkg2@version — bypass for intentional security updates
const allowArg =
  process.argv
    .find((a) => a.startsWith("--allow="))
    ?.split("=")
    .slice(1)
    .join("=") || "";
const allowSet = new Set(allowArg.split(",").filter(Boolean));

const cwd = process.cwd();

// --- Check if lockfile exists and is dirty ---

try {
  accessSync(join(cwd, "package-lock.json"));
} catch {
  // No lockfile — nothing to check
  process.exit(0);
}

const dirty = ["HEAD --", "--cached --"].some((ref) => {
  try {
    return execSync(`git diff --name-only ${ref} package-lock.json`, { cwd, encoding: "utf8" })
      .trim()
      .includes("package-lock.json");
  } catch {
    return false;
  }
});

if (!dirty) {
  // Lockfile unchanged — nothing to check
  process.exit(0);
}

// --- Find changed packages ---

interface LockPackage {
  version?: string;
}

interface LockFile {
  packages?: Record<string, LockPackage>;
}

let oldLock: LockFile;
try {
  oldLock = JSON.parse(execSync("git show HEAD:package-lock.json", { cwd, encoding: "utf8" })) as LockFile;
} catch {
  // No prior lockfile (first install) — skip
  console.log("No prior lockfile in git — skipping age check.");
  process.exit(0);
}

const newLock = JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8")) as LockFile;

const changed: Array<{ name: string; version: string }> = [];
for (const [pkgPath, pkg] of Object.entries(newLock.packages || {})) {
  if (!pkgPath || pkgPath === "") continue;
  const oldPkg = oldLock.packages?.[pkgPath];
  if (!oldPkg || oldPkg.version !== pkg.version) {
    const name = pkgPath.replace(/^.*node_modules\//, "");
    if (name && pkg.version) changed.push({ name, version: pkg.version });
  }
}

if (changed.length === 0) {
  console.log("Lockfile changed but no package versions differ.");
  process.exit(0);
}

console.log(`Checking publish age of ${changed.length} changed package(s)...`);

// --- Query publish dates ---

async function getPublishDate(name: string, version: string): Promise<Date | null> {
  // npm view — respects .npmrc, private registries
  try {
    const out = execSync(`npm view "${name}" time --json`, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeObj = JSON.parse(out) as Record<string, string>;
    if (typeof timeObj === "object" && timeObj[version]) {
      return new Date(timeObj[version]);
    }
  } catch {
    // Fallback to direct registry fetch
  }

  try {
    const encoded = name.replace("/", "%2F");
    const resp = await fetch(`https://registry.npmjs.org/${encoded}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { time?: Record<string, string> };
      if (data.time?.[version]) return new Date(data.time[version]);
    }
  } catch {
    // Could not determine
  }

  return null;
}

const now = Date.now();
const tooNew: Array<{ name: string; version: string; ageDays: number; published: string }> = [];

// Process in batches of 5 to avoid hammering the registry
for (let i = 0; i < changed.length; i += 5) {
  const batch = changed.slice(i, i + 5);
  const results = await Promise.allSettled(
    batch.map(async ({ name, version }) => {
      const pubDate = await getPublishDate(name, version);
      if (!pubDate) return;
      const ageMs = now - pubDate.getTime();
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      if (ageMs < MIN_AGE_MS) {
        tooNew.push({ name, version, ageDays, published: pubDate.toISOString().slice(0, 10) });
      }
    }),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`  Warning: could not check one package: ${r.reason?.message}`);
    }
  }
}

// --- Report ---

// Filter out explicitly allowed packages
const blocked = tooNew.filter((p) => !allowSet.has(`${p.name}@${p.version}`));
const skipped = tooNew.length - blocked.length;
if (skipped > 0) {
  console.log(`  ${skipped} package(s) allowed via --allow flag.`);
}

if (blocked.length === 0) {
  console.log(`All ${changed.length} changed package(s) are >${MIN_AGE_DAYS} days old (or allowed). OK.`);
  process.exit(0);
}

console.error(`\nFAILED: ${blocked.length} package(s) published less than ${MIN_AGE_DAYS} days ago:\n`);
for (const p of blocked) {
  console.error(`  ${p.name}@${p.version} — published ${p.published} (${p.ageDays}d ago)`);
}
console.error(
  `\nUse older versions or wait ${MIN_AGE_DAYS} days. This prevents supply chain attacks via newly-compromised packages.` +
    `\nTo allow a specific package (e.g., for a CVE fix), use: --allow=${blocked.map((p) => `${p.name}@${p.version}`).join(",")}`,
);
process.exit(1);
