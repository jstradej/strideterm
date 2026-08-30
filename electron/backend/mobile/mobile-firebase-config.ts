/// <reference types="node" />
/**
 * Where the desktop's mobile control-plane client points, and how it is configured.
 *
 * Two rules from the review (§P0.2) shape this file:
 *
 *  - **"Production configuration must not be a compiled-in credential."** Nothing here has a
 *    default project, key or URL. Everything comes from the environment (or, for a packaged
 *    build, whatever populates the environment), and an unset configuration yields `null` rather
 *    than a fallback that quietly points somewhere.
 *  - **"Dev/emulator configuration via `FIREBASE_AUTH_EMULATOR_HOST`,
 *    `FIREBASE_DATABASE_EMULATOR_HOST` and the Functions emulator."** Those are the Firebase
 *    CLI's own variable names, so one `firebase emulators:start` and one `dev.ps1` agree without
 *    a second convention to remember.
 *
 * A Firebase *client* config (project id, web API key, database URL) is not a secret — it ships
 * inside every mobile app binary. What must never be here is an Admin/service-account credential,
 * and what must never be *persisted* here is the Auth session: the refresh token goes through the
 * existing `CredentialStore` (see mobile-firebase-rest.ts).
 */

import { databaseInstanceUrl, emulatorDatabaseUrl } from "./mobile-rtdb-paths.js";

export interface MobileFirebaseEmulatorHosts {
  /** `host:port` of the Auth emulator, or undefined to use production Identity Toolkit. */
  auth?: string;
  /** `host:port` of the RTDB emulator. */
  database?: string;
  /** `host:port` of the Functions emulator. */
  functions?: string;
}

export interface MobileFirebaseConfig {
  projectId: string;
  /** Firebase Web API key. Not a secret (it identifies the project, it does not authorise). */
  apiKey: string;
  /** Region every callable and RTDB trigger is deployed in. */
  functionsRegion: string;
  emulators: MobileFirebaseEmulatorHosts | null;
  /**
   * Explicit RTDB instance URL. Optional in the environment; when absent it is derived from
   * `projectId` + `functionsRegion` for production, or from the emulator host.
   */
  databaseUrl: string;
}

export const MOBILE_FIREBASE_ENV_VARS = {
  projectId: "STRIDETERM_MOBILE_FIREBASE_PROJECT_ID",
  apiKey: "STRIDETERM_MOBILE_FIREBASE_API_KEY",
  databaseUrl: "STRIDETERM_MOBILE_FIREBASE_DATABASE_URL",
  authEmulator: "FIREBASE_AUTH_EMULATOR_HOST",
  databaseEmulator: "FIREBASE_DATABASE_EMULATOR_HOST",
  functionsEmulator: "FIREBASE_FUNCTIONS_EMULATOR_HOST",
} as const;

/**
 * Thrown by the transport when it is asked to do anything before a configuration exists. Carries
 * the exact variable names an operator has to set, because "not configured" with no further
 * detail is the least useful error a headless process can log.
 */
export class MobileFirebaseNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `Mobile Firebase transport is not configured — set ${missing.join(", ")}. ` +
        `For local development against the Emulator Suite, set ${MOBILE_FIREBASE_ENV_VARS.projectId}=demo-<anything>, ` +
        `${MOBILE_FIREBASE_ENV_VARS.authEmulator}, ${MOBILE_FIREBASE_ENV_VARS.databaseEmulator} and ` +
        `${MOBILE_FIREBASE_ENV_VARS.functionsEmulator}.`,
    );
    this.name = "MobileFirebaseNotConfiguredError";
    this.missing = missing;
  }

  readonly missing: string[];
}

