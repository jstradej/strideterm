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

import { BOOTSTRAP_ENV_VARS, bootstrapEnvironmentFor } from "./bootstrap-trust.js";
import { databaseInstanceUrl, databaseNamespace, emulatorDatabaseUrl } from "./mobile-rtdb-paths.js";

/**
 * The COMPLETE local Emulator Suite, or nothing. Every field is required on purpose (follow-up
 * 2026-09-11, item 1): the fields used to be optional, and each URL helper below filled a missing one
 * in with the cloud endpoint — `identitytoolkit.googleapis.com` for an absent Auth host, the
 * `cloudfunctions.net` domain for an absent Functions host. A `local` build with two of the three
 * variables set therefore did two thirds of its work on this machine and sent the rest to Google. The
 * resolver now refuses a partial set before any of this is built, so a config that carries this object
 * carries all three validated loopback endpoints, and a config that does not carries none.
 */
export interface MobileFirebaseEmulatorHosts {
  /** Validated `host:port` of the Auth emulator. */
  auth: string;
  /** Validated `host:port` of the RTDB emulator. */
  database: string;
  /** Validated `host:port` of the Functions emulator. */
  functions: string;
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
  /**
   * Explicit callable base URL, from the SIGNED bootstrap envelope.
   *
   * Absent for a build configured from the environment, where the URL is derived from the region and
   * the project id exactly as before. Present when an envelope is in force — and then it wins, which
   * is the whole point: a recovery may put the callables behind a different domain, and a client that
   * derived the URL anyway would follow the envelope's database and ignore its functions.
   */
  functionsBaseUrl?: string;
  /** The managed relay's origin, from the same envelope. Compared for exact equality by every grant. */
  relayOrigin?: string;
  /**
   * The EXACT hostnames a checkout or portal URL may point at.
   *
   * From the signed envelope, because that is the only environment-scoped signed statement this
   * process has about which merchant it uses. Empty means the desktop opens no billing URL at all —
   * see `account/billing-url.ts` for why that is the right default rather than "open anything".
   */
  billingCheckoutHosts?: readonly string[];
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
  constructor(missing: string[], refusal?: MobileFirebaseConfigRefusal | null) {
    super(
      refusal
        ? `Mobile Firebase transport is refused — ${refusal.detail}`
        : `Mobile Firebase transport is not configured — set ${missing.join(", ")}. ` +
            `For local development against the Emulator Suite, set ${MOBILE_FIREBASE_ENV_VARS.projectId}=demo-<anything>, ` +
            `${MOBILE_FIREBASE_ENV_VARS.authEmulator}, ${MOBILE_FIREBASE_ENV_VARS.databaseEmulator} and ` +
            `${MOBILE_FIREBASE_ENV_VARS.functionsEmulator}.`,
    );
    this.name = "MobileFirebaseNotConfiguredError";
    this.missing = missing;
    this.refusal = refusal ?? null;
  }

  readonly missing: string[];
  /** Why a COMPLETE configuration was refused, when that is what happened. */
  readonly refusal: MobileFirebaseConfigRefusal | null;
}

/**
 * A configuration that is complete and CONTRADICTORY, refused rather than partially honoured (R06),
 * OR one this data directory's environment binding refuses (plan §3.3).
 *
 * `"environment-contradiction"`: the declared environment says dev/qa/prod; the environment also
 * names an emulator host, or a plain-HTTP database URL. The old resolver dropped the emulator hosts
 * silently and kept the database URL, so the process could end up with its database on a loopback
 * emulator and its identity calls and callables in the cloud — a mixed target nobody chose. A build
 * that cannot say which backend it talks to must not talk to any of them; the refusal carries exactly
 * which variables disagree, so the fix is one line rather than a search.
 *
 * `"environment-mismatch"`: this data directory was already bound to a DIFFERENT environment (see
 * `data-dir-environment.ts`) — a `local → dev` switch over the same directory, or the reverse. Never
 * partially honoured either: a data directory holds one environment's bootstrap epoch floor and one
 * environment's mobile Auth refresh token, and continuing here would risk handing either to the newly
 * declared environment.
 */
