// The bootstrap client: what it keeps, what it refuses, and what it must never break.
//
// The assertions that matter are the negative ones. A recovery mechanism that could take down a
// healthy install is a liability, so every failure path here has to leave the working configuration
// exactly where it was — and the rollback floor has to survive the envelope file being deleted, or
// "monotonic epoch" would only mean "monotonic until somebody clears the cache".
import { createPrivateKey, createPublicKey, sign as signEd25519 } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BOOTSTRAP_ENV_VARS, bootstrapEnvironmentFor, bootstrapTrustSet, parseTrustKeys } from "./bootstrap-trust.js";
import {
  configFromBootstrap,
  createControlPlaneBootstrapClient,
  resolveBootstrapFirebaseConfig,
} from "./bootstrap-client.js";
import { resolveMobileFirebaseConfig } from "./mobile-firebase-config.js";
import {
  bootstrapSigningInput,
  BOOTSTRAP_SCHEMA_VERSION,
  type ControlPlaneBootstrapPayload,
} from "./control-plane-bootstrap.js";

/** A fixed Ed25519 seed. A published test vector, never a credential. */
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const KEY_ID = "bootstrap-test";
const NOW = Date.UTC(2026, 5, 1);

const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]),
  format: "der",
  type: "pkcs8",
});
/** The last 32 bytes of the SPKI encoding are the raw Ed25519 public key. */
const publicRaw = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32));

function payload(overrides: Partial<ControlPlaneBootstrapPayload> = {}): ControlPlaneBootstrapPayload {
  return {
    // The build's OWN version, so a bump does not silently turn every case here into
    // `unsupported-version` — which is a real refusal and would make these tests pass for the wrong
    // reason.
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    environment: "prod",
    configEpoch: 5,
    issuedAt: NOW - 86_400_000,
    projectId: "strideterm-prod",
    apiKey: "AIzaSy-public-identifier",
    appId: "1:1:android:abc",
    messagingSenderId: "1",
    databaseUrl: "https://strideterm-prod-default-rtdb.europe-west1.firebasedatabase.app",
    functionsBaseUrl: "https://europe-west1-strideterm-prod.cloudfunctions.net",
    ...overrides,
  };
}

function envelopeFor(body: ControlPlaneBootstrapPayload) {
  return {
    v: 1 as const,
    keyId: KEY_ID,
    payload: body,
    signature: signEd25519(null, Buffer.from(bootstrapSigningInput(body)), privateKey).toString("base64"),
  };
}

