// The keys this BUILD trusts to sign a control-plane bootstrap envelope, and the URL it fetches one
// from.
//
// A BUILD CONSTANT, not configuration. The whole protection model of the bootstrap document is a
// signature checked against a set the binary already contains: if the set could be supplied at
// runtime, anything that can set an environment variable could point a production install at its own
// control plane, and the signature would prove nothing at all.
//
// SO THE ENVIRONMENT MAY ONLY ADD KEYS IN `local` AND `dev`, and that is asserted rather than
// assumed — see `bootstrap-client.test.ts`. A local build against emulators, a personal dev build
// and the tests need to supply their own fixture keys; `qa` and `prod` — the tiers other people
// enter — must refuse to, whatever is set (plan §3.2: "Zatvrdit qa i prod shodně"). Each of those two
// has its OWN compiled-in set, mirroring `app/lib/core/bootstrap/bootstrap_trust.dart`: QA keys are
// never the prod keys, and a build hardened for one tier holds nothing that verifies the other's
// envelope.
//
// PLAN §14 SUPPLIES THE REAL VALUES. The production and QA trust sets and bootstrap URLs are
// external activation inputs — a domain in a different failure domain from the Firebase project, two
// public keys per tier whose private halves live in an offline kit. Until they exist, a tier's trust
// set is empty and that build simply has no bootstrap: it uses the endpoints it was configured with,
// which is exactly today's behaviour. An empty set is honest; a placeholder key would be a key — and
// the release gate must not call such an artifact a verified QA/prod bootstrap.

import type { BootstrapEnvironment } from "./control-plane-bootstrap.js";

export interface BootstrapTrust {
  /** keyId -> raw 32-byte Ed25519 public key. */
  readonly keys: ReadonlyMap<string, Uint8Array>;
  /** Where an envelope is fetched from, or undefined when this build has no bootstrap. */
  readonly url?: string;
}

/**
 * The compiled-in production trust set.
 *
 * Empty until §14's external activation supplies it. Deliberately not read from the environment: see
 * the module header.
 */
const PRODUCTION_TRUST: {
  readonly keys: readonly { keyId: string; publicKeyBase64: string }[];
  readonly url?: string;
} = {
  keys: [],
};

/**
 * The compiled-in QA trust set — its own keys and its own URL, never prod's.
 *
 * Empty until §14's external activation supplies it, same as {@link PRODUCTION_TRUST}. QA is a tier
 * other people enter (plan §2 table: "Klíče a URL zabudované v buildu", same row as prod), so it gets
 * the same treatment as prod rather than falling through to the environment-configurable branch below.
 */
const QA_TRUST: {
  readonly keys: readonly { keyId: string; publicKeyBase64: string }[];
  readonly url?: string;
} = {
  keys: [],
};

/** The environment variables a `local` or `dev` build may configure a bootstrap with — see below. */
export const BOOTSTRAP_ENV_VARS = {
  url: "STRIDETERM_BOOTSTRAP_URL",
  /** `keyId=base64,keyId=base64`. Refused outright in a qa or prod build. */
  trustKeys: "STRIDETERM_BOOTSTRAP_TRUST_KEYS",
  /**
   * WHICH REMOTE ENVIRONMENT this desktop talks to: `local`, `dev`, `qa` or `prod`.
   *
   * THE ONE EXPLICIT SOURCE, and the whole of F11. Every party that has to agree about "which
   * environment am I" — the Firebase configuration, the bootstrap trust set and the auth broker —
   * reads {@link bootstrapEnvironmentFor}, and this variable is the first thing it consults.
   *
   * It exists because the previous answer was inferred from `STRIDETERM_DATA_DIR`, which is a
   * statement about where this installation keeps its FILES. Those are different questions with
   * different answers: `dev.ps1` sets the data directory to keep a developer's state out of the way,
   * and doing so silently declared the remote backend to be `dev` — so a desktop pointed at the
   * qa Firebase project still chose the dev broker and still sent `/start` with environment
   * `local`, which the qa Worker refuses. And `--data-dir`, which exists so somebody can run a
   * SECOND PRODUCTION instance with separate state, made that instance's sign-in unavailable.
   *
   * An unrecognised value is a REFUSAL rather than a guess — see the function. Nothing in this module
   * derives it from a project id, a data directory or a Git branch any more (plan §3.1): `main.ts`
   * sets a BUILD DEFAULT when it is unset at all — `prod` for a packaged install, `local` for an
   * unpackaged one — and `dev.ps1` sets it explicitly to `local` for the bare dev loop. By the time
   * this function runs, the variable is expected to already be set; an empty read is `"unresolved"`,
   * never a guess.
   */
  environment: "STRIDETERM_ENV",
} as const;

/**
 * Parses `keyId=base64,keyId=base64`, keeping only entries that are a real 32-byte Ed25519 key.
 *
 * A malformed entry is DROPPED rather than throwing: a wrong value in the environment must not stop
 * a desktop launching, and the consequence of dropping it — no bootstrap — is the safe direction.
 */
