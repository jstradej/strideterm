import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { CredentialStore } from "../shared/credential-store.js";
import { JiraManager, JiraRequestError, jiraErrorDetail, type JiraConnection } from "./jira-manager.js";
import { describePfxFailure, toJiraRequestError } from "./jira-transport-errors.js";
import { JiraReadScheduler } from "./jira-read-scheduler.js";
import { errorCauseCode } from "./jira-request-error.js";

const logCalls = vi.hoisted(() => [] as Array<{ level: string; message: string; meta?: Record<string, unknown> }>);
vi.mock("../logger.js", () => {
  const make = () => {
    const record = (level: string) => (message: string, meta?: Record<string, unknown>) => {
      logCalls.push({ level, message, meta });
    };
    return {
      error: record("error"),
      warn: record("warn"),
      info: record("info"),
      debug: record("debug"),
      trace: record("trace"),
    };
  };
  return { getLogger: make, redactSecrets: (value: string) => value };
});

const dc: JiraConnection = {
  id: "jira-a",
  profileId: "default",
  label: "DC",
  enabled: true,
  deployment: "data-center",
  webUrl: "https://jira.example.com",
  apiBaseUrl: "https://jira.example.com/jira",
  auth: { kind: "dc-pat", secretRef: "jira:jira-a:pat" },
  accountPurpose: "personal",
};
const store = (secret = "secret-pat") => ({ getSecret: () => secret }) as unknown as CredentialStore;
const ok = () => new Response(JSON.stringify({ name: "alice", displayName: "Alice" }));
const withCode = (code: string, message = "fetch failed") => {
  const error = new TypeError(message);
  (error as { cause?: unknown }).cause = Object.assign(
    new Error("socket detail with https://jira.example.com/?jql=secret"),
    {
      code,
    },
  );
  return error;
};
const failureOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(JiraRequestError);
  return error as JiraRequestError;
};

beforeEach(() => {
  logCalls.length = 0;
});

