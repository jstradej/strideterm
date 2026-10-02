// When the ledger is ahead of the token.
//
// The account overview is read from the LEDGER, so it says "trial" the moment `startTrial` commits.
// What `createPairingInvitation` actually checks is the installation's ID TOKEN, and its claims come
// from `syncEntitlementClaims` — an RTDB trigger that runs after that commit — and reach this desktop
// only once the `v2/tokenRefresh/{uid}` marker does (and the listener collapses those to one refresh
// per five seconds). For those few seconds, longer on a cold trigger, the page offers "Pair a phone"
// to an account it calls entitled and the server refuses it with `entitlement-required`.
//
// So that one refusal is retried — with a forced token refresh before each attempt — ONLY while the
// overview says the account is entitled: then the refusal can only be a token that has not caught up.
// An account the overview does not call entitled is refused at once, as before; waiting would only
// delay a true answer. Bounded, because a ledger that says "trial" while the issuer is failing must
// end in the same error, not in a button that never stops saying "Creating…".

import { MobileFirebaseCallableError } from "./mobile-firebase-rest.js";
import type { EntitlementSummary } from "./mobile-schemas.js";

/** Waits before each retry. Sum ≈ 14 s: past a warm trigger and the listener's 5 s collapse. */
export const PAIRING_ENTITLEMENT_CATCH_UP_DELAYS_MS: readonly number[] = [0, 2_000, 4_000, 8_000];

const ENTITLED_STATES: ReadonlySet<EntitlementSummary["state"]> = new Set(["trial", "active", "past_due"]);

export interface PairingEntitlementCatchUpDeps {
  /** The overview's entitlement state right now — re-read before every retry. */
  readonly ledgerState: () => EntitlementSummary["state"] | undefined;
  /** Mints a new installation ID token, whatever the cached one's expiry says. */
  readonly refreshToken: () => Promise<unknown>;
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (attempt: number) => void;
}

function isEntitlementRefusal(error: unknown): boolean {
  return error instanceof MobileFirebaseCallableError && error.reason === "entitlement-required";
}

export async function withPairingEntitlementCatchUp<T>(
  attempt: () => Promise<T>,
  deps: PairingEntitlementCatchUpDeps,
): Promise<T> {
  const delays = deps.delaysMs ?? PAIRING_ENTITLEMENT_CATCH_UP_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      const state = deps.ledgerState();
      if (
        retry >= delays.length ||
        !isEntitlementRefusal(error) ||
        state === undefined ||
        !ENTITLED_STATES.has(state)
      ) {
        throw error;
      }
      deps.onRetry?.(retry + 1);
      await sleep(delays[retry] ?? 0);
      await deps.refreshToken();
    }
  }
}
