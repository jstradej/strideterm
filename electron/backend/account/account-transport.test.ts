// What the account transport does with a REFUSAL, which is the half of it that has logic.
//
// The success paths are parse-or-throw and are covered through the manager's fake port. This file is
// about the other side: a callable rejection arrives as JSON written by the server, and this layer
// decides which of the desktop's own fixed codes it becomes. Get that wrong and the page shows "That
// did not work. Try again." for a limit somebody has to go and clear.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AccountCallableError, CALLABLE_TIMEOUT_MS, createAccountTransport } from "./account-transport.js";
import type { MobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";

// A REAL-shaped project id, not a `demo-` one: a demo project is served by the emulators only, and
// the URL helpers refuse to derive a cloud endpoint for one (follow-up 2026-09-11, item 1). This
// suite is about the cloud callable transport, so its fixture project has to be a cloud project.
const CONFIG: MobileFirebaseConfig = {
  projectId: "fixture-strideterm",
  apiKey: "test-api-key",
  functionsRegion: "europe-west1",
  emulators: null,
  databaseUrl: "https://fixture-strideterm.europe-west1.firebasedatabase.app",
};

/** A transport whose one call answers with the given HTTP status and body. */
function transportAnswering(status: number, body: unknown) {
  return createAccountTransport({
    config: CONFIG,
    tokenFor: async () => "id-token",
    fetchImpl: async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
}

/** The reason the transport settled on, for a call that was refused. */
async function reasonOf(status: number, body: unknown): Promise<string> {
  const transport = transportAnswering(status, body);
  try {
    await transport.ensureAccount("idem-1");
  } catch (error) {
    expect(error).toBeInstanceOf(AccountCallableError);
    return (error as AccountCallableError).reason;
  }
  throw new Error("the call was expected to be refused");
}

describe("a cap rejection keeps the name of the cap it hit", () => {
  test("each of the three caps becomes its own code", async () => {
    // WHY THE CAP NAME MATTERS HERE and not one layer up: "this account already has five desktops"
    // and "this desktop already has three phones" are fixed in two different places. Reading only
    // `details.reason` — which is the constant `cap-exceeded` for all three — threw the distinction
    // away one line before the UI needed it, and the page showed the generic fallback.
    for (const [cap, code] of [
      ["installations", "installation-limit"],
      ["mobileDevices", "mobile-device-limit"],
      ["pairedMobileDevices", "pairing-device-limit"],
    ] as const) {
      expect(
        await reasonOf(429, {
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "completeInstallationRegistration rejected: cap-exceeded",
            details: { reason: "cap-exceeded", cap, limit: 5 },
          },
        }),
      ).toBe(code);
    }
  });

  test("a cap this build has no code for is still reported as a cap", async () => {
    // The server's set may grow. "A limit was reached" stays true and has copy of its own; falling
    // through to the message text would have produced `cap-exceeded` by accident and to the status
    // would have produced `RESOURCE_EXHAUSTED`, which is not one of our codes at all.
    expect(
      await reasonOf(429, {
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "someCallable rejected: cap-exceeded",
          details: { reason: "cap-exceeded", cap: "relaySessions", limit: 8 },
        },
      }),
    ).toBe("cap-exceeded");
  });

  test("a daily budget is NOT a cap, and keeps its own reason", async () => {
    // Same status, no details block. The instruction is "wait", which is the wrong thing to tell
    // somebody at a full account — so the two must not collapse into one code.
    expect(
      await reasonOf(429, {
        error: { status: "RESOURCE_EXHAUSTED", message: "ensureAccount rejected: daily-limit-reached" },
      }),
    ).toBe("daily-limit-reached");
  });
});

describe("everything else about a refusal", () => {
  test("a structured reason wins over the message text", async () => {
    expect(
      await reasonOf(400, {
        error: {
          status: "FAILED_PRECONDITION",
          message: "ensureAccount rejected: something-else",
          details: { reason: "account-mismatch" },
        },
      }),
    ).toBe("account-mismatch");
  });

  test("the reason is taken from the message when there is no details block", async () => {
    expect(
      await reasonOf(400, {
        error: { status: "FAILED_PRECONDITION", message: "ensureAccount rejected: email-verification-required" },
      }),
    ).toBe("email-verification-required");
  });

  test("a response the contract does not describe is a refusal, not a value", async () => {
    // `return body?.result as T` is a promise to the compiler and nothing at runtime. A malformed
    // response must not become a typed object whose fields nobody checked.
    expect(await reasonOf(200, { result: { status: "not-a-status" } })).toBe("malformed-response");
  });

  test("an unreachable service is `network`, and nothing is read from it", async () => {
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:443");
      },
    });
    await expect(transport.ensureAccount("idem-1")).rejects.toMatchObject({ reason: "network", status: 0 });
  });

  test("a TLS-inspection failure stays `network` and carries the tls-untrusted detail", async () => {
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("unable to get local issuer certificate"), {
            code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
          }),
        });
      },
    });
    await expect(transport.ensureAccount("idem-1")).rejects.toMatchObject({
      reason: "network",
      status: 0,
      detail: "tls-untrusted",
    });
  });
});