function normalizeHost(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  // The Firebase CLI exports these as bare `host:port`; tolerate a scheme if someone adds one.
  return trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * A `demo-` prefixed project id is the Firebase CLI's own convention for "emulators only, never
 * touches a real project" — the Auth emulator accepts any API key for one, so an operator running
 * against emulators does not have to invent a key.
 */
export function isDemoProject(projectId: string): boolean {
  return projectId.startsWith("demo-");
}

/**
 * Resolves the configuration from `env`, or returns `{ config: null, missing: [...] }` naming what
 * is absent. Never throws and never guesses: an unconfigured install is a normal state (Mobile is
 * off by default), and the transport turns `missing` into a
 * {@link MobileFirebaseNotConfiguredError} only when something actually tries to use it.
 */
export function resolveMobileFirebaseConfig(
  env: NodeJS.ProcessEnv,
  functionsRegion: string,
): { config: MobileFirebaseConfig | null; missing: string[] } {
  const projectId = env[MOBILE_FIREBASE_ENV_VARS.projectId]?.trim() || "";
  const emulators: MobileFirebaseEmulatorHosts = {
    auth: normalizeHost(env[MOBILE_FIREBASE_ENV_VARS.authEmulator]),
    database: normalizeHost(env[MOBILE_FIREBASE_ENV_VARS.databaseEmulator]),
    functions: normalizeHost(env[MOBILE_FIREBASE_ENV_VARS.functionsEmulator]),
  };
  const anyEmulator = Boolean(emulators.auth || emulators.database || emulators.functions);
  // Emulators accept any key; a demo project has no real key to use.
  const apiKey =
    env[MOBILE_FIREBASE_ENV_VARS.apiKey]?.trim() ||
    (anyEmulator || (projectId && isDemoProject(projectId)) ? "emulator-api-key" : "");

  const missing: string[] = [];
  if (!projectId) missing.push(MOBILE_FIREBASE_ENV_VARS.projectId);
  if (!apiKey) missing.push(MOBILE_FIREBASE_ENV_VARS.apiKey);
  if (missing.length > 0) return { config: null, missing };

  // Derived from the shared contract, never spelled out here — the Functions, the Flutter client
  // factory and this transport must address the same instance and the same namespace.
  const explicitDatabaseUrl = env[MOBILE_FIREBASE_ENV_VARS.databaseUrl]?.trim();
  const databaseUrl =
    explicitDatabaseUrl ||
    (emulators.database ? emulatorDatabaseUrl(emulators.database, projectId) : databaseInstanceUrl(projectId));

  return {
    config: {
      projectId,
      apiKey,
      functionsRegion,
      emulators: anyEmulator ? emulators : null,
      databaseUrl,
    },
    missing: [],
  };
}

/** Absolute URL of a callable, for this configuration. */
export function callableUrl(config: MobileFirebaseConfig, name: string): string {
  const emulatorHost = config.emulators?.functions;
  if (emulatorHost) {
    return `http://${emulatorHost}/${config.projectId}/${config.functionsRegion}/${name}`;
  }
  return `https://${config.functionsRegion}-${config.projectId}.cloudfunctions.net/${name}`;
}

/** Base URL of the Identity Toolkit (account) endpoints. */
export function identityToolkitUrl(config: MobileFirebaseConfig, method: string): string {
  const emulatorHost = config.emulators?.auth;
  const base = emulatorHost
    ? `http://${emulatorHost}/identitytoolkit.googleapis.com`
    : "https://identitytoolkit.googleapis.com";
  return `${base}/v1/accounts:${method}?key=${encodeURIComponent(config.apiKey)}`;
}

/** URL of the secure-token (refresh) endpoint. */
export function secureTokenUrl(config: MobileFirebaseConfig): string {
  const emulatorHost = config.emulators?.auth;
  const base = emulatorHost
    ? `http://${emulatorHost}/securetoken.googleapis.com`
    : "https://securetoken.googleapis.com";
  return `${base}/v1/token?key=${encodeURIComponent(config.apiKey)}`;
}

/**
 * URL for one RTDB path. The emulator wants `http://host:port/<path>.json?ns=<namespace>`; a real
 * instance wants `https://<instance>/<path>.json`. `databaseUrl` already carries whichever of the
 * two shapes applies (including the `?ns=` query), so this splits and recombines rather than
 * string-concatenating a second `?`.
 */
export function rtdbUrl(config: MobileFirebaseConfig, path: string, params: Record<string, string> = {}): string {
  const base = new URL(config.databaseUrl);
  const search = new URLSearchParams(base.search);
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  const cleanPath = path.replace(/^\/+/, "");
  base.pathname = `/${cleanPath}.json`;
  base.search = search.toString();
  return base.toString();
}
