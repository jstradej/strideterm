#!/usr/bin/env node
/// <reference types="node" />
/**
 * The SHIPPED account client, against a live Firebase project.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PHASE-0 SWEEP. `strideterm-mobile`'s
 * `scripts/spike-passwordless.mjs` answers what the identity SERVICE does, and it answers it with its
 * own `fetch` calls — which is evidence about Firebase and not about this repository's
 * `account-client.ts`. Two implementations of one contract agreeing with a document is not the same
 * claim as the one that ships agreeing with the service. This drives the real client: the real parser
 * on a real link, `completeEmailSignIn`, `lookup`, `refresh`, and a replay to see the mapped error
 * code rather than Firebase's string.
 *
 * IT MAILS NOBODY. The link is minted with the Identity Toolkit's ADMIN endpoint and
 * `returnOobLink: true`, which hands back the link it would have sent and sends nothing. The address
 * is `phase0-…@example.com` — RFC 2606 reserved, no mailbox anywhere — and the account it creates is
 * deleted before this exits. What a run spends is link-generation quota, not sending quota.
 *
 * IT PRINTS NO CREDENTIAL. No code, no token, no address, no uid: every line is a boolean or a fixed
 * error code. The same rule the phase-0 record is held to, for the same reason — a verification run
 * whose output cannot be pasted into a ticket is a verification nobody will re-run.
 *
 * Usage (never against production):
 *   STRIDETERM_SPIKE_PROJECT_ID=<dev project> \
 *   STRIDETERM_SPIKE_API_KEY=<its web API key> \
 *   STRIDETERM_SPIKE_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     npx tsx scripts/verify-live-account-client.mts
 */
import { createAccountClient, type AccountAuthErrorCode } from "../electron/backend/account/account-client.js";
import { normalizeAuthEmail, parseSignInLink } from "../electron/backend/account/authlink-config.js";
import type { MobileFirebaseConfig } from "../electron/backend/mobile/mobile-firebase-config.js";

const projectId = (process.env.STRIDETERM_SPIKE_PROJECT_ID ?? "").trim();
const apiKey = (process.env.STRIDETERM_SPIKE_API_KEY ?? "").trim();
const accessToken = (process.env.STRIDETERM_SPIKE_ACCESS_TOKEN ?? "").trim();

if (!projectId || !apiKey || !accessToken) {
  console.error(
    "set STRIDETERM_SPIKE_PROJECT_ID, STRIDETERM_SPIKE_API_KEY and STRIDETERM_SPIKE_ACCESS_TOKEN, " +
      "and point them at a DEV project.",
  );
  process.exit(2);
}
if (/prod/i.test(projectId)) {
  // This creates and deletes an account and spends real quota. The mobile repository's own harness
  // resolves dev/qa from `.firebaserc`; here the only available signal is the name, so the rule
  // is the conservative half of it.
  console.error(`refusing to run against "${projectId}": this creates an account and spends quota.`);
  process.exit(2);
}

/** The Identity Toolkit ADMIN endpoint — the one that can return a link instead of mailing it. */
async function admin(method: string, payload: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:${method}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-goog-user-project": projectId,
      },
      body: JSON.stringify(payload),
      redirect: "error",
    },
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, body };
}

const results: Record<string, unknown> = {};
let createdUid: string | null = null;