// ---------------------------------------------------------------------------
// F05 — a redirect on a request that carries a credential
// ---------------------------------------------------------------------------
//
// WHAT THIS FILE HAD TO PROVE, and why a grep for `redirect: "error"` would not have done. The
// follow-up asks for it in as many words: "Test ověřuje skutečné chování transportu, ne pouze
// přítomnost textu ve zdroji." So the stub below BEHAVES like the platform — it honours
// `redirect: "error"` by throwing the way `fetch` does, and follows the redirect when the option is
// absent — and the assertion is about what reached the redirect target, not about what the source
// says.
describe("a redirect is never a hop for a request carrying a bearer token", () => {
  /**
   * A `fetch` that redirects once, and honours `init.redirect` the way the platform does.
   *
   * `redirect: "error"` makes a redirect a network error rather than a hop. Without it, undici
   * follows the response — and 307/308 preserve the METHOD AND THE BODY, so the follow-up request
   * carries the same `Authorization` header and the same payload to whatever host the response named.
   */
  function redirectingFetch(status: 301 | 302 | 307 | 308) {
    const requests: { url: string; authorization: string | undefined }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers ?? {});
      requests.push({ url, authorization: headers.get("authorization") ?? undefined });
      if (url.includes("elsewhere.example")) {
        // The redirect TARGET, answering as if it were the real callable.
        return new Response(JSON.stringify({ result: { status: "created", supportReference: "STR-1-AAAAAAAAAAAA" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      return fetchImpl("https://elsewhere.example/steal", init);
    };
    return { fetchImpl, requests, status };
  }

  for (const status of [301, 302, 307, 308] as const) {
    test(`a ${status} does not complete as an ordinary callable response, and sends no second credential`, async () => {
      const { fetchImpl, requests } = redirectingFetch(status);
      const transport = createAccountTransport({
        config: CONFIG,
        tokenFor: async () => "owner-id-token",
        fetchImpl,
      });
      await expect(transport.ensureAccount("idem-1")).rejects.toMatchObject({ reason: "network", status: 0 });
      // ONE request, to the real callable, and nothing to the target the redirect named.
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toContain("ensureAccount");
      expect(requests.some((request) => request.url.includes("elsewhere.example"))).toBe(false);
    });
  }

  test("the same stub WOULD have leaked the token without the option — which is why it is there", async () => {
    // The control that makes the four tests above mean something: with `redirect: "error"` removed
    // from the request, this stub follows the hop and the bearer token arrives at the other host. If
    // this test ever fails, the stub has stopped modelling the behaviour and the four above prove
    // nothing.
    const { fetchImpl, requests } = redirectingFetch(307);
    await fetchImpl("https://europe-west1-fixture-strideterm.cloudfunctions.net/ensureAccount", {
      method: "POST",
      headers: { authorization: "Bearer owner-id-token" },
      body: "{}",
    });
    expect(requests.map((request) => request.authorization)).toEqual([
      "Bearer owner-id-token",
      "Bearer owner-id-token",
    ]);
    expect(requests[1]?.url).toContain("elsewhere.example");
  });
});

// ---------------------------------------------------------------------------
// F04 — the request ends, and the body is bounded
// ---------------------------------------------------------------------------
describe("a callable that never finishes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a hanging request is abandoned at the deadline and reported as a transport failure", async () => {
    let aborted = false;
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const settled = transport.ensureAccount("idem-1").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CALLABLE_TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ reason: "network", status: 0 });
    expect(aborted).toBe(true);
  });

  test("a body that never ends is abandoned by the same deadline, not read for ever", async () => {
    // `response.json()` — which this transport used to call — reads whatever arrives for as long as it
    // keeps arriving, and a timer cleared when `fetch` resolved never saw it.
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"result":'));
              init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const settled = transport.ensureAccount("idem-1").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CALLABLE_TIMEOUT_MS + 1);
    expect(await settled).toMatchObject({ reason: "network", status: 0 });
  });

  test("an oversized answer is refused, and the stream is stopped rather than drained", async () => {
    vi.useRealTimers();
    let deliveredBytes = 0;
    const chunk = new TextEncoder().encode("x".repeat(32 * 1024));
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (deliveredBytes >= 8 * 1024 * 1024) return controller.close();
              deliveredBytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    await expect(transport.ensureAccount("idem-1")).rejects.toBeInstanceOf(AccountCallableError);
    // The 256 KiB bound, plus whatever one chunk overshoots by — nowhere near the 8 MiB on offer.
    expect(deliveredBytes).toBeLessThan(1024 * 1024);
  });

  test("abandoning the flow abandons the call it left outstanding", async () => {
    const controller = new AbortController();
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const settled = transport
      .confirmOwnerForInstallation({ installationId: "inst-1", ownerIdToken: "candidate", signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort();
    // THE PERSON'S OWN DOING, NAMED AS SUCH (S02). This used to be `network`; a cancel is not an outage,
    // and the manager shows the two differently. The key-keeping rule is the same for both.
    expect(await settled).toMatchObject({ reason: "aborted" });
  });
});