let stateDir = "";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "strideterm-bootstrap-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function client(
  options: {
    respond?: (input?: RequestInit) => Promise<Response>;
    url?: string | undefined;
    environment?: "local" | "dev" | "qa" | "prod";
    stateDir?: string;
    timeoutMs?: number;
  } = {},
) {
  return createControlPlaneBootstrapClient({
    stateDir: options.stateDir ?? stateDir,
    environment: options.environment ?? "prod",
    url: "url" in options ? options.url : "https://bootstrap.strideterm.com/prod.json",
    trust: { keys: new Map([[KEY_ID, publicRaw]]) },
    now: () => NOW,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.respond
      ? (_url, init) => options.respond!(init)
      : async () => new Response(JSON.stringify(envelopeFor(payload())), { status: 200 }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("adopting an envelope", () => {
  test("a fresh install with nothing stored accepts the first valid envelope", async () => {
    const result = await client().refresh();
    expect(result.changed).toBe(true);
    expect(result.envelope?.payload.projectId).toBe("strideterm-prod");
  });

  test("what was adopted survives a restart", async () => {
    await client().refresh();
    expect(client().current()?.payload.configEpoch).toBe(5);
    expect(client().highestSeenEpoch()).toBe(5);
  });

  test("a higher epoch replaces it; an equal or lower one does not", async () => {
    await client().refresh();
    const higher = await client({
      respond: async () => new Response(JSON.stringify(envelopeFor(payload({ configEpoch: 9 }))), { status: 200 }),
    }).refresh();
    expect(higher.changed).toBe(true);
    expect(higher.envelope?.payload.configEpoch).toBe(9);

    for (const replayed of [9, 5, 1]) {
      const result = await client({
        respond: async () =>
          new Response(JSON.stringify(envelopeFor(payload({ configEpoch: replayed }))), { status: 200 }),
      }).refresh();
      expect(result.changed).toBe(false);
      expect(result.refusal).toBe("epoch-not-newer");
      expect(result.envelope?.payload.configEpoch).toBe(9);
      if (replayed === 9) {
        // An identical signed document at the accepted epoch is the normal unchanged case.
        expect(result.error).toBeUndefined();
      } else {
        // A different same-epoch document or an older document is a rollback/refusal worth surfacing.
        expect(result.error).toMatchObject({ stage: "verify", category: "verification", refusal: "epoch-not-newer" });
      }
    }
  });

  test("an identical current epoch is a normal unchanged result", async () => {
    await client().refresh();
    const result = await client().refresh();
    expect(result).toMatchObject({ changed: false, refusal: "epoch-not-newer" });
    expect(result.error).toBeUndefined();
    expect(result.envelope?.payload.configEpoch).toBe(5);
  });

  test("a different signed payload at the current epoch is refused and diagnosed", async () => {
    await client({
      respond: async () => new Response(JSON.stringify(envelopeFor(payload({ configEpoch: 9 }))), { status: 200 }),
    }).refresh();
    const conflict = payload({
      configEpoch: 9,
      projectId: "strideterm-conflicting-project",
      databaseUrl: "https://strideterm-conflicting-project-default-rtdb.europe-west1.firebasedatabase.app",
      functionsBaseUrl: "https://europe-west1-strideterm-conflicting-project.cloudfunctions.net",
    });
    const result = await client({
      respond: async () => new Response(JSON.stringify(envelopeFor(conflict)), { status: 200 }),
    }).refresh();
    expect(result.envelope?.payload.projectId).toBe("strideterm-prod");
    expect(result.error).toMatchObject({ stage: "verify", category: "verification", refusal: "epoch-not-newer" });
    expect(result.error?.message).toContain("already accepted epoch");
  });

  test("the rollback floor survives the envelope being deleted", async () => {
    // Otherwise "monotonic epoch" would mean "monotonic until somebody clears the cache", and the
    // replay this rule exists to stop would work on any machine whose state file was removed.
    await client({
      respond: async () => new Response(JSON.stringify(envelopeFor(payload({ configEpoch: 9 }))), { status: 200 }),
    }).refresh();
    const statePath = join(stateDir, "control-plane-bootstrap.json");
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    delete stored.envelope;
    writeFileSync(statePath, JSON.stringify(stored));

    const replay = await client({
      respond: async () => new Response(JSON.stringify(envelopeFor(payload({ configEpoch: 5 }))), { status: 200 }),
    }).refresh();
    expect(replay.refusal).toBe("epoch-not-newer");
  });
});

describe("never making things worse", () => {
  test("a network failure changes nothing and reports itself", async () => {
    await client().refresh();
    const result = await client({
      respond: async () => {
        throw new Error("offline");
      },
    }).refresh();
    expect(result.refusal).toBe("network");
    expect(result.changed).toBe(false);
    expect(result.envelope?.payload.configEpoch).toBe(5);
  });

  test("a DNS failure keeps only a safe code, category and fixed copy", async () => {
    const result = await client({
      respond: async () => {
        const cause = Object.assign(new Error("private proxy detail"), { code: "ENOTFOUND" });
        throw Object.assign(new TypeError("raw host and request data"), { cause });
      },
    }).refresh();
    expect(result.error).toMatchObject({
      stage: "fetch",
      category: "dns",
      code: "ENOTFOUND",
      url: "https://bootstrap.strideterm.com/prod.json",
      message: "The server address could not be resolved.",
    });
    expect(JSON.stringify(result.error)).not.toContain("private proxy detail");
    expect(JSON.stringify(result.error)).not.toContain("raw host");
  });

  test("HTTP 429 reports a bounded Retry-After and redirects are never followed", async () => {
    const limited = await client({
      respond: async () => new Response("ignored body", { status: 429, headers: { "retry-after": "30" } }),
    }).refresh();
    expect(limited.error).toMatchObject({ stage: "fetch", category: "http", status: 429, retryAfterMs: 30_000 });

    let requests = 0;
    const redirected = await client({
      respond: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/config.json" } });
      },
    }).refresh();
    expect(requests).toBe(1);
    expect(redirected.error).toMatchObject({ stage: "fetch", category: "redirect", status: 302 });
  });

  test("timeout is distinct from caller cancellation", async () => {
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
          once: true,
        });
      });
    const timedOut = await client({
      timeoutMs: 5,
      respond: async (init) => waitForAbort(init!.signal as AbortSignal),
    }).refresh();
    expect(timedOut.error).toMatchObject({
      stage: "fetch",
      category: "timeout",
      message: "The server did not respond within 1 seconds.",
    });

    const controller = new AbortController();
    const entered = deferred<void>();
    const cancelledPromise = client({
      timeoutMs: 5_000,
      respond: async (init) => {
        entered.resolve();
        return waitForAbort(init!.signal as AbortSignal);
      },
    }).refresh({ signal: controller.signal });
    await entered.promise;
    controller.abort();
    const cancelled = await cancelledPromise;
    expect(cancelled.error).toMatchObject({ stage: "fetch", category: "cancelled" });
  });

  test("caller cancellation interrupts a streamed response body", async () => {
    const controller = new AbortController();
    const bodyRead = deferred<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("{"));
        bodyRead.resolve();
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = client({ respond: async () => new Response(body, { status: 200 }), timeoutMs: 5_000 }).refresh({
      signal: controller.signal,
    });
    await bodyRead.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await pending;
    expect(result.error).toMatchObject({ stage: "fetch", category: "cancelled" });
    expect(cancelled).toBe(true);
  });

  test("an oversized stream cannot hold refresh open while its cancellation cleanup stalls", async () => {
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(64 * 1024));
        stream.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
    });
    const result = await Promise.race([
      client({ respond: async () => new Response(body, { status: 200 }), timeoutMs: 10_000 }).refresh(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    expect(cancelCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result && result.error).toMatchObject({ category: "invalid-response", code: "BOOTSTRAP_TOO_LARGE" });
  });

  test("diagnostics never include URL credentials, query secrets, or unsupported schemes", async () => {
    const secretUrl = "https://user:password@bootstrap.example/prod.json?token=private";
    const controller = new AbortController();
    controller.abort();
    const result = await client({ url: secretUrl }).refresh({ signal: controller.signal });
    expect(JSON.stringify(result.error)).not.toContain("password");
    expect(JSON.stringify(result.error)).not.toContain("token=private");

    const unsupported = await client({
      url: "ftp://bootstrap.example/prod.json",
      respond: async () => {
        throw new Error("offline");
      },
    }).refresh();
    expect(unsupported.error?.url).toBeUndefined();
  });

  test("an unavailable refresh can use only a verified cached envelope", async () => {
    await client().refresh();
    const available = await client({
      respond: async () => {
        throw new Error("offline");
      },
    }).refresh();
    expect(available.envelope?.payload.projectId).toBe("strideterm-prod");
    expect(client({ url: undefined }).currentVerified()?.payload.projectId).toBe("strideterm-prod");

    const statePath = join(stateDir, "control-plane-bootstrap.json");
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as {
      envelope: ReturnType<typeof envelopeFor>;
      highestSeenEpoch: number;
    };
    stored.envelope.signature = Buffer.alloc(64).toString("base64");
    writeFileSync(statePath, JSON.stringify(stored));
    const invalid = await client({
      respond: async () => {
        throw new Error("offline");
      },
    }).refresh();
    expect(invalid.envelope).toBeNull();
    expect(client().currentVerified()).toBeNull();
  });

  test("a non-OK response is a network failure, not an envelope", async () => {
    const result = await client({ respond: async () => new Response("nope", { status: 503 }) }).refresh();
    expect(result.refusal).toBe("network");
    expect(result.envelope).toBeNull();
  });

  test("a body that is not JSON is refused rather than crashing the launch", async () => {
    const result = await client({ respond: async () => new Response("<html>", { status: 200 }) }).refresh();
    expect(result.refusal).toBe("network");
    expect(result.error).toMatchObject({ stage: "fetch", category: "invalid-response", code: "INVALID_JSON" });
  });

  test("oversized streamed bodies are stopped even without Content-Length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await client({ respond: async () => new Response(body, { status: 200 }) }).refresh();
    expect(result.error).toMatchObject({ stage: "fetch", category: "invalid-response", code: "BOOTSTRAP_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  test("an advertised oversized body is cancelled before returning", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = await client({
      respond: async () => new Response(body, { status: 200, headers: { "content-length": String(64 * 1024 + 1) } }),
    }).refresh();
    expect(result.error).toMatchObject({ category: "invalid-response", code: "BOOTSTRAP_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  test("a build with no bootstrap URL says so and keeps what it has", async () => {
    const result = await client({ url: undefined }).refresh();
    expect(result.refusal).toBe("not-configured");
    expect(result.envelope).toBeNull();
  });

  test("an unreadable state file is 'nothing accepted yet', not a failure", () => {
    writeFileSync(join(stateDir, "control-plane-bootstrap.json"), "{ truncated");
    expect(client().current()).toBeNull();
    expect(client().highestSeenEpoch()).toBe(0);
  });

  test("a tampered envelope is refused and the held one stands", async () => {
    await client().refresh();
    const tampered = envelopeFor(payload({ configEpoch: 9 }));
    tampered.payload = { ...tampered.payload, projectId: "attacker-project" };
    const result = await client({
      respond: async () => new Response(JSON.stringify(tampered), { status: 200 }),
    }).refresh();
    expect(result.refusal).toBe("bad-signature");
    expect(result.envelope?.payload.projectId).toBe("strideterm-prod");
  });

  test("a persistence failure is classified separately from a fetch failure", async () => {
    const blockedDirectory = join(stateDir, "not-a-directory");
    writeFileSync(blockedDirectory, "file blocks mkdir");
    const result = await client({ stateDir: blockedDirectory }).refresh();
    expect(result.changed).toBe(false);
    expect(result.error).toMatchObject({ stage: "persist", category: "storage", code: expect.any(String) });
    expect(result.envelope).toBeNull();
  });

  test("a production build refuses an envelope pointing at loopback", async () => {
    const local = envelopeFor(
      payload({ configEpoch: 9, databaseUrl: "https://[::1]:9000", functionsBaseUrl: "https://127.0.0.1:5001" }),
    );
    const result = await client({
      respond: async () => new Response(JSON.stringify(local), { status: 200 }),
    }).refresh();
    expect(result.refusal).toBe("insecure-endpoint");
  });
});

