#!/usr/bin/env node
/// <reference types="node" />
/**
 * check-mobile-schema-drift.mts — structural drift check between this repo's hand-authored
 * mirrors of the mobile protocol and the generated originals in the sibling `strideterm-mobile`
 * monorepo. Four mirrors are covered:
 *
 *   1. electron/backend/mobile/mobile-schemas.ts   vs. protocol/typescript/src/generated/index.ts
 *   2. electron/backend/mobile/mobile-rtdb-paths.ts vs. protocol/typescript/src/generated/rtdb-paths.ts
 *      (the canonical RTDB layout + Functions region — a drifted path here means a write the
 *      Security Rules silently reject, which is exactly the class of bug the path contract exists
 *      to prevent)
 *   3. electron/backend/mobile/mobile-aad-vectors.json vs. protocol/test-vectors/envelope-aad.json
 *      (the shared canonical-AAD fixtures; the desktop's own tests read the copy so they stay
 *      hermetic, and this check is what stops the copy going stale)
 *   4. electron/backend/mobile/mobile-pairing-vectors.json vs.
 *      protocol/test-vectors/pairing-transcript.json (the shared fingerprint/SAS fixtures — the
 *      values a human compares across two screens, so all three implementations must derive them
 *      from byte-identical transcripts)
 *
 * Why this exists: mobile-schemas.ts is a hand-authored, field-for-field copy of the generated
 * protocol package (see the comment at the top of that file) — this repo cannot import
 * strideterm-mobile's source via a relative path across the two checkouts (plan §3.2), and no
 * published `@strideterm/mobile-protocol` registry package exists yet for it to depend on instead
 * (see strideterm-mobile/docs/adr/0005-protocol-mirror-drift-check.md: full registry consumption
 * is deferred; this script is the interim safety net, not a substitute for it). Nothing keeps the
 * two files in sync automatically otherwise, so this script:
 *   1. locates the sibling strideterm-mobile checkout (see findSiblingRepo below),
 *   2. imports both mobile-schemas.ts and the generated protocol package's index,
 *   3. for every schema exported by both, serializes it with zod's built-in `z.toJSONSchema()`
 *      and deep-compares the result — a structural fingerprint (field names, types,
 *      required-ness, enum members, literal discriminants) independent of hand-authored vs.
 *      generated formatting/ordering — and
 *   4. compares the hand-copied `limits.ts` numeric constants for exact equality,
 * then exits non-zero with a readable diff on any mismatch. It also flags an export present on
 * only one side (an added/renamed/removed schema) as drift, except for mobile-schemas.ts's
 * documented "local-only additions" (no protocol-package equivalent by design).
 *
 * If the sibling repo cannot be found, this fails loudly rather than silently passing — a missing
 * sibling checkout means the check genuinely did not run, and a safety net that silently no-ops
 * isn't one. Set STRIDETERM_MOBILE_REPO to override the auto-detected path.
 *
 * NOT wired into .github/workflows/ci.yml — deliberately, not an oversight. strideterm-mobile is
 * local-git-only with no remote (confirmed repeatedly: `git remote -v` there returns nothing), so
 * a hosted CI runner checking out only this (`strideterm`) repo has no way to obtain a sibling
 * strideterm-mobile checkout for this script to find — it would fail every single run with
 * "Could not find a sibling checkout", not catch real drift. Wiring this into ci.yml is blocked on
 * strideterm-mobile getting a real remote (see that repo's docs/PHASE0-LIMITATIONS.md, item 62) —
 * once it does, add a second `actions/checkout` step for it (or a multi-repo checkout action) to
 * ci.yml and add this script as a step. Until then, this is a manually-run local safety net only.
 *
 * Usage: npm run check:mobile-schema-drift
 */
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-schemas.ts");
const PATHS_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-rtdb-paths.ts");
const AAD_VECTORS_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-aad-vectors.json");
const PAIRING_VECTORS_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-pairing-vectors.json");
const RELAY_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-relay-protocol.ts");
const RELAY_VECTORS_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-relay-vectors.json");
const BOOTSTRAP_VECTORS_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-bootstrap-vectors.json");
// Relay end-to-end encryption (plan 2026-09-23): its constants mirror into mobile-crypto.ts rather
// than mobile-schemas.ts, same reasoning as the relay transport contract living in
// mobile-relay-protocol.ts — a distinct contract with a distinct owner.
const RELAY_E2E_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-crypto.ts");
const RELAY_E2E_VECTORS_MIRROR_PATH = path.join(REPO_ROOT, "electron/backend/mobile/mobile-relay-e2e-vectors.json");