describe("the candidate token is named, not asked for (F02)", () => {
  test("`confirmOwnerForInstallation` sends the token it was given and never calls `tokenFor`", async () => {
    // THE WHOLE OF F02's "úzce vymezený přístup ke kandidátnímu tokenu". Every other owner call here
    // asks the manager for "the owner"; at this point in the flow there is no owner, and publishing
    // the candidate as one so that `tokenFor` could find it is exactly the escape the finding names.
    let tokenForCalls = 0;
    const seen: string[] = [];
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => {
        tokenForCalls += 1;
        return "the-promoted-owner-token";
      },
      fetchImpl: async (_url, init) => {
        seen.push(new Headers(init?.headers ?? {}).get("authorization") ?? "");
        return new Response(JSON.stringify({ result: { status: "confirmed" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await transport.confirmOwnerForInstallation({ installationId: "inst-1", ownerIdToken: "candidate-token" });
    expect(seen).toEqual(["Bearer candidate-token"]);
    expect(tokenForCalls).toBe(0);
  });

  test("the installation id is the only thing in the body — the token is a header, not a field", async () => {
    let body = "";
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "unused",
      fetchImpl: async (_url, init) => {
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ result: { status: "confirmed" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await transport.confirmOwnerForInstallation({ installationId: "inst-1", ownerIdToken: "candidate-token" });
    expect(JSON.parse(body)).toEqual({ data: { installationId: "inst-1" } });
    expect(body).not.toContain("candidate-token");
  });
});

// ---------------------------------------------------------------------------
// R04 — a body that broke off is a transport outcome, whether or not the timer fired
// ---------------------------------------------------------------------------
describe("an HTTP 200 whose body could not be read (R04)", () => {
  function bodyResponse(chunks: string[], options: { failAfter?: boolean } = {}): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          if (options.failAfter) controller.error(new Error("connection reset by peer"));
          else controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  test("a body that breaks off BEFORE the deadline is `network`, not `malformed-response`", async () => {
    // The manager treats `malformed-response` as an unknown outcome now too, but the two are still
    // different facts: this one is the connection, and a lookup retries it over the same candidate.
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: async () => bodyResponse(['{"result":{"status":"cre'], { failAfter: true }),
    });
    await expect(transport.ensureAccount("idem-1")).rejects.toMatchObject({ reason: "network", status: 0 });
  });

  test("a body that is not JSON is `malformed-response`: the server answered, this desktop cannot say what", async () => {
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: async () => bodyResponse(["<html>502</html>"]),
    });
    await expect(transport.startTrial({ installationId: "inst-1", idempotencyKey: "idem-1" })).rejects.toMatchObject({
      reason: "malformed-response",
    });
  });
});

describe("the operation's signal is honoured across the token wait (S02)", () => {
  test("a cancel while the token is being fetched: the mutation is never sent", async () => {
    // THE GAP THE MANAGER CANNOT SEE. Its scope check runs before the call; then this transport awaits
    // `tokenFor`, and a refresh of the installation session takes as long as it takes. The abort that
    // lands in between used to be followed by a brand-new request once the token arrived.
    let fetches = 0;
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => {
      releaseToken = resolve;
    });
    const controller = new AbortController();
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: () => token,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      },
    });
    const settled = transport
      .beginInstallationRegistration(
        { installationId: "inst-1", publicKey: "cHVibGljS2V5" },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    controller.abort();
    releaseToken("installation-token");
    expect(await settled).toMatchObject({ reason: "aborted", status: 0 });
    expect(fetches).toBe(0);
  });

  test("a signal that has already fired asks for no token at all", async () => {
    let tokenAsks = 0;
    const controller = new AbortController();
    controller.abort();
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => {
        tokenAsks += 1;
        return "id-token";
      },
      fetchImpl: async () => new Response(JSON.stringify({ result: {} }), { status: 200 }),
    });
    await expect(
      transport.startTrial({ installationId: "inst-1", idempotencyKey: "idem-1" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    expect(tokenAsks).toBe(0);
  });

  test("`tokenFor` is handed the operation's signal, so a refreshing producer can stop too", async () => {
    const controller = new AbortController();
    let handed: AbortSignal | undefined;
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async (_kind, signal) => {
        handed = signal;
        return "id-token";
      },
      fetchImpl: async () => new Response(JSON.stringify({ result: { status: "acknowledged" } }), { status: 200 }),
    });
    await transport.acknowledgeNotice("notice-1", { signal: controller.signal });
    expect(handed).toBe(controller.signal);
  });

  test("a mutation already in flight is aborted by the operation's signal and reported as `aborted`", async () => {
    // The other half: what WAS sent goes with the operation. `aborted`, not `network` — the manager
    // keeps the idempotency key for both, and shows only the second as an outage.
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async () => "id-token",
      fetchImpl: (_url, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const settled = transport
      .createCheckout(
        { offerId: "personal-monthly", installationId: "inst-1", idempotencyKey: "idem-1" },
        {
          signal: controller.signal,
        },
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    expect(fetchSignal!.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal!.aborted).toBe(true);
    expect(await settled).toMatchObject({ reason: "aborted", status: 0 });
  });

  test("the deadline firing is still `network`, signal or no signal", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const transport = createAccountTransport({
        config: CONFIG,
        tokenFor: async () => "id-token",
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      });
      const settled = transport.ensureAccount("idem-1", { signal: controller.signal }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CALLABLE_TIMEOUT_MS + 1);
      expect(await settled).toMatchObject({ reason: "network", status: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("which identity each call authenticates as", () => {
  // A REAL bug this closes: `revokeAccountDevice` used to run as the INSTALLATION — Firebase's own
  // ANONYMOUS sign-in, which never carries `email_verified: true` — against a server callable
  // (`revoke-account-device.ts`) that calls `requireVerifiedOwner` FIRST, for every one of the four
  // kinds, before it ever looks at the request body. Every call therefore always reached the same
  // refusal and never once revoked anything, including the desktop's own self-revoke inside
  // `signOutInstallation`. Nothing anywhere asserted WHICH identity a call authenticates as — every
  // existing test mocks `tokenFor` as `async () => "id-token"`, ignoring the `kind` it was asked for
  // — which is the blind spot that let this ship. These tests pin the identity each callable uses,
  // so a future edit cannot make the same mistake silently again.
  function identityTrackingTransport() {
    const kinds: string[] = [];
    const transport = createAccountTransport({
      config: CONFIG,
      tokenFor: async (kind) => {
        kinds.push(kind);
        return `${kind}-token`;
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    return { transport, kinds };
  }

  test("revokeAccountDevice runs as the OWNER, for every kind — requireVerifiedOwner admits nothing else", async () => {
    const { transport, kinds } = identityTrackingTransport();
    for (const kind of ["installation", "mobile-device", "pair", "account-wide"] as const) {
      await transport
        .revokeAccountDevice({
          kind,
          ...(kind === "account-wide" ? {} : { targetId: "target-1" }),
          idempotencyKey: `idem-${kind}`,
        })
        .catch(() => {
          // Only the identity dispatch matters here; a fixture body that does not satisfy
          // AccountRevokeResponseSchema is `malformed-response`, and that is not this test's concern.
        });
    }
    expect(kinds).toEqual(["owner", "owner", "owner", "owner"]);
  });

  test("deleteAccount runs as the OWNER", async () => {
    const { transport, kinds } = identityTrackingTransport();
    await transport
      .deleteAccount({ confirmationPhrase: "DELETE MY ACCOUNT", idempotencyKey: "idem-1" })
      .catch(() => {});
    expect(kinds).toEqual(["owner"]);
  });

  test("getAccountOverview and acknowledgeNotice run as the INSTALLATION — bound-account-recovery only", async () => {
    const { transport, kinds } = identityTrackingTransport();
    await transport.getAccountOverview().catch(() => {});
    await transport.acknowledgeNotice("notice-1").catch(() => {});
    expect(kinds).toEqual(["installation", "installation"]);
  });

  // I3: billing is authorized server-side against this desktop's own active installation record
  // (`requireBillingAuthorization`'s installation path), not a live owner session — so these run as
  // the INSTALLATION, the same long-lived session `getAccountOverview` already uses, not the OWNER.
  test("createCheckout and createPortalSession run as the INSTALLATION, not the owner", async () => {
    const { transport, kinds } = identityTrackingTransport();
    await transport
      .createCheckout({ offerId: "personal-monthly", installationId: "inst-1", idempotencyKey: "idem-1" })
      .catch(() => {});
    await transport.createPortalSession({ installationId: "inst-1" }).catch(() => {});
    expect(kinds).toEqual(["installation", "installation"]);
  });
});