export interface MobileFirebaseConfigRefusal {
  /**
   * `"local-endpoint-invalid"` (follow-up 2026-09-11, item 1): the environment is `local` and one of
   * its endpoints is not a validated loopback target — a LAN or lookalike hostname, an `https://`
   * scheme, credentials or a path in the value, a port outside 1–65535, or a database URL that
   * names a different host or a different namespace than the declared demo project. `local` means
   * "nothing leaves this machine", and an address on the LAN is not this machine.
   */
  readonly reason: "environment-contradiction" | "environment-mismatch" | "local-endpoint-invalid";
  /** The declared environment and the variables that contradict it, or the two environments in
   * conflict. Names, never values. */
  readonly detail: string;
}

/**
 * The hostnames a `local` endpoint may name, EXACTLY (plan §2.2: "Na hostiteli povolit jen ověřené
 * loopback adresy"). This is the desktop, i.e. the host machine itself, so the Android emulator's
 * `10.0.2.2` host alias is deliberately absent — from here it is a routable address like any other.
 * `new URL()` lower-cases the hostname and renders IPv6 in brackets, so the set is matched after
 * parsing, and `127.1` / `0x7f000001` normalise to `127.0.0.1` rather than slipping past as spelled.
 */
const LOCAL_EMULATOR_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `{ host }` is the validated bare `hostname:port`; `{ problem }` says what was wrong, without the value. */
export type LocalEndpointCheck = { host: string; problem?: undefined } | { host?: undefined; problem: string };

/**
 * Validates one emulator `host:port` for a `local` build.
 *
 * The Firebase CLI exports these as bare `host:port`; an `http://` scheme and a trailing slash are
 * tolerated because people paste them, and NOTHING else is: no `https://` (an emulator does not
 * speak it, and a value that does is a cloud URL), no credentials, no path, no query, no fragment,
 * and a hostname that is one of {@link LOCAL_EMULATOR_HOSTNAMES} after parsing — `127.0.0.1.evil.example`
 * or `localhost.example` are lookalikes, not loopback. The port is mandatory (the CLI always
 * exports one) and must be a real TCP port.
 */
export function validateLocalEmulatorHost(raw: string | undefined): LocalEndpointCheck {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { problem: "is empty" };
  if (/^https:\/\//i.test(trimmed)) return { problem: "uses https://, which no emulator serves" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^http:\/\//i.test(trimmed)) {
    return { problem: "uses a scheme other than http://" };
  }
  const bare = trimmed.replace(/^http:\/\//i, "").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`http://${bare}`);
  } catch {
    return { problem: "is not a host:port" };
  }
  if (url.username || url.password) return { problem: "carries credentials" };
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { problem: "carries a path, query or fragment" };
  }
  if (!LOCAL_EMULATOR_HOSTNAMES.has(url.hostname)) {
    return { problem: `names a host that is not loopback (allowed: ${[...LOCAL_EMULATOR_HOSTNAMES].join(", ")})` };
  }
  if (!url.port) return { problem: "has no port" };
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: "has a port outside 1–65535" };
  return { host: `${url.hostname}:${url.port}` };
}

/**
 * Validates an EXPLICIT local database URL against the validated RTDB emulator host and the declared
 * demo project (follow-up 2026-09-11, item 1: "soulad databáze s deklarovaným demo projektem").
 *
 * The only shape a local database URL may have is the emulator's own — `http://<database host>?ns=<the
 * project's default namespace>` — because that is the one thing the variable can legitimately add
 * over the derived URL: nothing. A different host is a second backend; a different namespace is a
 * second project; a path, credentials or a fragment are not a database address at all.
 */