// Exports in mobile-schemas.ts that are deliberately local-only (no protocol-package equivalent
// — see the "Local-only additions" section at the bottom of that file). Excluded from comparison
// in both directions.
const LOCAL_ONLY_EXPORTS = new Set([
  "MobileNotificationFilterSchema",
  "MobileDeviceRecordSchema",
  "MobileIntegrationSettingsSchema",
  // The relay flag is a desktop SETTING, not a wire type: the protocol package has nothing to
  // compare it against, because no phone and no Cloud Function ever reads it.
  "MobileRelaySettingsSchema",
]);

function findSiblingRepo(): string {
  const override = process.env.STRIDETERM_MOBILE_REPO;
  const relIndex = "protocol/typescript/src/generated/index.ts";
  if (override) {
    if (!existsSync(path.join(override, relIndex))) {
      throw new Error(
        `STRIDETERM_MOBILE_REPO=${override} does not look like the strideterm-mobile repo ` + `(missing ${relIndex}).`,
      );
    }
    return override;
  }
  // Walk up from this script's own directory looking for a `strideterm-mobile` sibling at any
  // ancestor level. This covers both a plain sibling-checkout layout (…/strideterm and
  // …/strideterm-mobile side by side) and a nested git-worktree checkout of this repo (where the
  // working directory sits several levels below the actual sibling-of-checkout level).
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "strideterm-mobile");
    if (existsSync(path.join(candidate, relIndex))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not find a sibling "strideterm-mobile" checkout (searched ancestors of ${__dirname}). ` +
      "Set STRIDETERM_MOBILE_REPO to its path to run this check.",
  );
}

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" && value !== null && typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

interface Mismatch {
  name: string;
  detail: string;
}

async function main(): Promise<void> {
  const siblingRepo = findSiblingRepo();
  const generatedIndexPath = path.join(siblingRepo, "protocol/typescript/src/generated/index.ts");

  const generatedPathsPath = path.join(siblingRepo, "protocol/typescript/src/generated/rtdb-paths.ts");
  // The relay transport is its own mirror (mobile-relay-protocol.ts) for the same reason the RTDB
  // path contract is: it is a distinct contract with a distinct owner, and folding it into
  // mobile-schemas.ts would make one very large file that changes for two unrelated reasons.
  const generatedRelayLimitsPath = path.join(siblingRepo, "protocol/typescript/src/generated/relay-limits.ts");
  const generatedRelayFramesPath = path.join(siblingRepo, "protocol/typescript/src/relay/frames.ts");
  const generatedRelayE2ePath = path.join(siblingRepo, "protocol/typescript/src/generated/relay-e2e.ts");
  // Two generated modules the desktop deliberately does NOT mirror. The operator API is the
  // IAM-only support/recovery surface — its consumers are cloud/functions and the private
  // `strideterm-ops` CLI, which generates its own client from the same schemas — and the backup
  // manifest is written and verified by scheduled internal jobs. Mirroring either here would put a
  // support-tooling contract inside a shipped desktop binary and give it a second place to drift.
  // Excluded by MODULE rather than by a hand-written name list, so adding a type to one of them
  // does not quietly become a desktop obligation.
  const generatedOperatorApiPath = path.join(siblingRepo, "protocol/typescript/src/generated/operator-api.ts");
  const generatedBackupManifestPath = path.join(siblingRepo, "protocol/typescript/src/generated/backup-manifest.ts");

  const [
    mirror,
    generated,
    pathsMirror,
    generatedPaths,
    relayMirror,
    generatedRelayLimits,
    generatedRelayFrames,
    generatedOperatorApi,
    generatedBackupManifest,
    relayE2eMirror,
    generatedRelayE2e,
  ] = await Promise.all([
    import(pathToFileURL(MIRROR_PATH).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(generatedIndexPath).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(PATHS_MIRROR_PATH).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(generatedPathsPath).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(RELAY_MIRROR_PATH).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(generatedRelayLimitsPath).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(generatedRelayFramesPath).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(generatedOperatorApiPath).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(generatedBackupManifestPath).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(RELAY_E2E_MIRROR_PATH).href) as Promise<Record<string, unknown>>,
    import(pathToFileURL(generatedRelayE2ePath).href) as Promise<Record<string, unknown>>,
  ]);

  // The generated index re-exports the path contract too, but that is a *different* mirror in
  // this repo (mobile-rtdb-paths.ts, checked below) — excluded here so it isn't also reported as
  // missing from mobile-schemas.ts.
  const PATH_CONTRACT_EXPORTS = new Set(Object.keys(generatedPaths));
  // Same exclusion, same reason, for the relay transport contract.
  const RELAY_CONTRACT_EXPORTS = new Set(Object.keys(generatedRelayLimits));
  // Same exclusion again, for the relay end-to-end crypto contract (mirrored into mobile-crypto.ts).
  const RELAY_E2E_CONTRACT_EXPORTS = new Set(Object.keys(generatedRelayE2e));
  // The server-only surfaces. See the comment where these modules are located above.
  const SERVER_ONLY_EXPORTS = new Set([...Object.keys(generatedOperatorApi), ...Object.keys(generatedBackupManifest)]);

  const mirrorKeys = new Set(Object.keys(mirror).filter((k) => !LOCAL_ONLY_EXPORTS.has(k)));
  const generatedKeys = new Set(
    Object.keys(generated).filter(
      (k) =>
        !PATH_CONTRACT_EXPORTS.has(k) &&
        !RELAY_CONTRACT_EXPORTS.has(k) &&
        !RELAY_E2E_CONTRACT_EXPORTS.has(k) &&
        !SERVER_ONLY_EXPORTS.has(k),
    ),
  );

  const mismatches: Mismatch[] = [];

  for (const name of mirrorKeys) {
    if (!generatedKeys.has(name)) {
      mismatches.push({
        name,
        detail: `exported by mobile-schemas.ts but not found in the generated protocol package (renamed, removed, or missing from LOCAL_ONLY_EXPORTS in this script).`,
      });
    }
  }
  for (const name of generatedKeys) {
    if (!mirrorKeys.has(name)) {
      mismatches.push({
        name,
        detail: `exported by the generated protocol package but not mirrored in mobile-schemas.ts.`,
      });
    }
  }

  let comparedSchemas = 0;
  let comparedConstants = 0;

  for (const name of mirrorKeys) {
    if (!generatedKeys.has(name)) continue; // already reported above
    const mirrorValue = mirror[name];
    const generatedValue = generated[name];

    if (isZodSchema(mirrorValue) && isZodSchema(generatedValue)) {
      comparedSchemas++;
      try {
        assert.deepStrictEqual(z.toJSONSchema(mirrorValue), z.toJSONSchema(generatedValue));
      } catch (err) {
        mismatches.push({
          name,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // Numeric limits and string constants (e.g. SESSION_KEY_HKDF_INFO) alike: an exact-equality
    // comparison is the whole check, and a mismatched string is exactly as fatal as a mismatched
    // number — a differing HKDF info silently breaks every decrypt on both sides.
    if (
      (typeof mirrorValue === "number" && typeof generatedValue === "number") ||
      (typeof mirrorValue === "string" && typeof generatedValue === "string")
    ) {
      comparedConstants++;
      if (mirrorValue !== generatedValue) {
        mismatches.push({
          name,
          detail: `mobile-schemas.ts has ${JSON.stringify(mirrorValue)}, generated package has ${JSON.stringify(generatedValue)}.`,
        });
      }
      continue;
    }

    // A generated helper function (e.g. sessionKeySalt) — compare what it produces for a
    // placeholder input, the same technique the path-contract comparison below uses.
    if (typeof mirrorValue === "function" && typeof generatedValue === "function") {
      comparedConstants++;
      const args = ["{a}", "{b}", "{c}"].slice(0, (generatedValue as (...a: unknown[]) => unknown).length);
      const mirrorOut = String((mirrorValue as (...a: unknown[]) => unknown)(...args));
      const generatedOut = String((generatedValue as (...a: unknown[]) => unknown)(...args));
      if (mirrorOut !== generatedOut) {
        mismatches.push({
          name,
          detail: `mobile-schemas.ts produces ${JSON.stringify(mirrorOut)}, generated package produces ${JSON.stringify(generatedOut)}.`,
        });
      }
      continue;
    }

    mismatches.push({
      name,
      detail: `type mismatch — mirror is ${typeof mirrorValue}, generated is ${typeof generatedValue}.`,
    });
  }

  // --- 2. RTDB path contract mirror ----------------------------------------
  // Placeholder arguments, so each builder's output can be compared as a template rather than by
  // reading the two implementations side by side.
  // Four, not three: `accountMobileDevicePairPath` takes four segments, and a slice shorter than
  // the arity leaves the last parameter unsubstituted on BOTH sides — so the comparison would agree
  // about a segment neither side had filled in.
  const PLACEHOLDERS = ["{a}", "{b}", "{c}", "{d}"];
  let comparedPaths = 0;
  for (const [name, generatedValue] of Object.entries(generatedPaths)) {
    if (name === "RTDB_PATH_TEMPLATES") {
      // Compared implicitly through the builders below; the desktop mirror does not carry the
      // trigger-template table (it declares no RTDB triggers).
      continue;
    }
    if (name === "RTDB_BRANCH_CLASSIFICATION" || name === "RECOVERY_MINIMUM_ALLOWLIST") {
      // The authority/retention table and the backup allowlist derived from it. Consumed by
      // cloud/functions' cleanup sweep, the recovery jobs and the ops CLI — never by a desktop,
      // which neither backs anything up nor sweeps anything. Mirroring it here would put a backup
      // policy inside a shipped desktop binary and give it a second place to drift.
      //
      // It is not left unchecked: `protocol/codegen/generate.mjs` refuses to emit a branch that
      // does not declare both, and `protocol/typescript/test/rtdb-classification.test.ts` pins the
      // closed sets and the allowlist against the manifest.
      continue;
    }
    const mirrorValue = pathsMirror[name];
    if (mirrorValue === undefined) {
      mismatches.push({
        name: `rtdb-paths:${name}`,
        detail: "exported by the generated path contract but missing from mobile-rtdb-paths.ts.",
      });
      continue;
    }
    if (typeof generatedValue === "function" && typeof mirrorValue === "function") {
      comparedPaths++;
      const arity = (generatedValue as (...args: unknown[]) => string).length;
      const args = PLACEHOLDERS.slice(0, arity);
      const generatedOut = (generatedValue as (...args: unknown[]) => string)(...args);
      const mirrorOut = (mirrorValue as (...args: unknown[]) => string)(...args);
      if (generatedOut !== mirrorOut) {
        mismatches.push({
          name: `rtdb-paths:${name}`,
          detail: `mobile-rtdb-paths.ts builds "${mirrorOut}", the generated contract builds "${generatedOut}".`,
        });
      }
      continue;
    }
    if (generatedValue !== mirrorValue) {
      comparedPaths++;
      mismatches.push({
        name: `rtdb-paths:${name}`,
        detail: `mobile-rtdb-paths.ts has ${JSON.stringify(mirrorValue)}, the generated contract has ${JSON.stringify(generatedValue)}.`,
      });
    } else {
      comparedPaths++;
    }
  }

  // --- 3. Relay transport contract mirror ----------------------------------
  // Three things have to agree, and each of them is one a divergence would break silently: every
  // numeric limit (a smaller frame bound on one side means valid traffic refused), the per-frame
  // field/direction rules (a field one side requires and the other omits is a refused frame), and
  // the three closed vocabularies (a reason one side can send and the other cannot parse).
  let comparedRelay = 0;
  for (const [name, generatedValue] of Object.entries(generatedRelayLimits)) {
    const mirrorValue = relayMirror[name];
    comparedRelay++;
    if (mirrorValue === undefined) {
      mismatches.push({
        name: `relay:${name}`,
        detail: "declared by the generated relay limits but missing from mobile-relay-protocol.ts.",
      });
    } else if (mirrorValue !== generatedValue) {
      mismatches.push({
        name: `relay:${name}`,
        detail: `mobile-relay-protocol.ts has ${JSON.stringify(mirrorValue)}, the generated contract has ${JSON.stringify(generatedValue)}.`,
      });
    }
  }
  for (const table of [
    "RELAY_FRAME_RULES",
    "RELAY_ROLES",
    "RELAY_HTTP_METHODS",
    "RELAY_REASONS",
    "RELAY_FRAME_ALWAYS_FIELDS",
  ]) {
    comparedRelay++;
    try {
      assert.deepStrictEqual(relayMirror[table], generatedRelayFrames[table]);
    } catch (err) {
      mismatches.push({
        name: `relay:${table}`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- 3b. Relay end-to-end encryption contract mirror ---------------------
  // Every constant here feeds either a key derivation (a wrong byte count silently truncates or
  // mis-splits the HKDF output) or the nonce layout (a wrong reserved/counter split changes what
  // bytes get authenticated) — a mismatch is not cosmetic, it is a desktop and phone that derive
  // different keys or disagree about how to read the same nonce.
  for (const [name, generatedValue] of Object.entries(generatedRelayE2e)) {
    comparedRelay++;
    const mirrorValue = relayE2eMirror[name];
    if (mirrorValue === undefined) {
      mismatches.push({
        name: `relay-e2e:${name}`,
        detail: "declared by the generated relay-e2e contract but missing from mobile-crypto.ts.",
      });
    } else if (mirrorValue !== generatedValue) {
      mismatches.push({
        name: `relay-e2e:${name}`,
        detail: `mobile-crypto.ts has ${JSON.stringify(mirrorValue)}, the generated contract has ${JSON.stringify(generatedValue)}.`,
      });
    }
  }

  // --- 4. Canonical-AAD, pairing-transcript and relay-grant fixtures --------
  // Compare content, not line endings: this repo checks out CRLF on Windows and the sibling may
  // not, which would otherwise report drift on every line of an identical file.
  const normalizeEol = (text: string) =>
    text.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
  const fixtureMirrors: { mirror: string; original: string; name: string }[] = [
    {
      mirror: AAD_VECTORS_MIRROR_PATH,
      original: path.join(siblingRepo, "protocol/test-vectors/envelope-aad.json"),
      name: "envelope-aad.json",
    },
    {
      mirror: PAIRING_VECTORS_MIRROR_PATH,
      original: path.join(siblingRepo, "protocol/test-vectors/pairing-transcript.json"),
      name: "pairing-transcript.json",
    },
    {
      mirror: RELAY_VECTORS_MIRROR_PATH,
      original: path.join(siblingRepo, "protocol/test-vectors/relay-grants.json"),
      name: "relay-grants.json",
    },
    {
      mirror: RELAY_E2E_VECTORS_MIRROR_PATH,
      original: path.join(siblingRepo, "protocol/test-vectors/relay-e2e.json"),
      name: "relay-e2e.json",
    },
    {
      // The sharpest of the four. This desktop, the Flutter app and `strideterm-ops
      // recovery bootstrap-verify` each implement the bootstrap rules separately, and the last of
      // those exists so an operator can learn BEFORE publishing whether the released clients will
      // accept an envelope. A copy that had gone stale here would let this desktop drift from the
      // answer that tool gives, and it would be discovered during a recovery.
      mirror: BOOTSTRAP_VECTORS_MIRROR_PATH,
      original: path.join(siblingRepo, "protocol/test-vectors/control-plane-bootstrap.json"),
      name: "control-plane-bootstrap.json",
    },
  ];
  for (const fixture of fixtureMirrors) {
    if (normalizeEol(readFileSync(fixture.mirror, "utf8")) !== normalizeEol(readFileSync(fixture.original, "utf8"))) {
      mismatches.push({
        name: fixture.name,
        detail:
          `the desktop copy differs from ${fixture.original}. ` +
          "Re-copy it (the desktop's own crypto tests read the copy so they stay hermetic).",
      });
    }
  }

  if (mismatches.length > 0) {
    console.error(
      `FAILED: ${mismatches.length} drift finding(s) between mobile-schemas.ts and the generated protocol package:\n`,
    );
    for (const m of mismatches) {
      console.error(`  ${m.name}:\n    ${m.detail}\n`);
    }
    console.error(
      `mobile-schemas.ts:      ${MIRROR_PATH}\n` +
        `generated package:      ${generatedIndexPath}\n\n` +
        "Re-copy the changed field(s)/value(s) by hand into mobile-schemas.ts to fix this.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `OK: mirrors match the generated protocol package — ${comparedSchemas} schema(s), ` +
      `${comparedConstants} constant(s), ${comparedPaths} path-contract export(s), ` +
      `${comparedRelay} relay transport contract item(s) and the canonical fixtures compared, no drift.`,
  );
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