export function parseTrustKeys(value: string | undefined): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  for (const entry of (value ?? "").split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const keyId = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (!keyId || !encoded) continue;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(encoded, "base64");
    } catch {
      continue;
    }
    if (bytes.length !== 32) continue;
    keys.set(keyId, new Uint8Array(bytes));
  }
  return keys;
}

/** A compiled-in trust set, turned into the shape callers use. */
function compiledTrust(compiled: {
  readonly keys: readonly { keyId: string; publicKeyBase64: string }[];
  readonly url?: string;
}): BootstrapTrust {
  return {
    keys: new Map(
      compiled.keys.map((entry) => [entry.keyId, new Uint8Array(Buffer.from(entry.publicKeyBase64, "base64"))]),
    ),
    ...(compiled.url === undefined ? {} : { url: compiled.url }),
  };
}

/**
 * The trust set and URL for one environment.
 *
 * QA AND PROD IGNORE `env` ENTIRELY, each answering with its own compiled-in set. That is the
 * property the whole design rests on — a tier the operator doesn't fully control must not be
 * pointable at a different control plane by anything settable outside the build — and it is an
 * exhaustive branch rather than a condition sprinkled through the caller for exactly that reason.
 */
export function bootstrapTrustSet(environment: BootstrapEnvironment, env: NodeJS.ProcessEnv): BootstrapTrust {
  if (environment === "prod") return compiledTrust(PRODUCTION_TRUST);
  if (environment === "qa") return compiledTrust(QA_TRUST);
  const url = env[BOOTSTRAP_ENV_VARS.url]?.trim();
  return {
    keys: parseTrustKeys(env[BOOTSTRAP_ENV_VARS.trustKeys]),
    ...(url ? { url } : {}),
  };
}

/**
 * Which remote environment this desktop talks to. ONE answer, for every party that needs it.
 *
 * READS `STRIDETERM_ENV` AND NOTHING ELSE (plan §3.1). An UNRECOGNISED or absent value answers
 * `unresolved` rather than guessing — a typo like `stage`, or nothing set at all, must block a new
 * sign-in and say so, not quietly become `local` or `prod`. That is F11's "chybějící nebo rozporná
 * konfigurace zablokuje nové přihlášení, nepřepne na produkci", now generalised past just "production":
 * an unresolved declaration never silently becomes ANY of the four.
 *
 * WHO IS RESPONSIBLE FOR IT BEING SET, THEN — because a bare Electron launch has to end up with some
 * value before this function is asked. `dev.ps1` sets `STRIDETERM_ENV=local` explicitly for the bare
 * dev loop (plan §3.1's "holý vývojový launcher defaultuje na local"), and `main.ts` sets an explicit
 * BUILD DEFAULT — `prod` for a packaged install, `local` for an unpackaged one run any other way — as
 * a safety net when neither the operator nor `dev.ps1` named one. Both are declarations made by the
 * LAUNCHER, once, in one place; neither is a guess made HERE from a project id, a data directory or a
 * Git branch, which is the distinction plan §3.1 draws.
 *
 * WHAT IS NO LONGER CONSULTED, at all: a project id (was: `demo-` or no project → `dev`, `/staging/`
 * in the id → `staging`, else → `production` — the exact kind of derivation §3.1 forbids) and
 * `STRIDETERM_DATA_DIR` (F11's original finding — "Izolovaný data directory není informace o
 * vzdáleném backendu"; a separate directory says where this installation keeps its files and nothing
 * about which Firebase project it is configured with).
 *
 * AND WHERE THE SIGNED BOOTSTRAP SITS IN THAT ORDER: nowhere. It is DELIBERATELY not a second input,
 * and this is the precedence F11 asks to have defined. The envelope is CHECKED against this answer
 * rather than producing it — `bootstrap-client.ts` refuses one whose declared `environment` is not
 * this build's (`expectedEnvironment`) — because the envelope is fetched from a URL that the trust set
 * for one environment names, and letting the document choose which environment it is for would make
 * that check circular. So: the environment decides which trust set and which URL; the envelope then
 * decides the project, the database and the callable base within it.
 *
 * THIS IS NOT A NEW TRUST BOUNDARY, and it is worth saying plainly: anything that can set
 * `STRIDETERM_ENV` can already set `STRIDETERM_MOBILE_FIREBASE_PROJECT_ID` and the rest of the
 * Firebase configuration, and could already set `STRIDETERM_DATA_DIR`. What it buys is that the
 * declaration is visible instead of being a side effect of an unrelated one — and the things that
 * MUST NOT be settable from the environment still are not: the prod trust set is compiled in, and the
 * qa/prod broker origins are fixed in `authlink-config.ts`.
 */
export function bootstrapEnvironmentFor(env: NodeJS.ProcessEnv): BootstrapEnvironment | "unresolved" {
  const declared = env[BOOTSTRAP_ENV_VARS.environment]?.trim().toLowerCase();
  if (!declared) return "unresolved";
  if (declared === "local" || declared === "dev" || declared === "qa" || declared === "prod") return declared;
  return "unresolved";
}
