// The last hop of a billing URL, on THIS side of the boundary.
//
// WHY THE DESKTOP CHECKS AT ALL. The plan (§2) asks for the exact-host allowlist on BOTH boundaries,
// and the reason is not redundancy: the two checks answer different questions. The server's check
// answers "is the URL I am about to hand out a merchant URL", which it can only ask because it holds
// the merchant configuration. The desktop's answers "is the URL I am about to hand to the operating
// system one I was told to expect" — and that question survives a malformed, truncated or
// compromised callable response, which is exactly the case the server's own check cannot help with.
//
// WHAT IT USED TO BE. `runtime.setExternalUrlOpener` accepted any `http:` or `https:` URL and called
// `shell.openExternal`. The account transport cast a successful response to `T` without validating
// it, so a response body of `{ status: 'ready', checkoutUrl: 'https://anything/' }` reached the OS.
// The test beside it asserted, in words, that the host allowlist could not be repeated here — which
// is the opposite of what the plan asks for, and a green test proving a deviation.
//
// The signed bootstrap's billingCheckoutHosts take precedence, including an empty list.
// Before bootstrap activation, the QA build pins its sandbox hosts to the QA project.
// Recovery envelopes can replace them without a new release; environment variables cannot.
//
// AN EMPTY ALLOWLIST REFUSES EVERYTHING. A build that has not been told which merchant it uses opens
// nothing. That is the opposite of the old behaviour and it is the right way round: the failure mode
// of refusing is a checkout that does not open, and the failure mode of accepting is a person sent
// to somebody else's page from inside our app.

import { isAllowedBillingHost } from "../mobile/control-plane-bootstrap.js";
import type { MobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";

export function billingHostsForBuild(environment: string, config: MobileFirebaseConfig | null): readonly string[] {
  if (!config) return [];
  if (config.billingCheckoutHosts !== undefined) return config.billingCheckoutHosts;
  if (environment === "qa" && config.projectId === "strideterm-mobile-qa" && !config.emulators) {
    return ["strideterm.com", "sandbox-customer-portal.paddle.com"];
  }
  return [];
}

/** Why a billing URL was not opened. A fixed code; never remote text. */
export type BillingUrlRefusal = "not-a-url" | "not-https" | "host-not-allowed" | "no-allowlist";

export class BillingUrlRefusedError extends Error {
  readonly refusal: BillingUrlRefusal;

  constructor(refusal: BillingUrlRefusal) {
    // The message is OURS and names no host: a refusal that echoed the URL would put a payment link
    // into a log line, and the whole point of this module is that such a URL is never stored.
    super(`billing URL refused: ${refusal}`);
    this.name = "BillingUrlRefusedError";
    this.refusal = refusal;
  }
}

/**
 * Whether this URL may be handed to the operating system, and why not when it may not.
 *
 * Deliberately three separate refusals rather than one boolean: "the merchant list is empty" is a
 * configuration problem an operator fixes, and "this URL is not on it" is a response problem worth
 * treating as an incident. A single `false` makes those indistinguishable.
 */
export function checkBillingUrl(url: string, allowlist: readonly string[]): BillingUrlRefusal | null {
  if (allowlist.length === 0) return "no-allowlist";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not-a-url";
  }
  // HTTPS ONLY, with no loopback exception. The desktop's fake-provider development path talks to a
  // local server through the FUNCTIONS emulator, and the URL that reaches this function is still the
  // one the fake returns — so an http exception here would be an http exception in production too.
  if (parsed.protocol !== "https:") return "not-https";
  // The exact-host comparison is the shared protocol rule, so this and the ops verifier cannot
  // drift: a host check written twice is two host checks.
  if (!isAllowedBillingHost(parsed.toString(), allowlist)) return "host-not-allowed";
  return null;
}

/** Throws unless the URL is openable. The one call site is the account manager's billing path. */
export function assertOpenableBillingUrl(url: string, allowlist: readonly string[]): void {
  const refusal = checkBillingUrl(url, allowlist);
  if (refusal !== null) throw new BillingUrlRefusedError(refusal);
}