try {
  // Through the shipped normaliser, which is also the one the sign-in call will use — and it returns
  // `null` for anything it will not send to, so a generated address that failed it would be a bug in
  // this script rather than something to coerce past.
  const address = normalizeAuthEmail(`phase0-client-${Math.random().toString(16).slice(2, 10)}@example.com`);
  if (address === null) throw new Error("the generated test address did not survive normalisation");
  const attemptId = "d".repeat(43);
  // The hosted origin, because a `continueUrl` on a domain Firebase does not allowlist is refused
  // outright (`UNAUTHORIZED_DOMAIN`, phase-0 row 7) — and the broker's own domains are not on the list
  // until a deployment puts them there. The SHAPE is what this exercises, and it is the same shape.
  const brokerOrigin = `https://${projectId}.firebaseapp.com`;
  const sent = await admin("sendOobCode", {
    requestType: "EMAIL_SIGNIN",
    email: address,
    continueUrl: `${brokerOrigin}/c?attempt=${attemptId}`,
    canHandleCodeInApp: true,
    returnOobLink: true,
  });
  const link = typeof sent.body["oobLink"] === "string" ? sent.body["oobLink"] : null;
  if (!sent.ok || link === null) {
    const message = (sent.body["error"] as { message?: string } | undefined)?.message ?? "no-link-returned";
    console.error(`could not mint a link: ${message.split(/[\s:]/)[0]}`);
    process.exit(1);
  }

  // 1. THE REAL PARSER on the real link.
  //
  // THE WHOLE SNAPSHOT, not just an origin (F07): the parser judges the outer action-handler host too,
  // so a fixture that named only the origin would be exercising a different function from the shipped
  // one. `brokerOrigin` is the project's own Firebase host here — see the comment above — so the
  // handler entry is the same host with the action path. `apiKey` is no longer part of the snapshot
  // (security review 2026-09-13, I2): the parser never compares it.
  const parsed = parseSignInLink(
    {
      environment: "dev",
      origin: brokerOrigin,
      isLocal: false,
      firebaseProjectId: projectId,
      actionHandlers: [{ origin: brokerOrigin, path: "/__/auth/action" }],
    },
    link,
  );
  results["parser"] = { accepted: parsed !== null, attemptRecovered: parsed?.attemptId === attemptId };
  if (parsed === null) throw new Error("the shipped parser refused a real link");

  const config = { projectId, apiKey } as unknown as MobileFirebaseConfig;
  const client = createAccountClient({ config });

  // 2. THE REAL SIGN-IN.
  const session = await client.completeEmailSignIn(address, parsed.oobCode);
  createdUid = session.uid;
  results["completeEmailSignIn"] = {
    hasTokens: session.idToken.length > 0 && session.refreshToken.length > 0,
    uidPresent: session.uid.length > 0,
    // The address is the one THIS process pinned, never the response's echo.
    emailIsThePinnedOne: session.email === address,
    // `false` HERE IS CORRECT and is the point of the row: the live `signInWithEmailLink` response
    // carries no `emailVerified` at all, which is why the client refuses to invent one and the
    // manager takes it from `lookup` instead.
    emailVerifiedFromSignIn: session.emailVerified,
    // NULL IS A REAL ANSWER since F08 — a token that carries no usable `auth_time` leaves this unset
    // rather than substituting this machine's clock — so the row records both facts. Against the live
    // service it should be a number: Firebase stamps `auth_time` on every id token.
    authenticatedAtProven: session.authenticatedAt !== null,
    authenticatedAtWithinTwoMinutes:
      session.authenticatedAt !== null && Math.abs(session.authenticatedAt - Date.now()) < 120_000,
  };

  // 3. THE LOOKUP, which is where the verification flag and the uid cross-check come from.
  const looked = await client.lookup(session);
  results["lookup"] = {
    uidAgreesWithSignIn: looked.uid === session.uid,
    emailVerified: looked.emailVerified,
  };

  // 4. A REFRESH MUST NOT MOVE `authenticatedAt`. The whole five-minute window rests on it.
  const refreshed = await client.refresh({ ...session, expiresAt: 0 });
  results["refresh"] = {
    authenticatedAtUnchanged: refreshed.authenticatedAt === session.authenticatedAt,
    uidUnchanged: refreshed.uid === session.uid,
    stillHasTokens: refreshed.idToken.length > 0 && refreshed.refreshToken.length > 0,
  };

  // 5. A REPLAY, through the shipped error map rather than Firebase's own string.
  let replayCode: AccountAuthErrorCode | "not-refused" = "not-refused";
  try {
    await client.completeEmailSignIn(address, parsed.oobCode);
  } catch (error) {
    replayCode = (error as { code?: AccountAuthErrorCode }).code ?? "unknown";
  }
  results["replay"] = { mappedTo: replayCode };

  const ok =
    results["parser"] !== null &&
    (results["completeEmailSignIn"] as Record<string, unknown>)["uidPresent"] === true &&
    (results["lookup"] as Record<string, unknown>)["emailVerified"] === true &&
    (results["refresh"] as Record<string, unknown>)["authenticatedAtUnchanged"] === true &&
    replayCode === "invalid-code";
  results["ok"] = ok;
  console.log(JSON.stringify(results, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  if (createdUid !== null) {
    const deleted = await admin("batchDelete", { localIds: [createdUid], force: true });
    console.log(`cleanup: ${deleted.ok ? "the account this run created was deleted" : "DELETE FAILED"}`);
    if (!deleted.ok) process.exitCode = 1;
  }
}