export function validateLocalDatabaseUrl(
  raw: string,
  databaseHost: string,
  projectId: string,
): { problem: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "is not a URL" };
  }
  if (url.protocol !== "http:") return { problem: "is not a plain-HTTP emulator URL" };
  if (url.username || url.password) return { problem: "carries credentials" };
  if (url.hash !== "") return { problem: "carries a fragment" };
  if (url.pathname !== "/" && url.pathname !== "") return { problem: "carries a path" };
  if (url.host !== databaseHost) {
    return { problem: `names a different host than ${MOBILE_FIREBASE_ENV_VARS.databaseEmulator}` };
  }
  const params = [...url.searchParams.entries()];
  if (params.length !== 1 || params[0]![0] !== "ns") return { problem: "must carry exactly one ?ns= query" };
  if (params[0]![1] !== databaseNamespace(projectId)) {
    return { problem: `names a namespace that is not the declared project's (${MOBILE_FIREBASE_ENV_VARS.projectId})` };
  }
  return null;
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
): { config: MobileFirebaseConfig | null; missing: string[]; refusal: MobileFirebaseConfigRefusal | null } {
  const projectId = env[MOBILE_FIREBASE_ENV_VARS.projectId]?.trim() || "";
  // EMULATORS ARE A LOCAL-ONLY RULE, AND NOW SAY SO (follow-up F11, updated by plan §2/§3.1: emulators
  // are `local`'s domain now, not `dev`'s — `dev` is a personal test against REAL servers). They used
  // to be read from the environment whatever the environment was, so `FIREBASE_AUTH_EMULATOR_HOST`
  // could point a qa or prod build's identity calls at a plain-HTTP loopback host — and the same
  // variable made the API key fall back to `emulator-api-key`, so a real project could be addressed
  // with a key that is not its own.
  //
  // AND OUTSIDE LOCAL THEY ARE A CONTRADICTION, NOT A NO-OP (R06). Ignoring them quietly left the
  // explicit database URL — which the same procedure sets to the emulator's `http://127.0.0.1:9000`
  // — in force, so a qa build could keep its database on the emulator while its identity calls
  // and callables went to the cloud. A configuration that names two backends names none.
  const environment = bootstrapEnvironmentFor(env);
  const emulatorsAllowed = environment === "local";
  const emulatorVars = [
    MOBILE_FIREBASE_ENV_VARS.authEmulator,
    MOBILE_FIREBASE_ENV_VARS.databaseEmulator,
    MOBILE_FIREBASE_ENV_VARS.functionsEmulator,
  ].filter((name) => Boolean(env[name]?.trim()));
  const explicitDatabaseUrl = env[MOBILE_FIREBASE_ENV_VARS.databaseUrl]?.trim();
  if (!emulatorsAllowed) {
    const contradictions: string[] = [...emulatorVars];
    if (explicitDatabaseUrl && !/^https:\/\//i.test(explicitDatabaseUrl)) {
      contradictions.push(`${MOBILE_FIREBASE_ENV_VARS.databaseUrl} (not https)`);
    }
    // A `demo-` PROJECT OUTSIDE LOCAL IS THE SAME CONTRADICTION (follow-up 2026-09-11, item 1). A demo
    // project exists in no cloud — only the emulators serve one — so a dev/qa/prod (or unresolved)
    // declaration naming one has no endpoint that could answer, and the old resolver derived
    // `cloudfunctions.net` and `firebasedatabase.app` URLs for it anyway: a config that could only ever
    // send requests OFF the machine for a project that lives only ON one.
    if (projectId && isDemoProject(projectId)) {
      contradictions.push(`${MOBILE_FIREBASE_ENV_VARS.projectId} (a demo- project)`);
    }
    if (contradictions.length > 0) {
      const declared = environment === "unresolved" ? "not a recognised environment" : `'${environment}'`;
      return {
        config: null,
        missing: [],
        refusal: {
          reason: "environment-contradiction",
          detail:
            `the environment resolves to ${declared}, and ${contradictions.join(", ")} ` +
            `${contradictions.length === 1 ? "is" : "are"} set — emulator hosts and plain-HTTP endpoints are ` +
            `honoured only in a local build (${BOOTSTRAP_ENV_VARS.environment}=local). Unset them, or declare local.`,
        },
      };
    }
  }
  // THE OTHER HALF OF THE SAME RULE (plan §3.1: "local s reálným projektem ... je chyba"). Emulators
  // pointed at a real project is refused above; a `local` declaration pointed at a real (non-`demo-`)
  // project is refused here — `local` never leaves this machine, and a real project id is a project
  // that exists in the cloud whether or not this process happens to be emulated.
  if (emulatorsAllowed && projectId && !isDemoProject(projectId)) {
    return {
      config: null,
      missing: [],
      refusal: {
        reason: "environment-contradiction",
        detail:
          `the environment resolves to 'local', and ${MOBILE_FIREBASE_ENV_VARS.projectId} names ` +
          `'${projectId}', which is not a demo- project — local never leaves this machine. Use a ` +
          `demo- project id, or declare the environment this project actually is.`,
      },
    };
  }
  if (emulatorsAllowed) return resolveLocalConfig(env, projectId, functionsRegion, explicitDatabaseUrl);

  const apiKey = env[MOBILE_FIREBASE_ENV_VARS.apiKey]?.trim() || "";
  const missing: string[] = [];
  if (!projectId) missing.push(MOBILE_FIREBASE_ENV_VARS.projectId);
  if (!apiKey) missing.push(MOBILE_FIREBASE_ENV_VARS.apiKey);
  if (missing.length > 0) return { config: null, missing, refusal: null };

  // Derived from the shared contract, never spelled out here — the Functions, the Flutter client
  // factory and this transport must address the same instance and the same namespace.
  return {
    config: {
      projectId,
      apiKey,
      functionsRegion,
      emulators: null,
      databaseUrl: explicitDatabaseUrl || databaseInstanceUrl(projectId),
    },
    missing: [],
    refusal: null,
  };
}

