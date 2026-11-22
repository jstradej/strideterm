#!/usr/bin/env node
/// <reference types="node" />
/**
 * audit-gate.mts — the blocking dependency audit for CI, the release build and the git hooks.
 *
 * Fails on every high or critical advisory `npm audit` reports, in shipped AND dev dependencies, except the
 * advisories named in ACCEPTED below. `npm audit` has no way to ignore one advisory, and the two switches it
 * does have are both wrong for a gate:
 *
 * - `--audit-level=high` blocks every pull request on an advisory nobody can upgrade away from;
 * - `--omit=dev` stops looking at the build tooling altogether, which is where a compromised package would
 *   run with the release pipeline's access.
 *
 * An accepted advisory is a recorded, time-boxed decision, not a filter:
 *
 * - it is named by its GHSA id, so the next advisory in the same package blocks again;
 * - it holds for dev dependencies only: the same advisory in a dependency the app ships always blocks;
 * - it ends on `expires`; past that date the gate fails until someone looks again and renews or removes it;
 * - an entry `npm audit` no longer reports is flagged, so the list does not outlive its reason.
 *
 * Usage: npx tsx scripts/audit-gate.mts
 */

import { execSync } from "node:child_process";

interface AcceptedAdvisory {
  id: string;
  package: string;
  /** Why it cannot be fixed and why that is tolerable here. */
  reason: string;
  /** ISO date (UTC). The gate fails from this day on. */
  expires: string;
}

const ACCEPTED: AcceptedAdvisory[] = [];

const BLOCKING = new Set(["high", "critical"]);

interface Advisory {
  id: string;
  package: string;
  severity: string;
  title: string;
  range: string;
}

interface AuditVia {
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
  range?: string;
}

interface AuditReport {
  vulnerabilities?: Record<string, { via?: Array<string | AuditVia> }>;
  message?: string;
  error?: { summary?: string };
}

function audit(args: string): Map<string, Advisory> {
  let stdout: string;
  try {
    stdout = execSync(`npm audit --json${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    // npm exits 1 when it found anything; the report is still on stdout.
    stdout = (err as { stdout?: string }).stdout ?? "";
  }
  let report: AuditReport;
  try {
    report = JSON.parse(stdout) as AuditReport;
  } catch {
    throw new Error(`npm audit${args} did not answer with a report.`);
  }
  if (!report.vulnerabilities) {
    const why = report.message || report.error?.summary || "no vulnerability list in the report";
    throw new Error(`npm audit${args} failed: ${why}`);
  }
  // A package's own severity also counts what it inherits from its dependencies; the advisories are the
  // objects in `via`. A string there only names the dependency the finding comes from.
  const advisories = new Map<string, Advisory>();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    for (const via of entry.via ?? []) {
      if (typeof via === "string" || !via.url) continue;
      const id = via.url.slice(via.url.lastIndexOf("/") + 1);
      advisories.set(`${id}|${via.name ?? name}`, {
        id,
        package: via.name ?? name,
        severity: via.severity ?? "unknown",
        title: via.title ?? "",
        range: via.range ?? "",
      });
    }
  }
  return advisories;
}

const describe = (a: Advisory) => `  ${a.severity.padEnd(8)} ${a.package} ${a.range}  ${a.id}\n           ${a.title}`;

let all: Map<string, Advisory>;
let shipped: Map<string, Advisory>;
try {
  all = audit("");
  shipped = audit(" --omit=dev");
} catch (err) {
  // No report is not a clean report.
  console.error(`audit-gate: ${(err as Error).message}`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const blocking: Advisory[] = [];
const accepted: Array<{ advisory: Advisory; entry: AcceptedAdvisory }> = [];
const problems: string[] = [];

for (const [key, advisory] of all) {
  if (!BLOCKING.has(advisory.severity)) continue;
  const entry = ACCEPTED.find((item) => item.id === advisory.id && item.package === advisory.package);
  if (!entry) {
    blocking.push(advisory);
  } else if (shipped.has(key)) {
    blocking.push(advisory);
    problems.push(`${advisory.id} is accepted for dev dependencies only, and ${advisory.package} is now shipped.`);
  } else if (today >= entry.expires) {
    blocking.push(advisory);
    problems.push(`The exception for ${advisory.id} (${advisory.package}) ended on ${entry.expires}. Check for a fix.`);
  } else {
    accepted.push({ advisory, entry });
  }
}

for (const { advisory, entry } of accepted) {
  console.log(`audit-gate: accepted until ${entry.expires} (dev dependencies only)\n${describe(advisory)}`);
  console.log(`           ${entry.reason}`);
}
for (const entry of ACCEPTED) {
  if (![...all.values()].some((a) => a.id === entry.id)) {
    const text = `${entry.id} (${entry.package}) is no longer reported. Remove it from ACCEPTED in scripts/audit-gate.mts.`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning title=audit-gate::${text}` : `audit-gate: ${text}`);
  }
}

if (blocking.length > 0) {
  console.error(`audit-gate: ${blocking.length} high or critical advisory(ies) block:`);
  for (const advisory of blocking) console.error(describe(advisory));
  for (const problem of problems) console.error(`audit-gate: ${problem}`);
  process.exit(1);
}
console.log(
  `audit-gate: no blocking advisory (${all.size} reported in total, ${shipped.size} in shipped dependencies).`,
);
