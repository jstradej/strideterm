// Where the desktop's sign-in links come back to, and how that origin is chosen.
//
// THE ORIGIN IS A TRUST DECISION, NOT A SETTING. It is the host that will be handed a live Firebase
// `oobCode` by the person's browser, and the host this backend will ask for that code back. Getting
// it from the renderer, from the incoming URL, or from anything a working directory is named would
// mean a page could nominate who brokers a sign-in. So it comes from the SAME place the Firebase
// project comes from — `bootstrapEnvironmentFor`, which reads only the DECLARED environment — and the
// mapping from environment to origin is fixed in this file.
//
// ONE SNAPSHOT, TWO USES (F07). What this module produces is not just an origin: it is everything a
// sign-in and a PASTED LINK have to be judged against — the origin, the Firebase project, and the
// exact action-handler shapes a link may be wrapped in. The broker holds one of these for the
// life of an attempt, so the link somebody pastes ten minutes later is checked against the same bytes
// the link was sent under, rather than against whatever this process has adopted since.
//
// AND WHAT A CONFIGURATION CHANGE DOES TO AN ATTEMPT IN FLIGHT (F11's last bullet, kept explicitly
// rather than by accident). A newly fetched bootstrap envelope takes effect at the NEXT start — the
// runtime does not swap a control plane out from under live sessions — so a snapshot cannot go stale
// under a running attempt by that route. The route that CAN change it is a deliberate one: adopting an
// envelope at start-up, or the runtime being pointed elsewhere, and in both cases the account manager
// is disposed, which cancels the attempt rather than letting it finish against a configuration nobody
// chose for it. There is no third route: nothing mutates an `AuthLinkConfig` after it is built.
//
// WHY A FIXED MAP RATHER THAN A CONFIGURABLE URL (plan §8, Fáze 2). For the MVP the two hosts are
// known and stable, and stability is the point: the auth domain survives a project recovery, while
// the Firebase project id and API key may not. A recovery updates the Worker's allowlist alongside
// the Firebase configuration, so no new field has to be added to the signed bootstrap envelope for
// this to work.
//
// WHAT AN ABSENT OR DISAGREEING CONFIGURATION DOES. It blocks a NEW owner sign-in, with a named
// error, and does nothing else. It must not fall back to production — a dev build silently brokering
// through the production host is how a test address ends up in a real account — and it must not
// disconnect an installation that is working: a desktop that is already enrolled keeps its
// installation credential, its pairings and its device list whatever this file answers.