/**
 * The `local` half of {@link resolveMobileFirebaseConfig} (follow-up 2026-09-11, item 1; plan §2.2,
 * §3.1, §5.5).
 *
 * THE WHOLE EMULATOR SUITE, OR NO CONFIGURATION. `local` used to need a project id and nothing else;
 * whichever emulator variables happened to be set were honoured and the rest of the calls went to the
 * cloud — the exact "cloud fallback" the follow-up names. Now every one of the three hosts is REQUIRED
 * (an absent one is reported through `missing`, so the transport's error names exactly which variable
 * to set), every one is VALIDATED as a loopback `host:port` (a LAN address, a lookalike hostname,
 * `https://`, credentials or a path are a `local-endpoint-invalid` refusal), and an explicit database
 * URL has to be the database emulator's own URL for the declared demo project. What comes out is a
 * configuration whose every endpoint is on this machine, or nothing.
 */
function resolveLocalConfig(
  env: NodeJS.ProcessEnv,
  projectId: string,
  functionsRegion: string,
  explicitDatabaseUrl: string | undefined,
): { config: MobileFirebaseConfig | null; missing: string[]; refusal: MobileFirebaseConfigRefusal | null } {
  const refuse = (detail: string) => ({
    config: null,
    missing: [],
    refusal: {
      reason: "local-endpoint-invalid" as const,
      detail: `the environment resolves to 'local', and ${detail}`,
    },
  });
  const hostVars = [
    ["auth", MOBILE_FIREBASE_ENV_VARS.authEmulator],
    ["database", MOBILE_FIREBASE_ENV_VARS.databaseEmulator],
    ["functions", MOBILE_FIREBASE_ENV_VARS.functionsEmulator],
  ] as const;
  const missing: string[] = [];
  if (!projectId) missing.push(MOBILE_FIREBASE_ENV_VARS.projectId);
  const hosts: Partial<Record<(typeof hostVars)[number][0], string>> = {};
  for (const [key, name] of hostVars) {
    const raw = env[name]?.trim();
    if (!raw) {
      missing.push(name);
      continue;
    }
    const checked = validateLocalEmulatorHost(raw);
    if (checked.problem !== undefined) {
      return refuse(
        `${name} ${checked.problem} — a local build talks to this machine's Emulator Suite and nothing else. ` +
          `Set it to <loopback host>:<port> as \`firebase emulators:start\` exports it, or declare the environment this endpoint belongs to.`,
      );
    }
    hosts[key] = checked.host;
  }
  if (missing.length > 0) return { config: null, missing, refusal: null };
  const emulators: MobileFirebaseEmulatorHosts = {
    auth: hosts.auth!,
    database: hosts.database!,
    functions: hosts.functions!,
  };

  if (explicitDatabaseUrl) {
    const problem = validateLocalDatabaseUrl(explicitDatabaseUrl, emulators.database, projectId);
    if (problem) {
      return refuse(
        `${MOBILE_FIREBASE_ENV_VARS.databaseUrl} ${problem.problem} — a local database URL may only be the ` +
          `database emulator's own URL for the declared demo project (http://<${MOBILE_FIREBASE_ENV_VARS.databaseEmulator}>?ns=<project>-default-rtdb), ` +
          `or unset, in which case it is derived.`,
      );
    }
  }

  return {
    config: {
      projectId,
      // Emulators accept any key; a demo project has no real key to use.
      apiKey: env[MOBILE_FIREBASE_ENV_VARS.apiKey]?.trim() || "emulator-api-key",
      functionsRegion,
      emulators,
      databaseUrl: explicitDatabaseUrl || emulatorDatabaseUrl(emulators.database, projectId),
    },
    missing: [],
    refusal: null,
  };
}