describe("the trust set is the build's", () => {
  test("a prod build ignores the environment entirely", () => {
    const env = {
      [`STRIDETERM_BOOTSTRAP_TRUST_KEYS`]: `${KEY_ID}=${Buffer.from(publicRaw).toString("base64")}`,
      [`STRIDETERM_BOOTSTRAP_URL`]: "https://attacker.example.com/bootstrap.json",
    } as NodeJS.ProcessEnv;
    const compiled = bootstrapTrustSet("prod", {} as NodeJS.ProcessEnv);
    const trust = bootstrapTrustSet("prod", env);
    // If this ever passes a key through, anything that can set an environment variable can point a
    // prod install at its own control plane and the signature proves nothing.
    expect(trust.url).toBe(compiled.url);
    expect([...trust.keys.entries()]).toEqual([...compiled.keys.entries()]);
    expect(trust.url).toBe("https://bootstrap.strideterm.com/prod.json");
    expect(trust.keys.size).toBeGreaterThan(0);
  });

  test("local and dev may supply their own, because they have to", () => {
    for (const environment of ["local", "dev"] as const) {
      const trust = bootstrapTrustSet(environment, {
        STRIDETERM_BOOTSTRAP_TRUST_KEYS: `${KEY_ID}=${Buffer.from(publicRaw).toString("base64")}`,
        STRIDETERM_BOOTSTRAP_URL: "http://127.0.0.1:8080/bootstrap.json",
      } as NodeJS.ProcessEnv);
      expect(trust.keys.get(KEY_ID), environment).toEqual(publicRaw);
      expect(trust.url, environment).toBe("http://127.0.0.1:8080/bootstrap.json");
    }
  });

  test("a qa build ignores the environment entirely, same as prod (plan §3.2)", () => {
    // QA is a tier other people enter, hardened identically to prod: `bootstrap-trust.dart` already
    // refuses this on the mobile side (its own `_qaTrustKeys`/`_qaBootstrapUrl`), and the desktop used
    // to fall through to the env-configurable branch here — the exact divergence plan §3.2 calls out
    // ("zásah jen do desktopového bootstrap-trust.ts nestačí").
    const env = {
      [`STRIDETERM_BOOTSTRAP_TRUST_KEYS`]: `${KEY_ID}=${Buffer.from(publicRaw).toString("base64")}`,
      [`STRIDETERM_BOOTSTRAP_URL`]: "https://attacker.example.com/bootstrap.json",
    } as NodeJS.ProcessEnv;
    const trust = bootstrapTrustSet("qa", env);
    expect(trust.keys.size).toBe(0);
    expect(trust.url).toBeUndefined();
  });

  test("a malformed key is dropped, not thrown: a bad variable must not stop a launch", () => {
    expect(parseTrustKeys(undefined).size).toBe(0);
    expect(parseTrustKeys("nonsense").size).toBe(0);
    expect(parseTrustKeys("k=").size).toBe(0);
    expect(parseTrustKeys("=abcd").size).toBe(0);
    // Right shape, wrong length — not an Ed25519 key.
    expect(parseTrustKeys(`k=${Buffer.alloc(31).toString("base64")}`).size).toBe(0);
    expect(parseTrustKeys(`k=${Buffer.alloc(32).toString("base64")}`).size).toBe(1);
  });

  test("the environment is the DECLARATION, and nothing else — plan §3.1", () => {
    // No project id, no data directory, no Git branch: `bootstrapEnvironmentFor` reads
    // `STRIDETERM_ENV` and nothing else. F11's one explicit source, shared by the Firebase
    // configuration, the bootstrap trust set and the auth broker.
    const declare = (value: string): NodeJS.ProcessEnv =>
      ({ [BOOTSTRAP_ENV_VARS.environment]: value }) as NodeJS.ProcessEnv;
    expect(bootstrapEnvironmentFor(declare("local"))).toBe("local");
    expect(bootstrapEnvironmentFor(declare("dev"))).toBe("dev");
    expect(bootstrapEnvironmentFor(declare("qa"))).toBe("qa");
    expect(bootstrapEnvironmentFor(declare("prod"))).toBe("prod");
    // Case-insensitive and trimmed, like every other declared value in this codebase.
    expect(bootstrapEnvironmentFor(declare(" Qa "))).toBe("qa");
  });

  test("an UNRECOGNISED or ABSENT declaration is unresolved — no guess of any kind", () => {
    // F11: "Chybějící nebo rozporná konfigurace zablokuje nové přihlášení, nepřepne na produkci."
    // Falling through would make a typo silently ineffective, which is the confusion the variable
    // exists to remove. `staging`/`production` are the retired spellings, not aliases.
    for (const value of ["stage", "staging", "production", "PRODUCTION_", "true", ""]) {
      const answer = bootstrapEnvironmentFor({ [BOOTSTRAP_ENV_VARS.environment]: value } as NodeJS.ProcessEnv);
      expect(answer, value).toBe("unresolved");
    }
    // Nothing set at all — no project id to fall back to any more, so this is unresolved too, not a
    // silent `local` or `prod`. That default is `main.ts`'s job now, not this function's.
    expect(bootstrapEnvironmentFor({} as NodeJS.ProcessEnv)).toBe("unresolved");
  });

  test("an ISOLATED DATA DIRECTORY says nothing about the remote backend (F11), and neither does a project id", () => {
    // It used to short-circuit to `dev` at the top of the function, which is the whole finding:
    // `STRIDETERM_DATA_DIR` says where this installation keeps its files. A `--data-dir` production
    // instance is production, and `dev.ps1` now declares `STRIDETERM_ENV=local` explicitly instead.
    // Plan §3.1 goes further: neither the data directory nor a project id is consulted at all any
    // more, so with nothing else declared this is `unresolved`, not a guess.
    expect(
      bootstrapEnvironmentFor({
        STRIDETERM_DATA_DIR: "x",
        STRIDETERM_MOBILE_FIREBASE_PROJECT_ID: "strideterm-prod",
      } as NodeJS.ProcessEnv),
    ).toBe("unresolved");
    expect(
      bootstrapEnvironmentFor({
        STRIDETERM_DATA_DIR: "x",
        STRIDETERM_MOBILE_FIREBASE_PROJECT_ID: "strideterm-prod",
        [BOOTSTRAP_ENV_VARS.environment]: "dev",
      } as NodeJS.ProcessEnv),
    ).toBe("dev");
  });
});