import type { BootstrapEnvironment } from "../mobile/control-plane-bootstrap.js";
import type { MobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";

export const AUTHLINK_ENV_VARS = {
  /**
   * A local/test override for the broker origin. REFUSED outside a `local` build.
   *
   * It exists for two cases and no others: the local `wrangler dev --local` broker, and an integration
   * harness. Which build is `local` is now DECLARED — `STRIDETERM_ENV=local` (see
   * `bootstrapEnvironmentFor`) — and it is deliberately no longer implied by `STRIDETERM_DATA_DIR`,
   * which says where the files are and nothing about the backend (F11), nor by a `demo-` project or an
   * absent one (plan §3.1: nothing here is derived from a project id any more). A `dev`, `qa` or
   * `prod` build ignores this variable entirely rather than merely warning about it — `dev` now has
   * its own deployed broker (plan §2.1), just like qa and prod do.
   */
  devOrigin: "STRIDETERM_MOBILE_AUTHLINK_ORIGIN",
  /**
   * Extra Firebase ACTION-HANDLER origins a pasted link may be wrapped in, comma-separated.
   *
   * F07 requires the outer layer of a pasted link to be an allowlisted shape, and a project whose
   * action handler has been moved to a custom domain is a real configuration rather than a hostile
   * one. So it is a value somebody sets — HTTPS, origin only — and never a host the link nominates.
   * Ignored entirely in a prod build, like every other variable in this file.
   */
  actionDomains: "STRIDETERM_MOBILE_AUTHLINK_ACTION_DOMAINS",
} as const;

/**
 * The one fixed mapping. Three DEPLOYED environments, three hosts, nothing derived from anything.
 * `local` is not here — it is the one environment with no deployed broker, resolved below from
 * {@link AUTHLINK_ENV_VARS.devOrigin} instead.
 */
const DEPLOYED_ORIGINS: Partial<Record<BootstrapEnvironment, string>> = {
  dev: "https://auth-dev.strideterm.com",
  qa: "https://auth-qa.strideterm.com",
  prod: "https://auth.strideterm.com",
};

export interface AuthLinkConfig {
  /** Which deployment this desktop brokers through. */
  readonly environment: BootstrapEnvironment;
  /** Scheme + host + port, no trailing slash. Compared for exact equality by everything below. */
  readonly origin: string;
  /**
   * Whether this is the explicit `local`/test mode.
   *
   * The one thing it unlocks is a plain-HTTP loopback origin. It is carried rather than re-derived so
   * a caller cannot ask "may I relax this" without also saying which environment it is relaxing for.
   */
  readonly isLocal: boolean;
  /**
   * The Firebase project this configuration belongs to.
   *
   * CARRIED HERE, IN THE SNAPSHOT, and that is the point of F07: the parser has to check the link
   * against "the environment this attempt was started for", and re-reading the live Firebase
   * configuration at paste time would be checking against whatever the process has adopted SINCE. The
   * broker holds one of these objects for the life of an attempt, so the sign-in and the paste are
   * validated against the same bytes.
   *
   * NOT the Web API key (security review 2026-09-13, I2): the key identifies a project, it does not
   * authorise, and comparing it never proved which environment a link belonged to — a legitimate link
   * carries whichever client key the SDK that requested it was configured with (an Android key,
   * say), which need not match this desktop's own web key even for the SAME project. Which project
   * minted the code is what {@link actionHandlers} (derived from THIS project id) and Firebase's own
   * redemption of the `oobCode` establish; an `apiKey` equality check proved neither and only refused
   * legitimate cross-client links.
   */
  readonly firebaseProjectId: string;
  /**
   * The EXACT hosts whose action-handler URL a pasted link may be wrapped in, and the paths on them.
   *
   * WHY THIS IS NOW PINNED, having deliberately not been. The previous version left the outer host
   * open, with the argument that it follows the PROJECT rather than the build and that a crafted
   * wrapper can only ever produce an `invalid-code`. The follow-up rejects that: F07 asks for "pouze
   * doložené tvary odkazu ... včetně ... povolených handler hostů/cest", and "Případné custom Firebase
   * action domény musí být výslovně podporované, ne libovolné". The argument was about what an
   * attacker gains, and the requirement is about what the parser accepts — a parser whose outer layer
   * is anything at all cannot say which shapes it has been shown.
   *
   * Derived from the project id (`<project>.firebaseapp.com`, `<project>.web.app`), plus the emulator's
   * own handler in a dev build, plus any custom action domain a configuration explicitly names. Never
   * "whatever came in the link".
   */
  readonly actionHandlers: readonly { readonly origin: string; readonly path: string }[];
}

export type AuthLinkConfigRefusal =
  /** No Firebase configuration at all — there is no hosted control plane in this build. */
  | "not-configured"
  /** A `local` build with no explicit broker origin. Deliberately not defaulted to prod. */
  | "local-origin-missing"
  /** The local override is not a URL, or not one a `local` build may use. */
  | "local-origin-invalid"
  /** The environment has no deployed broker. */
  | "environment-unsupported"
  /**
   * `STRIDETERM_ENV` names something that is not an environment (F11).
   *
   * A typo — `stage`, `Production `, an unset variable altogether — must block a NEW sign-in and say
   * which of the four things went wrong, rather than being resolved into a guess. Falling back to a
   * default would be the worst of the available answers: it would make the declaration silently
   * ineffective, which is precisely the class of confusion F11 is about.
   */
  | "environment-unresolved"
  /**
   * The Firebase configuration itself was refused as contradictory (R06): a `dev`, `qa` or `prod`
   * environment with emulator hosts or a plain-HTTP database URL set, or a `local` one pointed at a
   * real (non-`demo-`) project. Distinct from `not-configured` — the variables ARE there, and they
   * name two backends — so the page can say which line to fix.
   */
  | "environment-contradiction"
  /**
   * This data directory is bound to a DIFFERENT environment (plan §3.3). Distinct from
   * `environment-contradiction`: the declared environment is internally consistent, but this
   * directory has already recorded a different one, and adopting it here would risk this
   * environment inheriting the other's bootstrap epoch floor or mobile Auth refresh token.
   */
  | "environment-mismatch"
  /**
   * A `local` build whose Firebase endpoints are not all validated loopback targets (follow-up
   * 2026-09-11, item 1): a LAN or lookalike emulator host, an `https://` or credentialed value, or a
   * database URL for another host or another project's namespace. Distinct from
   * `environment-contradiction` — the declaration and the variables agree that this is local; one of
   * the addresses simply is not this machine.
   */
  | "local-endpoint-invalid";

export interface AuthLinkConfigResult {
  readonly config: AuthLinkConfig | null;
  readonly refusal: AuthLinkConfigRefusal | null;
}

/**
 * Resolves the broker origin for this build, or names why there is none.
 *
 * `environment` must come from `bootstrapEnvironmentFor(env)` — the same call the bootstrap trust set
 * is chosen with. Passing it in rather than recomputing it here is deliberate: two places deciding
 * "which environment am I" separately is exactly how one of them ends up on `prod` while the other is
 * not.
 */
export function resolveAuthLinkConfig(args: {
  readonly firebase: MobileFirebaseConfig | null;
  readonly environment: BootstrapEnvironment | "unresolved";
  readonly env: NodeJS.ProcessEnv;
  /**
   * Set when `firebase` is null because the resolver REFUSED a contradictory configuration (R06) or
   * an environment-mismatched data directory (plan §3.3).
   */
  readonly firebaseRefusal?: {
    readonly reason: "environment-contradiction" | "environment-mismatch" | "local-endpoint-invalid";
  } | null;
}): AuthLinkConfigResult {
  if (args.firebase === null) {
    return { config: null, refusal: args.firebaseRefusal ? args.firebaseRefusal.reason : "not-configured" };
  }
  // A CONTRADICTORY DECLARATION BLOCKS A NEW SIGN-IN AND NOTHING ELSE (F11). It does not fall back to
  // prod, and it does not disconnect an installation that is working.
  if (args.environment === "unresolved") return { config: null, refusal: "environment-unresolved" };
  const firebase = args.firebase;

  if (args.environment === "local") {
    const raw = args.env[AUTHLINK_ENV_VARS.devOrigin]?.trim() ?? "";
    if (raw.length === 0) return { config: null, refusal: "local-origin-missing" };
    const origin = normalizeDevOrigin(raw);
    if (origin === null) return { config: null, refusal: "local-origin-invalid" };
    return { config: describe("local", origin, true, firebase, args.env), refusal: null };
  }

  const origin = DEPLOYED_ORIGINS[args.environment];
  if (origin === undefined) return { config: null, refusal: "environment-unsupported" };
  // THE ENVIRONMENT VARIABLE IS NOT CONSULTED HERE, and that is the property this file exists for: a
  // dev, qa or prod build cannot be pointed at another broker by anything in its environment.
  return { config: describe(args.environment, origin, false, firebase, args.env), refusal: null };
}

/**
 * The whole immutable snapshot for one environment: the broker origin AND what a link may look like.
 *
 * One function so the two halves cannot disagree. A configuration whose origin says qa and whose
 * accepted project says prod is the exact confusion F07 and F11 are both about, and the only way to
 * make it impossible is to build both from the same inputs at the same moment.
 */
function describe(
  environment: BootstrapEnvironment,
  origin: string,
  isLocal: boolean,
  firebase: MobileFirebaseConfig,
  env: NodeJS.ProcessEnv,
): AuthLinkConfig {
  return {
    environment,
    origin,
    isLocal,
    firebaseProjectId: firebase.projectId,
    actionHandlers: actionHandlersFor(firebase, environment, env),
  };
}

/**
 * The action-handler shapes this build accepts as the OUTER layer of a pasted link.
 *
 * Accepted sources:
 *
 *   - Firebase's own two hosts for the project, `<project>.firebaseapp.com` and `<project>.web.app`,
 *     both serving `/__/auth/action`. Phase-0 row 8 measured the first of these live; the second is the
 *     same handler on the project's other default domain, which Firebase serves identically.
 *   - The production project's fixed custom domain, `mail.strideterm.com`.
 *   - The AUTH EMULATOR's handler, `http://<host>/emulator/action`, and only in a `local` build with an
 *     emulator configured. It is what configuration A pastes — the emulator-only procedure named by
 *     `docs/development.md`, written out in `docs/PASSWORDLESS-LOCAL-TESTING.md` in the cloud
 *     repository — and gating it on `isLocal` is what stops a plain-HTTP handler ever being accepted
 *     by a real build.
 *   - A CUSTOM action domain, named explicitly by {@link AUTHLINK_ENV_VARS.actionDomains} and only
 *     outside prod. A project that has moved its action handler to `auth.example.com` is a real
 *     configuration, and F07 asks for it to be "výslovně podporované, ne libovolné" — so it is a value
 *     somebody sets, not a host the link nominates.
 */
function actionHandlersFor(
  firebase: MobileFirebaseConfig,
  environment: BootstrapEnvironment,
  env: NodeJS.ProcessEnv,
): readonly { origin: string; path: string }[] {
  const handlers: { origin: string; path: string }[] = [
    { origin: `https://${firebase.projectId}.firebaseapp.com`, path: FIREBASE_ACTION_PATH },
    { origin: `https://${firebase.projectId}.web.app`, path: FIREBASE_ACTION_PATH },
  ];
  if (environment === "prod" && firebase.projectId === "strideterm-mobile-prod") {
    handlers.push({ origin: "https://mail.strideterm.com", path: FIREBASE_ACTION_PATH });
  }
  const emulator = firebase.emulators?.auth;
  if (environment === "local" && emulator) handlers.push({ origin: `http://${emulator}`, path: EMULATOR_ACTION_PATH });
  // PROD NAMES NOTHING FROM THE ENVIRONMENT, the same rule the broker origin follows.
  if (environment !== "prod") {
    for (const raw of (env[AUTHLINK_ENV_VARS.actionDomains] ?? "").split(",")) {
      const custom = normalizeCustomActionOrigin(raw.trim());
      if (custom !== null) handlers.push({ origin: custom, path: FIREBASE_ACTION_PATH });
    }
  }
  return handlers;
}

/** Firebase's hosted action handler path. Fixed by the service, not by this build. */
const FIREBASE_ACTION_PATH = "/__/auth/action";
/** The Auth emulator's equivalent. A different path, which is why it is named rather than assumed. */
const EMULATOR_ACTION_PATH = "/emulator/action";

/**
 * A custom action domain, or null.
 *
 * HTTPS ONLY, no path, no query. The production refusal is at the call site rather than here, for the
 * same reason the broker origin's is: a production build whose accepted link shapes could be widened
 * from the environment is a production build that can be handed a link from somewhere else.
 */
function normalizeCustomActionOrigin(raw: string): string | null {
  if (raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

/**
 * A dev origin, or null.
 *
 * PLAIN HTTP ONLY ON LOOPBACK. `http://127.0.0.1:8788` is a secure context as far as a browser is
 * concerned and needs no certificate on a test machine, which is what makes the local broker usable
 * at all. `http://some.host` is refused: a sign-in code would cross a network in clear text, and
 * "it is only dev" is how that reaches a real address.
 */
function normalizeDevOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol !== "http:") return null;
  const host = url.hostname;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  return loopback ? url.origin : null;
}

/**
 * The `continueUrl` for one attempt, built HERE and never accepted from a caller.
 *
 * Firebase puts this URL in the email and its own action handler redirects the browser to it, so it
 * is the one thing that decides which host receives the code. A `continueUrl` that arrived from the
 * renderer would be a renderer choosing that host — plan §8, Fáze 2: "URL sestavuje backend z
 * konfigurace, nepřijímá libovolné `continueUrl` z rendereru".
 *
 * It carries the attempt id and NOTHING else: no address, no purpose, no uid. The address is typed
 * again by the person on the confirmation page and pinned locally by this backend; the purpose never
 * leaves this process.
 */
export function continueUrlFor(config: AuthLinkConfig, attemptId: string): string {
  const url = new URL("/c", config.origin);
  url.searchParams.set("attempt", attemptId);
  return url.toString();
}

/**
 * Whether a link the user pasted is one of OURS, and which attempt it names.
 *
 * THE PARSER ACCEPTS ONE SHAPE. It is fed text out of somebody's mail client, so everything about it
 * is hostile by default: the length is bounded before anything is parsed, the origin must be this
 * build's exact broker origin, the path must be the confirmation path, and the two parameters must
 * each appear exactly once. It NEVER fetches the URL it was given — plan §"Záložní ruční vložení
 * odkazu": "Nikdy načtenou URL sám nenavštěvuje."
 *
 * NESTED LINKS ARE THE INTERESTING CASE. What arrives in the mail is usually Firebase's own action
 * handler URL with our `continueUrl` inside it, URL-encoded — so the real parameters are one level
 * down, and the `oobCode` is present at BOTH levels. This unwraps exactly one level of `continueUrl`
 * and takes the `oobCode` from the outer link when the inner one has none, which is the shape Firebase
 * actually produces. It does not follow a second level: an arbitrarily nested URL is a construction,
 * not a mail client.
 *
 * WHAT F07 CHANGED, AND WHY THE PREVIOUS ARGUMENT WAS NOT ENOUGH. This function used to pin only the
 * INNER link's origin and path, and left the outer host open on the grounds that it follows the
 * PROJECT rather than the build, and that the worst a crafted wrapper can achieve is an
 * `invalid-code` — the code is redeemed against the address THIS desktop pinned, so a code minted for
 * another mailbox is refused by Firebase. That argument is about what an attacker gains. The
 * requirement is about what the parser ACCEPTS: F07 asks for "pouze doložené tvary odkazu ... včetně
 * aktuálního Firebase project/API key a povolených handler hostů/cest", and a parser whose outer layer
 * is any URL at all cannot say which shapes it has been shown. So now:
 *
 *   - the outer layer must be one of `config.actionHandlers` — the project's own two Firebase hosts,
 *     the emulator's handler in a dev build, or a custom action domain somebody named;
 *   - `mode`, where present, must be `signIn` at BOTH layers;
 *   - an `oobCode` present at both layers must AGREE. Two different codes is not a mail client;
 *   - a `continueUrl` inside the inner link is excessive depth and is refused;
 *   - and every critical parameter is refused if it appears more than once, which is the bug
 *     {@link criticalParam} exists to fix.
 *
 * WHAT THE SECURITY REVIEW (2026-09-13, I2) REMOVED, AND WHY IT WAS NEVER LOAD-BEARING. An `apiKey`
 * present at either layer USED to be compared against `config.firebaseApiKey` and refused on
 * mismatch. It is still read (an `apiKey` remains a critical parameter, so a DUPLICATE one is still
 * refused, same as every other critical parameter), but its value is no longer compared to anything.
 * A legitimate link can carry any client key of the SAME project — an Android app's key, say — and
 * need not match this desktop's own configured web key at all; the equality check proved nothing
 * about which project minted the code and only ever refused genuine links. The outer layer being an
 * allowlisted `config.actionHandlers` entry, plus Firebase's own redemption of the `oobCode` against
 * the pinned project, is what actually establishes project identity.
 */
export function parseSignInLink(config: AuthLinkConfig, raw: string): { attemptId: string; oobCode: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_PASTED_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // An `oobCode` on the OUTER link — Firebase's action handler carries it there, and its
  // `continueUrl` usually does not.
  const outerCode = criticalParam(url.searchParams, "oobCode");
  if (outerCode.kind === "duplicate") return null;
  const mode = criticalParam(url.searchParams, "mode");
  // A DUPLICATE `mode` USED TO READ AS AN ABSENT ONE (F07). `singleParam` answered null for both, and
  // the check below let null through — so `?mode=signIn&mode=resetPassword` passed a test that exists
  // to refuse the second value.
  if (mode.kind === "duplicate") return null;
  if (mode.kind === "value" && mode.value !== "signIn") return null;
  // `apiKey`'s VALUE is no longer compared (I2) — only that it is not duplicated, like every other
  // critical parameter.
  if (criticalParam(url.searchParams, "apiKey").kind === "duplicate") return null;

  const nested = criticalParam(url.searchParams, "continueUrl");
  if (nested.kind === "duplicate") return null;
  if (nested.kind === "value") {
    // THE OUTER LAYER IS AN ALLOWLISTED ACTION HANDLER, or this is not a link this build was shown.
    if (!isAllowedActionHandler(config, url)) return null;
    let inner: URL;
    try {
      inner = new URL(nested.value);
    } catch {
      return null;
    }
    // A nested link of a DIFFERENT environment is refused here rather than followed: it is the exact
    // shape a qa link opened on a prod desktop takes.
    if (inner.origin !== config.origin || inner.pathname !== "/c") return null;
    // EXCESSIVE DEPTH. One level is what Firebase produces; a `continueUrl` inside the `continueUrl`
    // is a construction, and following it would make the number of layers a property of the input.
    if (inner.searchParams.has("continueUrl")) return null;
    const innerMode = criticalParam(inner.searchParams, "mode");
    if (innerMode.kind === "duplicate") return null;
    if (innerMode.kind === "value" && innerMode.value !== "signIn") return null;
    if (criticalParam(inner.searchParams, "apiKey").kind === "duplicate") return null;
    const attemptId = criticalParam(inner.searchParams, "attempt");
    const innerCode = criticalParam(inner.searchParams, "oobCode");
    if (attemptId.kind !== "value" || innerCode.kind === "duplicate") return null;
    // A CONFLICT IS NOT A PREFERENCE. The two layers carrying different codes means one of them was
    // written by somebody, and picking either is picking on their behalf.
    if (innerCode.kind === "value" && outerCode.kind === "value" && innerCode.value !== outerCode.value) return null;
    const code = innerCode.kind === "value" ? innerCode.value : outerCode.kind === "value" ? outerCode.value : null;
    if (code === null) return null;
    return validPair(attemptId.value, code);
  }

  if (url.origin !== config.origin || url.pathname !== "/c") return null;
  const attemptId = criticalParam(url.searchParams, "attempt");
  if (attemptId.kind !== "value" || outerCode.kind !== "value") return null;
  return validPair(attemptId.value, outerCode.value);
}

/** Whether this URL is one of the action-handler shapes the configuration names. */
function isAllowedActionHandler(config: AuthLinkConfig, url: URL): boolean {
  // OUR OWN broker origin is always allowed as the outer layer too: the confirmation page's own URL
  // carries a `continueUrl` in one documented case — a link the person copied out of the browser's
  // address bar after the handler redirected — and refusing it would refuse the flow's own shape.
  if (url.origin === config.origin && url.pathname === "/c") return true;
  return config.actionHandlers.some((handler) => url.origin === handler.origin && url.pathname === handler.path);
}

/** The largest pasted text this parser will look at. A link is a few hundred characters. */
export const MAX_PASTED_LINK_LENGTH = 4096;

/** 32 random bytes, base64url — the shape the broker gives an attempt id. */
export const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The largest `oobCode` this build will carry. Firebase's are far shorter. */
export const MAX_OOB_CODE_LENGTH = 1024;

function validPair(attemptId: string, oobCode: string): { attemptId: string; oobCode: string } | null {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) return null;
  if (oobCode.length === 0 || oobCode.length > MAX_OOB_CODE_LENGTH) return null;
  return { attemptId, oobCode };
}