/**
 * Guards the cloud branch of every URL helper below (follow-up 2026-09-11, item 1). A configuration
 * without emulators is a real project in the cloud — and a `demo-` project is not one, so a URL for it
 * with no emulator host is not a fallback but a mistake. The resolver never builds such a config; this
 * is what makes the helpers refuse one that was built by hand.
 */
function requireCloudProject(config: MobileFirebaseConfig, what: string): void {
  if (isDemoProject(config.projectId)) {
    throw new Error(
      `Mobile Firebase transport: no ${what} endpoint exists for demo project '${config.projectId}' without the local emulators — a demo project is served by the Emulator Suite only`,
    );
  }
}

/** Absolute URL of a callable, for this configuration. */
export function callableUrl(config: MobileFirebaseConfig, name: string): string {
  const emulatorHost = config.emulators?.functions;
  if (emulatorHost) {
    return `http://${emulatorHost}/${config.projectId}/${config.functionsRegion}/${name}`;
  }
  // THE SIGNED BASE URL WINS. A build following a bootstrap envelope must use the callable endpoint
  // that envelope names; deriving one from the region and the project id would point the callables at
  // the recovered project's default Cloud Functions domain even when the envelope says otherwise.
  const base = config.functionsBaseUrl?.trim();
  if (base) return `${base.replace(/\/+$/, "")}/${name}`;
  requireCloudProject(config, "callable");
  return `https://${config.functionsRegion}-${config.projectId}.cloudfunctions.net/${name}`;
}

/** Base URL of the Identity Toolkit (account) endpoints. */
export function identityToolkitUrl(config: MobileFirebaseConfig, method: string): string {
  const emulatorHost = config.emulators?.auth;
  if (!emulatorHost) requireCloudProject(config, "Identity Toolkit");
  const base = emulatorHost
    ? `http://${emulatorHost}/identitytoolkit.googleapis.com`
    : "https://identitytoolkit.googleapis.com";
  return `${base}/v1/accounts:${method}?key=${encodeURIComponent(config.apiKey)}`;
}

/** URL of the secure-token (refresh) endpoint. */
export function secureTokenUrl(config: MobileFirebaseConfig): string {
  const emulatorHost = config.emulators?.auth;
  if (!emulatorHost) requireCloudProject(config, "secure-token");
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