test("the configuration an envelope describes carries no emulator wiring", () => {
  // A signed document that could redirect a client to a loopback emulator is exactly what the
  // endpoint rule refuses in production; letting one do it by another route would undo that.
  const config = configFromBootstrap(envelopeFor(payload()), "europe-west1");
  expect(config).toEqual({
    projectId: "strideterm-prod",
    apiKey: "AIzaSy-public-identifier",
    functionsRegion: "europe-west1",
    emulators: null,
    databaseUrl: "https://strideterm-prod-default-rtdb.europe-west1.firebasedatabase.app",
    // R16: the SIGNED callable endpoint, which used to be dropped. A client that had accepted an
    // envelope pointed its RTDB at the new project and derived its callables from the region and the
    // project id — right by accident for a Firebase-hosted deployment, wrong for every case the
    // field exists for, including a recovery behind a different domain.
    functionsBaseUrl: "https://europe-west1-strideterm-prod.cloudfunctions.net",
    // Empty because this fixture's payload names none. R14's default: a build that has not been told
    // which merchant it uses opens NO billing URL, rather than any.
    billingCheckoutHosts: [],
  });
});

test("a local bootstrap preserves complete emulators and cannot repair or escape their configuration", () => {
  const declared = {
    STRIDETERM_ENV: "local",
    STRIDETERM_MOBILE_FIREBASE_PROJECT_ID: "demo-old",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIREBASE_DATABASE_EMULATOR_HOST: "127.0.0.1:9000",
    FIREBASE_FUNCTIONS_EMULATOR_HOST: "127.0.0.1:5001",
  };
  const configured = resolveMobileFirebaseConfig(declared, "europe-west1");
  const body = payload({
    environment: "local",
    projectId: "demo-new",
    databaseUrl: "http://127.0.0.1:9000/?ns=demo-new-default-rtdb",
    functionsBaseUrl: "http://127.0.0.1:5001/demo-new/europe-west1",
    relayOrigin: "http://127.0.0.1:8787",
  });
  const resolve = (patch: Partial<ControlPlaneBootstrapPayload> = {}) =>
    resolveBootstrapFirebaseConfig(configured, envelopeFor({ ...body, ...patch }), "europe-west1");
  expect(resolve().config).toMatchObject({ projectId: "demo-new", emulators: configured.config!.emulators });
  for (const patch of [
    { projectId: "real-project" },
    { databaseUrl: "https://external.example/database" },
    { functionsBaseUrl: "https://external.example/functions" },
    { relayOrigin: "http://192.168.1.1:8787" },
    { billingCheckoutHosts: ["checkout.example"] },
  ])
    expect(resolve(patch).config).toBeNull();
  const incomplete = resolveMobileFirebaseConfig({ ...declared, FIREBASE_AUTH_EMULATOR_HOST: "" }, "europe-west1");
  expect(resolveBootstrapFirebaseConfig(incomplete, envelopeFor(body), "europe-west1")).toEqual(incomplete);
  const invalid = resolveMobileFirebaseConfig(
    { ...declared, FIREBASE_AUTH_EMULATOR_HOST: "192.168.1.1:9099" },
    "europe-west1",
  );
  expect(resolveBootstrapFirebaseConfig(invalid, envelopeFor(body), "europe-west1")).toEqual(invalid);
  expect(() => configFromBootstrap(envelopeFor(body), "europe-west1")).toThrow(/complete Emulator/);
});