/**
 * One critical parameter, as one of THREE answers rather than two.
 *
 * F07's first bullet, and the bug it names. `singleParam` returned null for "absent" AND for
 * "duplicated", so every caller that treated null as "not present" — which is the right treatment for
 * an optional parameter — silently accepted a duplicated one. `?mode=signIn&mode=resetPassword` was
 * therefore read as a link with no `mode` at all, past a check whose only job is to refuse the second
 * value.
 *
 * `?attempt=a&attempt=b` is not something a mail client produces; it is something somebody builds, and
 * every parser that quietly picks one picks a different one from the parser downstream of it.
 */
type CriticalParam = { kind: "absent" } | { kind: "duplicate" } | { kind: "value"; value: string };

function criticalParam(params: URLSearchParams, name: string): CriticalParam {
  const all = params.getAll(name);
  if (all.length === 0) return { kind: "absent" };
  if (all.length > 1) return { kind: "duplicate" };
  const value = all[0];
  return value === undefined ? { kind: "absent" } : { kind: "value", value };
}

/**
 * An email address, normalised the ONE way this desktop and the broker both normalise it.
 *
 * Byte-for-byte the rule in `authlink/worker/src/attempt-core.ts#normalizeAuthEmail`: trim the outer
 * whitespace, fold the DOMAIN to lower case, leave the local part exactly as typed. Two
 * implementations of one rule is a drift risk, and the alternative — the desktop taking the broker's
 * word for what the address was — is worse: the address is what this backend compares the
 * confirmation against, and a value it did not derive itself is a value the web could choose.
 *
 * The local part is left alone because this value is what `sendOobCode` is called with, and choosing a
 * different spelling of somebody's mailbox is not this function's decision to make. Comparing two
 * spellings is a separate question with a separate answer — see `sameAuthEmail`.
 */