describe("request failures keep their cause and say what is wrong", () => {
  it("a missing PAT is credential-missing and never left the machine", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const manager = new JiraManager(store(""), fetchImpl as unknown as typeof fetch);
    const error = await failureOf(manager.verify(dc));
    expect(error).toMatchObject({ code: "credential-missing", notSent: true });
    expect(error.message).toMatch(/PAT is missing/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a missing API token and a missing gateway key are specific, not-sent failures", async () => {
    const cloud: JiraConnection = {
      ...dc,
      id: "cloud-a",
      deployment: "cloud",
      webUrl: "https://example.atlassian.net",
      cloudId: "abc-123",
      auth: { kind: "cloud-api-token", secretRef: "jira:cloud-a:api-token", email: "me@example.com" },
    };
    const noToken = await failureOf(new JiraManager(store(""), vi.fn() as unknown as typeof fetch).verify(cloud));
    expect(noToken).toMatchObject({ code: "credential-missing", notSent: true });
    expect(noToken.message).toMatch(/API token is missing/);
    const apim: JiraConnection = {
      ...dc,
      id: "apim-a",
      auth: { kind: "dc-apim", secretRef: "jira:apim-a:key" },
    };
    const noKey = await failureOf(new JiraManager(store(""), vi.fn() as unknown as typeof fetch).verify(apim));
    expect(noKey).toMatchObject({ code: "credential-missing", notSent: true });
    expect(noKey.message).toMatch(/gateway credentials are missing/);
  });

  it.each([
    ["ENOTFOUND", "host-unreachable"],
    ["ECONNREFUSED", "host-unreachable"],
    ["CERT_HAS_EXPIRED", "tls-error"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls-error"],
  ])("%s is %s, not sent, with the cause kept and its text never shown", async (causeCode, expected) => {
    const fetchImpl = vi.fn(async () => {
      throw withCode(causeCode);
    });
    const manager = new JiraManager(store(), fetchImpl as unknown as typeof fetch);
    const error = await failureOf(manager.verify(dc));
    expect(error).toMatchObject({ code: expected, notSent: true });
    expect(errorCauseCode(error.cause)).toBe(causeCode);
    expect(error.message).toContain(causeCode);
    expect(error.message).not.toContain("jql=secret");
    expect(error.message).not.toContain("socket detail");
  });

  it.each([
    ["EHOSTUNREACH", "host-unreachable"],
    ["ENETUNREACH", "host-unreachable"],
    ["ENETDOWN", "host-unreachable"],
    ["EADDRNOTAVAIL", "host-unreachable"],
    ["EPROTO", "tls-error"],
    ["ERR_SSL_BAD_RECORD_MAC", "tls-error"],
    ["ERR_TLS_HANDSHAKE_TIMEOUT", "tls-error"],
  ])("%s on a read keeps its code but may have been applied", async (causeCode, expected) => {
    const fetchImpl = vi.fn(async () => {
      throw withCode(causeCode);
    });
    const error = await failureOf(new JiraManager(store(), fetchImpl as unknown as typeof fetch).verify(dc));
    expect(error).toMatchObject({ code: expected, notSent: false });
  });

  it("an unreachable code from a connect syscall is still provably not sent", async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new TypeError("fetch failed");
      (error as { cause?: unknown }).cause = Object.assign(new Error("connect"), {
        code: "EHOSTUNREACH",
        syscall: "connect",
      });
      throw error;
    });
    const error = await failureOf(new JiraManager(store(), fetchImpl as unknown as typeof fetch).verify(dc));
    expect(error).toMatchObject({ code: "host-unreachable", notSent: true });
  });

  it("a non-Jira error before the request left is not sent", () => {
    for (const stage of ["acquire", "auth", "connect"] as const)
      expect(toJiraRequestError(new Error("refresh challenge was invalid"), stage).notSent).toBe(true);
    expect(toJiraRequestError(new Error("socket hang up"), "read").notSent).toBe(false);
  });

  it("a reset after the request was sent stays a plain network failure that may have been applied", async () => {
    const fetchImpl = vi.fn(async () => {
      throw withCode("ECONNRESET");
    });
    const error = await failureOf(new JiraManager(store(), fetchImpl as unknown as typeof fetch).verify(dc));
    expect(error).toMatchObject({ code: "network", notSent: false });
    expect(error.message).toBe("Jira request failed or exceeded its time limit.");
    expect(errorCauseCode(error.cause)).toBe("ECONNRESET");
  });

  it("an HTML page answered with 200 is unsupported, with its content type logged", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>Sign in to continue</html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    );
    const error = await failureOf(new JiraManager(store(), fetchImpl as unknown as typeof fetch).verify(dc));
    expect(error.code).toBe("unsupported");
    expect(error.message).toMatch(/web page instead of data/);
    expect(error.statusCode).toBe(200);
    const logged = logCalls.find((call) => call.meta?.scope === "non-json:200");
    expect(logged?.meta).toMatchObject({ contentType: "text/html; charset=utf-8", status: 200 });
    expect(JSON.stringify(logged)).not.toContain("Sign in to continue");
  });

  it("surfaces Jira's own messages and the names of the fields it refused", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errorMessages: ["Error in the JQL Query: bad token"],
            errors: { customfield_10010: "Field is required", summary: "too long" },
          }),
          { status: 400 },
        ),
    );
    const error = await failureOf(new JiraManager(store(), fetchImpl as unknown as typeof fetch).verify(dc));
    expect(error).toMatchObject({ code: "unknown", statusCode: 400 });
    expect(error.message).toContain("Error in the JQL Query: bad token");
    expect(error.message).toContain("customfield_10010: Field is required");
    const warn = logCalls.find((call) => call.message === "jira refused a request");
    expect(warn?.meta).toMatchObject({ status: 400, fields: ["customfield_10010", "summary"] });
    expect(JSON.stringify(warn)).not.toContain("bad token");
    expect(JSON.stringify(warn)).not.toContain("Field is required");
  });

  it("reads only a bounded part of an error body", () => {
    const detail = jiraErrorDetail(JSON.stringify({ errorMessages: ["x".repeat(10_000)] }));
    expect(detail.message.length).toBeLessThanOrEqual(300);
    expect(jiraErrorDetail("<html>proxy error</html>").message).toBe("");
  });

  it("a 5xx without a readable body keeps the plain message", async () => {
    const fetchImpl = vi.fn(async () => new Response("Bad gateway", { status: 502 }));
    const error = await failureOf(new JiraManager(store(), fetchImpl as unknown as typeof fetch).verify(dc));
    expect(error).toMatchObject({ code: "network", statusCode: 502, message: "Jira request failed (502)." });
  });
});

describe("client certificate failures", () => {
  it("tells a wrong password from an algorithm this build cannot read", () => {
    const wrongPassword = describePfxFailure(
      Object.assign(new Error("mac verify failure"), { code: "ERR_OSSL_PKCS12_MAC_VERIFY_FAILURE" }),
    );
    expect(wrongPassword).toMatchObject({ code: "certificate-invalid", notSent: true });
    expect(wrongPassword?.message).toMatch(/password is wrong/);
    const legacy = describePfxFailure(
      Object.assign(new Error("error:0308010C:digital envelope routines::unsupported"), {
        code: "ERR_OSSL_EVP_UNSUPPORTED",
      }),
    );
    expect(legacy?.message).toMatch(/old encryption algorithm/);
    expect(errorCauseCode(legacy?.cause)).toBe("ERR_OSSL_EVP_UNSUPPORTED");
    const missing = describePfxFailure(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
    expect(missing?.message).toMatch(/could not be read \(ENOENT\)/);
    expect(describePfxFailure(new Error("ordinary failure"))).toBeUndefined();
  });

  it("a saved certificate with the wrong password fails before any request with its own message", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const apim: JiraConnection = {
      ...dc,
      id: "apim-a",
      auth: { kind: "dc-apim", secretRef: "key", passphraseRef: "pass" },
      clientCertificatePath: fileURLToPath(new URL("./__fixtures__/jira-test-client.pfx", import.meta.url)),
    };
    const credentials = { getSecret: (ref: string) => (ref === "pass" ? "wrong-password" : "gateway-key") };
    const error = await failureOf(
      new JiraManager(credentials as unknown as CredentialStore, fetchImpl as unknown as typeof fetch).verify(apim),
    );
    expect(error).toMatchObject({ code: "certificate-invalid", notSent: true });
    expect(error.message).toMatch(/password is wrong/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logCalls.find((call) => call.message === "jira client certificate could not be loaded")).toBeDefined();
  });
});