test("a local bootstrap refuses an external fetch before invoking the transport", async () => {
  let calls = 0;
  const result = await client({
    environment: "local",
    respond: async () => {
      calls++;
      return new Response("{}");
    },
  }).refresh();
  expect(result.refusal).toBe("insecure-endpoint");
  expect(calls).toBe(0);
});

test("the envelope's relay origin and merchant allowlist reach the configuration", () => {
  const config = configFromBootstrap(
    envelopeFor(
      payload({
        relayOrigin: "https://relay.strideterm.com",
        billingCheckoutHosts: ["checkout.paddle.com"],
      }),
    ),
    "europe-west1",
  );
  expect(config.relayOrigin).toBe("https://relay.strideterm.com");
  expect(config.billingCheckoutHosts).toEqual(["checkout.paddle.com"]);
});

test("a stored envelope is RE-VERIFIED before it is believed as configuration", async () => {
  // The R16 half that was a plain file read. `current()` handed back whatever was on disk and the
  // runtime believed it: an envelope signed by a key since retired, for another environment, or at an
  // epoch below the persistent floor was adopted with none of that re-checked.
  await client().refresh();
  expect(client().currentVerified()?.payload.configEpoch).toBe(5);

  // The same file, read by a build whose trust set no longer contains that key.
  const retired = createControlPlaneBootstrapClient({
    stateDir,
    environment: "prod",
    url: undefined,
    trust: { keys: new Map() },
    now: () => NOW,
  });
  expect(retired.current()).not.toBeNull();
  expect(retired.currentVerified()).toBeNull();

  // And the file-swap case: the floor says 9, the file says 5.
  const statePath = join(stateDir, "control-plane-bootstrap.json");
  const stored = JSON.parse(readFileSync(statePath, "utf8")) as { highestSeenEpoch: number };
  writeFileSync(statePath, JSON.stringify({ ...stored, highestSeenEpoch: 9 }), "utf8");
  expect(client().currentVerified()).toBeNull();
});