export function normalizeAuthEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return null;

  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || domain.length === 0) return null;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(domain) || !domain.includes(".")) return null;
  return `${local}@${domain.toLowerCase()}`;
}

/**
 * Are these two spellings the same address for the purpose of finishing THIS attempt?
 *
 * WHY THIS IS NOT JUST `===`, and why the observation behind it is recorded rather than assumed. Plan
 * §6 says the local part's case behaviour is to be checked against Firebase and one uniform rule then
 * used — "Chování velikosti písmen lokální části ověřit ve spike proti Firebase a pak použít jednotné
 * pravidlo; nevytvářet vlastní slučování schránek." The check is now in
 * `docs/artifacts/passwordless-phase0.json` (matrix row 36): the Identity Toolkit lowercases the WHOLE
 * address, local part included — `Person.Case@Example.TEST` comes back from `sendOobCode` as
 * `person.case@example.test`, and the code redeems under either spelling.
 *
 * So a person who typed `Person@x` in the desktop and `person@x` on the confirmation page was being
 * refused by OUR comparison for a difference the identity service does not have. This compares
 * case-insensitively and fixes that.
 *
 * WHAT DELIBERATELY DID NOT CHANGE: what is SENT. `normalizeAuthEmail` still leaves the local part
 * exactly as typed, and that is the value `sendOobCode` and `signInWithEmailLink` receive. Folding it
 * before sending would be deciding on Firebase's behalf which mailbox a message goes to — the
 * "vlastní slučování schránek" the plan forbids — on the strength of an emulator, and it would buy
 * nothing, because a service that folds will fold it anyway. Loosening the COMPARISON cannot send mail
 * anywhere: the mailbox was fixed when the link went out, and this field was never an authentication
 * factor (plan §"Bezpečnostní hranice": typing the address again limits mix-ups, it does not resist
 * phishing).
 */
export function sameAuthEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
