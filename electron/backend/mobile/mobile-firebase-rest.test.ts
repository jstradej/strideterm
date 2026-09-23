import { describe, expect, test, vi } from "vitest";
import {
  consumeEventStream,
  createMobileFirebaseRestClient,
  MobileFirebaseCallableError,
  MobileFirebasePermissionDeniedError,
  type FetchLike,
  type RtdbStreamEvent,
} from "./mobile-firebase-rest.js";
import { MOBILE_FIREBASE_ENV_VARS, resolveMobileFirebaseConfig } from "./mobile-firebase-config.js";
import { FUNCTIONS_REGION } from "./mobile-rtdb-paths.js";

const CONFIG = resolveMobileFirebaseConfig(
  {
    STRIDETERM_ENV: "local",
    [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
    [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
    [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
    [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
  },
  FUNCTIONS_REGION,
).config!;

function makeCredentialStore(initial: Record<string, string> = {}) {
  const secrets = new Map(Object.entries(initial));
  return {
    secrets,
    getSecret: (ref: string) => secrets.get(ref) ?? "",
    setSecret: async (ref: string, value: string) => void secrets.set(ref, value),
    deleteSecret: async (ref: string) => void secrets.delete(ref),
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A `fetch` stand-in that matches on URL substrings, so tests read as "when asked for X, answer Y". */
function makeFetch(routes: { match: string; respond: (call: RecordedCall) => Response }[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const route = routes.find((r) => input.includes(r.match));
    if (!route) throw new Error(`unrouted fetch: ${input}`);
    return route.respond(call);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const REFRESH_REF = "mobile:firebase-refresh-token";

describe("Auth session lifecycle", () => {
  test("signs in anonymously on first use and persists the refresh token to the credential store", async () => {
    const credentialStore = makeCredentialStore();
    const { fetchImpl, calls } = makeFetch([
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-1", refreshToken: "refresh-1", localId: "uid-1", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => 1_000,
    });

    const session = await client.signIn();
    expect(session).toMatchObject({ idToken: "id-1", uid: "uid-1" });
    expect(session.expiresAt).toBe(1_000 + 3_600_000);
    // The refresh token is the only durable credential — it must be in the credential store, not
    // on disk in the clear and not only in memory (Firebase Auth cannot persist it headlessly).
    expect(credentialStore.secrets.get(REFRESH_REF)).toBe("refresh-1");
    expect(calls).toHaveLength(1);
  });

  test("a restarted process restores the SAME uid from the stored refresh token", async () => {
    // This is review §P0.2's "restarting the headless runtime restores identity/session in a
    // defined way": the uid is what pair membership is keyed on, so a new anonymous account on
    // every start would silently drop the desktop out of its own pair.
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-1" });
    const { fetchImpl, calls } = makeFetch([
      {
        match: "securetoken",
        respond: () => json({ id_token: "id-2", refresh_token: "refresh-1", user_id: "uid-1", expires_in: "3600" }),
      },
      { match: "accounts:signUp", respond: () => json({}, { status: 500 }) },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => 1_000,
    });

    const session = await client.signIn();
    expect(session.uid).toBe("uid-1");
    expect(session.idToken).toBe("id-2");
    expect(calls.every((c) => !c.url.includes("signUp"))).toBe(true);
  });

  test("a rotated refresh token replaces the stored one", async () => {
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-old" });
    const { fetchImpl } = makeFetch([
      {
        match: "securetoken",
        respond: () => json({ id_token: "id", refresh_token: "refresh-new", user_id: "uid-1", expires_in: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });
    await client.signIn();
    expect(credentialStore.secrets.get(REFRESH_REF)).toBe("refresh-new");
  });

  test("a claims refresh starts a new exchange after an older session request settles", async () => {
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-1" });
    let releaseOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let exchanges = 0;
    const fetchImpl: FetchLike = async (input) => {
      if (!input.includes("securetoken")) throw new Error(`unrouted fetch: ${input}`);
      exchanges += 1;
      if (exchanges === 1) await oldResponse;
      return json({
        id_token: exchanges === 1 ? "id-before-claims" : "id-with-claims",
        refresh_token: "refresh-1",
        user_id: "uid-1",
        expires_in: "3600",
      });
    };
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });

    const ordinarySession = client.currentSession();
    const claimsSession = client.refreshSession();
    releaseOld();

    await expect(ordinarySession).resolves.toMatchObject({ idToken: "id-before-claims" });
    await expect(claimsSession).resolves.toMatchObject({ idToken: "id-with-claims" });
    expect(exchanges).toBe(2);
  });

  test("an unusable stored refresh token falls back to a fresh anonymous account and clears it", async () => {
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "revoked" });
    const { fetchImpl } = makeFetch([
      { match: "securetoken", respond: () => json({ error: { message: "TOKEN_EXPIRED" } }, { status: 400 }) },
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-3", refreshToken: "refresh-3", localId: "uid-3", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });
    const session = await client.signIn();
    expect(session.uid).toBe("uid-3");
    expect(credentialStore.secrets.get(REFRESH_REF)).toBe("refresh-3");
  });

  // A NEW uid is not a recovery, it is a silent unpairing: pair membership is keyed on uid, so a
  // desktop that re-signs-in anonymously is a stranger to every phone it was paired with. On
  // 2026-08-24 a single `TypeError: fetch failed` inside the token exchange did exactly that, and
  // the desktop then spent hours being refused by the rules while its own UI said "Connected".
  // These three tests are the three ways the endpoint can fail WITHOUT refusing the credential.
  test("a network failure keeps the stored refresh token instead of minting a new identity", async () => {
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-good" });
    const { fetchImpl, calls } = makeFetch([
      {
        match: "securetoken",
        respond: () => {
          // undici's own error for a dropped connection, verbatim in shape.
          throw new TypeError("fetch failed");
        },
      },
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-new", refreshToken: "refresh-new", localId: "uid-new", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });

    await expect(client.signIn()).rejects.toThrow(TypeError);

    expect(credentialStore.secrets.get(REFRESH_REF)).toBe("refresh-good");
    expect(calls.every((c) => !c.url.includes("signUp"))).toBe(true);
  });

  test("a 5xx from the token endpoint keeps the stored refresh token", async () => {
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-good" });
    const { fetchImpl, calls } = makeFetch([
      { match: "securetoken", respond: () => json({ error: { message: "BACKEND_ERROR" } }, { status: 503 }) },
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-new", refreshToken: "refresh-new", localId: "uid-new", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });

    await expect(client.signIn()).rejects.toThrow(/Firebase Auth refresh failed \(503\)/);

    expect(credentialStore.secrets.get(REFRESH_REF)).toBe("refresh-good");
    expect(calls.every((c) => !c.url.includes("signUp"))).toBe(true);
  });

  test("a 4xx whose reason we do not recognise keeps the stored refresh token", async () => {
    // A captive portal, a proxy error page, a future Identity Toolkit reason. None of them is
    // evidence that this credential is dead, and treating them as such costs the pairing.
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-good" });
    const { fetchImpl, calls } = makeFetch([
      { match: "securetoken", respond: () => new Response("<html>Sign in to the hotel wifi</html>", { status: 400 }) },
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-new", refreshToken: "refresh-new", localId: "uid-new", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });

    await expect(client.signIn()).rejects.toThrow(/Firebase Auth refresh failed \(400\)/);

    expect(credentialStore.secrets.get(REFRESH_REF)).toBe("refresh-good");
    expect(calls.every((c) => !c.url.includes("signUp"))).toBe(true);
  });

  test("the refresh failure message never carries the response body", async () => {
    // The body is remote-controlled text and this message reaches a log through establishSession.
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-good" });
    const { fetchImpl } = makeFetch([
      {
        match: "securetoken",
        respond: () => json({ error: { message: "SOMETHING_NEW" }, secret: "leak-me" }, { status: 400 }),
      },
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id", refreshToken: "r", localId: "u", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });

    await expect(client.signIn()).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("leak-me") }),
    );
  });

  test("the OAuth-shaped refusal is a refusal too, and does re-sign-in", async () => {
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "revoked" });
    const { fetchImpl } = makeFetch([
      { match: "securetoken", respond: () => json({ error: "invalid_grant" }, { status: 400 }) },
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-4", refreshToken: "refresh-4", localId: "uid-4", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });

    const session = await client.signIn();

    expect(session.uid).toBe("uid-4");
    expect(credentialStore.secrets.get(REFRESH_REF)).toBe("refresh-4");
  });

  test("the id token is cached until near expiry, then refreshed once", async () => {
    const credentialStore = makeCredentialStore();
    let clock = 0;
    const { fetchImpl, calls } = makeFetch([
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-1", refreshToken: "refresh-1", localId: "uid-1", expiresIn: "3600" }),
      },
      {
        match: "securetoken",
        respond: () => json({ id_token: "id-2", refresh_token: "refresh-1", user_id: "uid-1", expires_in: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => clock,
    });

    expect((await client.currentSession()).idToken).toBe("id-1");
    expect((await client.currentSession()).idToken).toBe("id-1");
    expect(calls).toHaveLength(1);

    clock = 3_600_000; // past the refresh margin
    expect((await client.currentSession()).idToken).toBe("id-2");
    expect(calls).toHaveLength(2);
  });

  test("concurrent callers share one sign-in rather than racing several", async () => {
    const credentialStore = makeCredentialStore();
    const { fetchImpl, calls } = makeFetch([
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-1", refreshToken: "refresh-1", localId: "uid-1", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });
    await Promise.all([client.signIn(), client.signIn(), client.signIn()]);
    expect(calls).toHaveLength(1);
  });

  test("forgetSession drops the persisted credential, so the next sign-in is a new identity", async () => {
    const credentialStore = makeCredentialStore({ [REFRESH_REF]: "refresh-1" });
    const { fetchImpl } = makeFetch([
      {
        match: "securetoken",
        respond: () => json({ id_token: "id", refresh_token: "refresh-1", user_id: "uid-1", expires_in: "3600" }),
      },
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-new", refreshToken: "refresh-new", localId: "uid-new", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });
    expect((await client.signIn()).uid).toBe("uid-1");
    await client.forgetSession();
    expect(credentialStore.secrets.has(REFRESH_REF)).toBe(false);
    expect((await client.signIn()).uid).toBe("uid-new");
  });
});

describe("RTDB operations", () => {
  function clientWith(routes: Parameters<typeof makeFetch>[0]) {
    const { fetchImpl, calls } = makeFetch([
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-1", refreshToken: "refresh-1", localId: "uid-1", expiresIn: "3600" }),
      },
      ...routes,
    ]);
    return {
      calls,
      client: createMobileFirebaseRestClient({
        config: CONFIG,
        credentialStore: makeCredentialStore(),
        refreshTokenRef: REFRESH_REF,
        fetchImpl,
      }),
    };
  }

  test("get returns the parsed value and attaches the id token", async () => {
    const { client, calls } = clientWith([
      { match: "v1/pairs/p1/publicMeta.json", respond: () => json({ desktopUid: "uid-1" }) },
    ]);
    expect(await client.get("v1/pairs/p1/publicMeta")).toEqual({ desktopUid: "uid-1" });
    const call = calls.find((c) => c.url.includes("publicMeta"))!;
    expect(new URL(call.url).searchParams.get("auth")).toBe("id-1");
  });

  test("get returns null for an absent node rather than throwing", async () => {
    const { client } = clientWith([{ match: "v1/pairs", respond: () => new Response("null", { status: 200 }) }]);
    expect(await client.get("v1/pairs/nope")).toBeNull();
  });

  test("a rules rejection surfaces as MobileFirebasePermissionDeniedError, not a generic error", async () => {
    const { client } = clientWith([
      { match: "v1/pairs", respond: () => json({ error: "Permission denied" }, { status: 401 }) },
    ]);
    await expect(client.set("v1/pairs/p1/events/e1", {})).rejects.toBeInstanceOf(MobileFirebasePermissionDeniedError);
  });

  test("updateMulti PATCHes the database root with absolute path keys", async () => {
    const { client, calls } = clientWith([{ match: "/.json", respond: () => json({}) }]);
    await client.updateMulti({ "v1/pairs/p1/quotaWindows/w1": { count: 1 } });
    const call = calls.find((c) => c.method === "PATCH")!;
    expect(new URL(call.url).pathname).toBe("/.json");
    expect(JSON.parse(call.body!)).toEqual({ "v1/pairs/p1/quotaWindows/w1": { count: 1 } });
  });

  test("getWithEtag asks for the ETag header and returns it", async () => {
    const { client, calls } = clientWith([
      {
        match: "counter.json",
        respond: () => json(3, { headers: { etag: "etag-abc", "content-type": "application/json" } }),
      },
    ]);
    const result = await client.getWithEtag<number>("v1/counter");
    expect(result).toEqual({ value: 3, etag: "etag-abc" });
    expect(calls.at(-1)!.headers["x-firebase-etag"]).toBe("true");
  });

  test("setIfMatch returns false on a 412 instead of throwing, so the caller can retry", async () => {
    const { client, calls } = clientWith([
      {
        match: "counter.json",
        respond: (call) => (call.headers["if-match"] === "stale" ? new Response("", { status: 412 }) : json(4)),
      },
    ]);
    expect(await client.setIfMatch("v1/counter", 4, "stale")).toBe(false);
    expect(await client.setIfMatch("v1/counter", 4, "fresh")).toBe(true);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });
});

describe("RTDB stream lifecycle", () => {
  test("auth_revoked refreshes the token and reconnects even when the old response stays open", async () => {
    const credentialStore = makeCredentialStore();
    const encoder = new TextEncoder();
    const streamTokens: string[] = [];
    let refreshCalls = 0;

    const firstStream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Firebase may leave this HTTP response open after the terminal frame. This deliberately
        // never closes: the client itself must stop consuming it and create a new request.
        controller.enqueue(encoder.encode("event: auth_revoked\ndata: credential is no longer valid\n\n"));
      },
    });
    const secondStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: put\ndata: {"path":"/command-2","data":{"ok":true}}\n\n'));
        controller.close();
      },
    });

    const fetchImpl: FetchLike = async (input) => {
      if (input.includes("accounts:signUp")) {
        return json({
          idToken: "id-expired",
          refreshToken: "refresh-1",
          localId: "uid-1",
          expiresIn: "3600",
        });
      }
      if (input.includes("securetoken")) {
        refreshCalls += 1;
        return json({
          id_token: "id-refreshed",
          refresh_token: "refresh-1",
          user_id: "uid-1",
          expires_in: "3600",
        });
      }
      const token = new URL(input).searchParams.get("auth") ?? "";
      streamTokens.push(token);
      return new Response(streamTokens.length === 1 ? firstStream : secondStream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore,
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
    });

    let stop = () => {};
    const delivered = new Promise<void>((resolve) => {
      stop = client.stream("v2/pairs/pair-1/commands", {
        onEvent: (event) => {
          if (event.path !== "/command-2") return;
          stop();
          resolve();
        },
      });
    });

    await delivered;
    expect(streamTokens).toEqual(["id-expired", "id-refreshed"]);
    expect(refreshCalls).toBe(1);
  });

  test("reconnects with a fresh authParams() call after the stream goes idle for 90s", async () => {
    vi.useFakeTimers();
    try {
      const credentialStore = makeCredentialStore();
      const encoder = new TextEncoder();
      let streamRequests = 0;

      const deadStream = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueues, never closes: a connection that silently died in the network rather
          // than one Firebase ended cleanly.
        },
      });
      const liveStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: put\ndata: {"path":"/after-idle","data":{"ok":true}}\n\n'));
        },
      });

      const fetchImpl: FetchLike = async (input) => {
        if (input.includes("accounts:signUp")) {
          return json({ idToken: "id-1", refreshToken: "refresh-1", localId: "uid-1", expiresIn: "3600" });
        }
        streamRequests += 1;
        return new Response(streamRequests === 1 ? deadStream : liveStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const client = createMobileFirebaseRestClient({
        config: CONFIG,
        credentialStore,
        refreshTokenRef: REFRESH_REF,
        fetchImpl,
      });

      const delivered = new Promise<void>((resolve) => {
        client.stream("v2/pairs/pair-1/commands", {
          onEvent: (event) => {
            if (event.path === "/after-idle") resolve();
          },
        });
      });

      // 90s idle timeout, then the fixed 500ms reconnect backoff before the second request.
      await vi.advanceTimersByTimeAsync(90_000 + 500);
      await delivered;
      expect(streamRequests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server clock", () => {
  /** A `Date` header is what every real Firebase response carries; `json()` above deliberately has none. */
  function dated(at: number, body: unknown = {}, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      ...init,
      headers: { "content-type": "application/json", date: new Date(at).toUTCString(), ...(init.headers ?? {}) },
    });
  }

  const SERVER_AT = Date.UTC(2026, 7, 16, 12, 0, 0);

  test("serverNow reports the server's clock, not this machine's, when the two disagree", async () => {
    // The whole point: a desktop ten minutes fast must still name the quota window the server is
    // actually in, or database.rules.json rejects every bump it makes (see the quotaWindows rule,
    // which alone has no clock-skew tolerance).
    const localClock = SERVER_AT + 10 * 60_000;
    const { fetchImpl } = makeFetch([{ match: "/.json", respond: () => dated(SERVER_AT) }]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore: makeCredentialStore(),
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => localClock,
    });
    expect(await client.serverNow()).toBe(SERVER_AT);
  });

  test("an ordinary request feeds the sample, so no extra round trip is needed", async () => {
    const localClock = SERVER_AT - 45_000;
    const { fetchImpl, calls } = makeFetch([
      {
        match: "accounts:signUp",
        respond: () => dated(SERVER_AT, { idToken: "id-1", refreshToken: "r", localId: "uid-1", expiresIn: "3600" }),
      },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore: makeCredentialStore(),
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => localClock,
    });
    await client.signIn();
    expect(await client.serverNow()).toBe(SERVER_AT);
    // One call total — the sign-in. `/.json` was never probed, because a sample already existed.
    expect(calls).toHaveLength(1);
  });

  test("a probe that is rejected by the rules still yields a usable sample", async () => {
    // The probe is deliberately unauthenticated: a 401 carries the same `Date` header, which is
    // all it is after, and not needing a session keeps serverNow callable before sign-in.
    const { fetchImpl, calls } = makeFetch([
      { match: "/.json", respond: () => dated(SERVER_AT, { error: "Permission denied" }, { status: 401 }) },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore: makeCredentialStore(),
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => SERVER_AT + 3_600_000,
    });
    expect(await client.serverNow()).toBe(SERVER_AT);
    expect(new URL(calls[0]!.url).searchParams.get("auth")).toBeNull();
  });

  test("falls back to the local clock when the server cannot be reached", async () => {
    // Degrading to the previous behaviour beats failing the write outright.
    const localClock = 1_700_000_000_000;
    const fetchImpl: FetchLike = async () => {
      throw new Error("offline");
    };
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore: makeCredentialStore(),
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => localClock,
    });
    expect(await client.serverNow()).toBe(localClock);
  });

  test("a response with no usable Date header leaves the local clock in charge", async () => {
    const localClock = 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { match: "/.json", respond: () => json({}, { headers: { date: "not a date" } }) },
    ]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore: makeCredentialStore(),
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => localClock,
    });
    expect(await client.serverNow()).toBe(localClock);
  });

  test("a stale sample is re-taken rather than drifting with the local clock", async () => {
    let clock = SERVER_AT;
    let serverAt = SERVER_AT;
    const { fetchImpl, calls } = makeFetch([{ match: "/.json", respond: () => dated(serverAt) }]);
    const client = createMobileFirebaseRestClient({
      config: CONFIG,
      credentialStore: makeCredentialStore(),
      refreshTokenRef: REFRESH_REF,
      fetchImpl,
      now: () => clock,
    });
    expect(await client.serverNow()).toBe(SERVER_AT);
    expect(calls).toHaveLength(1);

    // Six minutes later on this machine — but the desktop's clock also slipped a minute meanwhile.
    clock = SERVER_AT + 6 * 60_000;
    serverAt = SERVER_AT + 7 * 60_000;
    expect(await client.serverNow()).toBe(serverAt);
    expect(calls).toHaveLength(2);
  });
});

describe("callable functions", () => {
  function callableClient(respond: (call: RecordedCall) => Response) {
    const { fetchImpl, calls } = makeFetch([
      {
        match: "accounts:signUp",
        respond: () => json({ idToken: "id-1", refreshToken: "r", localId: "uid-1", expiresIn: "3600" }),
      },
      { match: "5001", respond },
    ]);
    return {
      calls,
      client: createMobileFirebaseRestClient({
        config: CONFIG,
        credentialStore: makeCredentialStore(),
        refreshTokenRef: REFRESH_REF,
        fetchImpl,
      }),
    };
  }

  test("posts {data} with a Bearer id token to the region-qualified URL", async () => {
    const { client, calls } = callableClient(() => json({ result: { pairingId: "pi-1", expiresAt: 42 } }));
    const result = await client.callFunction<{ pairingId: string }>("createPairingInvitation", { a: 1 });
    expect(result).toEqual({ pairingId: "pi-1", expiresAt: 42 });
    const call = calls.at(-1)!;
    expect(call.url).toBe(`http://127.0.0.1:5001/demo-strideterm/${FUNCTIONS_REGION}/createPairingInvitation`);
    expect(call.headers.authorization).toBe("Bearer id-1");
    expect(JSON.parse(call.body!)).toEqual({ data: { a: 1 } });
  });

  test("an HttpsError body becomes MobileFirebaseCallableError carrying the status", async () => {
    const { client } = callableClient(() =>
      json({ error: { status: "RESOURCE_EXHAUSTED", message: "too many invitations" } }, { status: 429 }),
    );
    await expect(client.callFunction("createPairingInvitation", {})).rejects.toMatchObject({
      name: "MobileFirebaseCallableError",
      status: "RESOURCE_EXHAUSTED",
    });
  });

  test("classifies the reviewed pairing refusal without retaining remote text", async () => {
    const { client } = callableClient(() =>
      json(
        {
          error: {
            status: "PERMISSION_DENIED",
            message:
              "This desktop device id is already paired under a different account, or its key cannot be rotated while devices are still paired.",
          },
        },
        { status: 403 },
      ),
    );
    await expect(client.callFunction("createPairingInvitation", {})).rejects.toMatchObject({
      message: "createPairingInvitation failed (PERMISSION_DENIED: desktop-device-conflict)",
      reason: "desktop-device-conflict",
    });
  });

  test("does not echo an unrecognized callable message", async () => {
    const secret = "secret-that-must-not-reach-the-error";
    const { client } = callableClient(() =>
      json({ error: { status: "PERMISSION_DENIED", message: `unexpected refusal: ${secret}` } }, { status: 403 }),
    );
    await expect(client.callFunction("createPairingInvitation", {})).rejects.toMatchObject({
      message: "createPairingInvitation failed (PERMISSION_DENIED)",
      reason: null,
    });
  });

  test("a non-OK response with no error body still throws rather than returning null", async () => {
    const { client } = callableClient(() => new Response("upstream exploded", { status: 502 }));
    await expect(client.callFunction("claimPairing", {})).rejects.toBeInstanceOf(MobileFirebaseCallableError);
  });
});

describe("server-sent event framing", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  async function collect(chunks: string[]): Promise<{ events: RtdbStreamEvent[]; errors: string[] }> {
    const events: RtdbStreamEvent[] = [];
    const errors: string[] = [];
    await consumeEventStream(
      streamOf(chunks),
      { onEvent: (e) => events.push(e), onError: (e) => errors.push(e.message) },
      () => false,
    );
    return { events, errors };
  }

  test("parses put and patch frames", async () => {
    const { events } = await collect([
      'event: put\ndata: {"path":"/","data":{"c1":{"messageId":"c1"}}}\n\n',
      'event: patch\ndata: {"path":"/c2","data":{"messageId":"c2"}}\n\n',
    ]);
    expect(events).toEqual([
      { type: "put", path: "/", data: { c1: { messageId: "c1" } } },
      { type: "patch", path: "/c2", data: { messageId: "c2" } },
    ]);
  });

  test("reassembles a frame split across chunk boundaries", async () => {
    // The failure this guards against only appears against a real server: an event that arrives
    // in two TCP reads would otherwise be parsed as two malformed halves.
    const { events, errors } = await collect(['event: put\ndata: {"path":"/a",', '"data":{"n":1}}\n\n']);
    expect(errors).toEqual([]);
    expect(events).toEqual([{ type: "put", path: "/a", data: { n: 1 } }]);
  });

  test("ignores keep-alive frames", async () => {
    const { events, errors } = await collect(["event: keep-alive\ndata: null\n\n"]);
    expect(events).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("surfaces cancel/auth_revoked as errors so the reconnect loop re-authenticates", async () => {
    const { errors } = await collect(["event: auth_revoked\ndata: credential is no longer valid\n\n"]);
    expect(errors).toEqual(["RTDB stream auth_revoked"]);
  });

  test("reports an unparseable frame instead of throwing out of the loop", async () => {
    const { events, errors } = await collect(["event: put\ndata: {not json}\n\n"]);
    expect(events).toEqual([]);
    expect(errors[0]).toContain("unparseable");
  });

  test("a deletion arrives as a put with null data", async () => {
    const { events } = await collect(['event: put\ndata: {"path":"/c1","data":null}\n\n']);
    expect(events).toEqual([{ type: "put", path: "/c1", data: null }]);
  });

  test("declares the stream idle after 90s with no frame at all, not just no data frame", async () => {
    vi.useFakeTimers();
    try {
      // Enqueues once, then never again and never closes — a silently dropped connection (NAT,
      // proxy, sleeping network adapter) looks exactly like this: `reader.read()` simply never
      // resolves again on its own.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: put\ndata: {"path":"/","data":1}\n\n'));
        },
      });
      const events: RtdbStreamEvent[] = [];
      const result = consumeEventStream(stream, { onEvent: (e) => events.push(e) }, () => false);
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(result).resolves.toBe("idle");
      expect(events).toEqual([{ type: "put", path: "/", data: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a steady stream of keep-alives never trips the idle watchdog", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let ticks = 0;
          const emit = (): void => {
            ticks += 1;
            controller.enqueue(encoder.encode("event: keep-alive\ndata: null\n\n"));
            if (ticks >= 5) {
              controller.close();
              return;
            }
            setTimeout(emit, 30_000);
          };
          setTimeout(emit, 30_000);
        },
      });
      const result = consumeEventStream(stream, { onEvent: () => {} }, () => false);
      // 5 * 30s = 150s of total elapsed time, comfortably past the 90s idle window — but every
      // keep-alive arrives well inside it, so the watchdog must never fire.
      await vi.advanceTimersByTimeAsync(5 * 30_000 + 1_000);
      await expect(result).resolves.toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });
});