describe("a full request queue", () => {
  it("is a rate-limited, not-sent refusal and one throttled warning", async () => {
    const scheduler = new JiraReadScheduler(1, 1, 1);
    const held = await scheduler.acquire("a", Date.now() + 1000);
    const waiting = scheduler.acquire("b", Date.now() + 1000);
    const refused = await failureOf(scheduler.acquire("c", Date.now() + 1000));
    const again = await failureOf(scheduler.acquire("d", Date.now() + 1000));
    expect(refused).toMatchObject({ code: "rate-limited", notSent: true });
    expect(again.notSent).toBe(true);
    expect(logCalls.filter((call) => /queue is full/.test(call.message))).toHaveLength(1);
    held();
    (await waiting)();
  });
});

describe("connection health transitions", () => {
  it("tells the observer once when a sign-in stops working and once when it works again; a 403 is not a sign-in problem", async () => {
    let status = 401;
    const fetchImpl = vi.fn(async () => (status === 200 ? ok() : new Response("{}", { status })));
    const manager = new JiraManager(store(), fetchImpl as unknown as typeof fetch);
    const events: Array<string | undefined> = [];
    manager.setHealthObserver(({ code }) => {
      events.push(code);
    });
    await failureOf(manager.verify(dc));
    await failureOf(manager.verify(dc));
    status = 403;
    await failureOf(manager.verify(dc));
    status = 503;
    await failureOf(manager.verify(dc));
    status = 200;
    await manager.verify(dc);
    await manager.verify(dc);
    expect(events).toEqual(["auth-expired", undefined]);
  });

  it("a missing credential counts as a sign-in problem", async () => {
    const manager = new JiraManager(store(""), vi.fn() as unknown as typeof fetch);
    const events: Array<string | undefined> = [];
    manager.setHealthObserver(({ code }) => {
      events.push(code);
    });
    await failureOf(manager.verify(dc));
    expect(events).toEqual(["credential-missing"]);
  });
});

describe("a successful write releases its response body", () => {
  it("cancels the unread body of a comment and of an attachment upload", async () => {
    let cancelled = 0;
    const answer = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled += 1;
          },
        }),
        { status: 201 },
      );
    const fetchImpl = vi.fn(async () => answer());
    const manager = new JiraManager(store(), fetchImpl as unknown as typeof fetch);
    await manager.addComment(dc, "100", "hello");
    await manager.uploadAttachment(dc, "ABC-1", "r.txt", "text/plain", new Uint8Array([1, 2]));
    expect(cancelled).toBe(2);
  });
});

describe("background failures are logged on transitions only", () => {
  it("a resource that keeps answering 403 beside successful reads produces no log lines at all", async () => {
    const restricted = { ...dc, id: "jira-restricted" };
    let status = 200;
    const fetchImpl = vi.fn(async () => (status === 200 ? ok() : new Response("{}", { status })));
    const manager = new JiraManager(store(), fetchImpl as unknown as typeof fetch);
    for (let i = 0; i < 4; i += 1) {
      status = 403;
      await failureOf(manager.verify(restricted));
      status = 404;
      await failureOf(manager.verify(restricted));
      status = 200;
      await manager.verify(restricted);
    }
    expect(logCalls.filter((call) => /background work/.test(call.message))).toEqual([]);
  });

  it("logs a persistent outage once and its recovery once", async () => {
    let up = false;
    const fetchImpl = vi.fn(async () => {
      if (!up) throw withCode("ECONNREFUSED");
      return ok();
    });
    const manager = new JiraManager(store(), fetchImpl as unknown as typeof fetch);
    for (let i = 0; i < 5; i += 1) await failureOf(manager.verify(dc));
    up = true;
    await manager.verify(dc);
    await manager.verify(dc);
    const failures = logCalls.filter((call) => call.message === "jira background work failed");
    expect(failures).toHaveLength(1);
    expect(failures[0].meta).toMatchObject({
      connectionId: "jira-a",
      scope: "http",
      code: "host-unreachable",
      host: "jira.example.com",
      stage: "read",
      errCode: "ECONNREFUSED",
    });
    expect(JSON.stringify(failures[0])).not.toContain("jql=secret");
    expect(logCalls.filter((call) => call.message === "jira background work recovered")).toHaveLength(1);
  });
});