test("the state file is replaced atomically", async () => {
  // A crash mid-write must leave the previous envelope rather than a truncated one that fails to
  // parse on the next start, so the temporary file must not be what is left behind.
  await client().refresh();
  const statePath = join(stateDir, "control-plane-bootstrap.json");
  expect(() => readFileSync(statePath, "utf8")).not.toThrow();
  expect(() => unlinkSync(`${statePath}.tmp`)).toThrow();
});

describe("accepted is not applied (F14)", () => {
  // Adopting an envelope moves the ENDPOINTS. It does not by itself invalidate the refresh token,
  // the anonymous uid, the account binding or the pairings that belonged to the old project — and the
  // refresh deliberately does not act mid-process, so that work has to survive to the next launch.
  // Recording only "we accepted epoch N" meant the floor refused to re-offer the same epoch and
  // nothing ever ran the transition; a crash half-way through it had the same ending.

  test("a first envelope is a pending transition off the COMPILED configuration", async () => {
    await client().refresh();
    const pending = client().pendingTransition("strideterm-old");
    expect(pending).not.toBeNull();
    expect(pending?.fromEpoch).toBe(0);
    expect(pending?.toEpoch).toBe(5);
    expect(pending?.fromProjectId).toBe("strideterm-old");
    expect(pending?.toProjectId).toBe("strideterm-prod");
    // The project changed, so the old project's identity material is meaningless here.
    expect(pending?.identityInvalidated).toBe(true);
  });

  test("a transition stays pending until it is MARKED, and is repeated after a crash", async () => {
    await client().refresh();
    // A launch that started the work and died: nothing marked, so the next one asks again.
    expect(client().pendingTransition("strideterm-old")).not.toBeNull();
    expect(client().pendingTransition("strideterm-old")).not.toBeNull();

    client().markEpochApplied(5, "strideterm-prod");
    expect(client().pendingTransition("strideterm-old")).toBeNull();
  });

  test("an epoch that keeps the same project does not invalidate the identity", async () => {
    await client().refresh();
    client().markEpochApplied(5, "strideterm-prod");
    // A key rotation or an endpoint move, at a higher epoch, in the SAME project.
    await client({
      respond: async () =>
        new Response(JSON.stringify(envelopeFor(payload({ configEpoch: 6, apiKey: "AIzaSy-rotated-identifier" }))), {
          status: 200,
        }),
    }).refresh();

    const pending = client().pendingTransition("strideterm-old");
    expect(pending?.toEpoch).toBe(6);
    // Signing everybody out for a rotated key would be a self-inflicted outage.
    expect(pending?.identityInvalidated).toBe(false);
  });

  test("a transition into a DIFFERENT project invalidates the identity, at every epoch", async () => {
    await client().refresh();
    client().markEpochApplied(5, "strideterm-prod");
    await client({
      respond: async () =>
        new Response(
          JSON.stringify(
            envelopeFor(
              payload({
                configEpoch: 7,
                projectId: "strideterm-restored",
                databaseUrl: "https://strideterm-restored-default-rtdb.europe-west1.firebasedatabase.app",
                functionsBaseUrl: "https://europe-west1-strideterm-restored.cloudfunctions.net",
              }),
            ),
          ),
          { status: 200 },
        ),
    }).refresh();

    const pending = client().pendingTransition("strideterm-old");
    expect(pending?.fromProjectId).toBe("strideterm-prod");
    expect(pending?.toProjectId).toBe("strideterm-restored");
    expect(pending?.identityInvalidated).toBe(true);
  });

  test("an envelope this build would no longer VERIFY drives no transition", () => {
    // The stored document is the input to the transition, so it has to pass the same re-verification
    // `currentVerified` applies. A file swapped in under a retired key must not be able to make an
    // install wipe its own credentials.
    writeFileSync(
      join(stateDir, "control-plane-bootstrap.json"),
      JSON.stringify({
        envelope: { ...envelopeFor(payload({ configEpoch: 9 })), keyId: "a-key-this-build-does-not-trust" },
        highestSeenEpoch: 9,
        acceptedAt: NOW,
      }),
      "utf8",
    );
    expect(client().pendingTransition("strideterm-old")).toBeNull();
  });
});
