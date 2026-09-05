import http from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startNotifyServer, generateNotifySecret, buildNotifyUrl } from "./notify-server.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function postJson(url: string, body: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function httpRequest(url: string, method = "GET"): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const servers: any[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createServer(options: any = {}) {
  const secret = options.secret || generateNotifySecret();
  const onNotification = options.onNotification || vi.fn();
  const handle = await startNotifyServer({
    secret,
    onNotification,
    onPermissionOffer: options.onPermissionOffer,
    onPermissionCommit: options.onPermissionCommit,
  });
  servers.push(handle);
  return { handle, secret, onNotification };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

// --- Unit tests for helper functions ---

describe("generateNotifySecret", () => {
  test("returns a UUID string", () => {
    const secret = generateNotifySecret();
    expect(secret).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates unique secrets", () => {
    const a = generateNotifySecret();
    const b = generateNotifySecret();
    expect(a).not.toBe(b);
  });
});

describe("buildNotifyUrl", () => {
  test("encodes session ID and secret into URL", () => {
    const url = buildNotifyUrl(12345, "ws1:panel1", "my-secret");
    expect(url).toBe("http://127.0.0.1:12345/notify?sid=ws1%3Apanel1&secret=my-secret");
  });

  test("encodes special characters", () => {
    const url = buildNotifyUrl(9999, "a:b:c", "sec&ret=1");
    expect(url).toContain("sid=a%3Ab%3Ac");
    expect(url).toContain("secret=sec%26ret%3D1");
  });
});

// --- Server lifecycle tests ---

describe("startNotifyServer", () => {
  test("binds to a random port on 127.0.0.1", async () => {
    const { handle } = await createServer();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.port).toBeLessThan(65536);
  });

  test("two servers bind to different ports", async () => {
    const a = await createServer();
    const b = await createServer();
    expect(a.handle.port).not.toBe(b.handle.port);
  });

  test("close() shuts down the server", async () => {
    const { handle, secret } = await createServer();
    const port = handle.port;
    await handle.close();
    servers.length = 0; // prevent double-close in afterEach

    // Verify the server is no longer accepting connections
    await expect(
      postJson(`http://127.0.0.1:${port}/notify?secret=${secret}`, { notification_type: "idle_prompt" }),
    ).rejects.toThrow();
  });
});

// --- Request handling tests ---

describe("POST /notify", () => {
  test("calls onNotification with parsed payload", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:panel1", secret);

    const res = await postJson(url, {
      hook: "Notification",
      notification_type: "idle_prompt",
      message: "Task complete",
      title: "Done",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
    expect(onNotification).toHaveBeenCalledOnce();
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ws1:panel1",
        hook: "Notification",
        subtype: "idle_prompt",
        notificationType: "idle_prompt",
        message: "Task complete",
        title: "Done",
      }),
    );
    // Raw payload is forwarded for dispatcher / future telemetry
    expect(onNotification.mock.calls[0][0].payload).toEqual({
      hook: "Notification",
      notification_type: "idle_prompt",
      message: "Task complete",
      title: "Done",
    });
  });

  test("handles permission_prompt notification type", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws2:panel3", secret);

    await postJson(url, { hook: "Notification", notification_type: "permission_prompt", message: "Approve?" });

    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ws2:panel3",
        hook: "Notification",
        subtype: "permission_prompt",
        notificationType: "permission_prompt",
        message: "Approve?",
        title: "",
      }),
    );
  });

  test("defaults to Notification/idle_prompt when hook and notification_type are empty", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    await postJson(url, { message: "hello" });

    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ hook: "Notification", notificationType: "idle_prompt" }),
    );
  });

  test("reads hook from payload.hook_event_name as fallback", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    await postJson(url, { hook_event_name: "Stop" });

    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({ hook: "Stop", subtype: "" }));
  });

  test("forwards Stop / SubagentStop / UserPromptSubmit hooks through dispatcher-shaped payload", async () => {
    const { handle, secret, onNotification } = await createServer();

    await postJson(buildNotifyUrl(handle.port, "ws1:p1", secret), { hook: "Stop" });
    await postJson(buildNotifyUrl(handle.port, "ws1:p1", secret), { hook: "SubagentStop" });
    await postJson(buildNotifyUrl(handle.port, "ws1:p1", secret), { hook: "UserPromptSubmit" });

    expect(onNotification).toHaveBeenCalledTimes(3);
    expect(onNotification.mock.calls[0][0]).toMatchObject({ hook: "Stop", subtype: "" });
    expect(onNotification.mock.calls[1][0]).toMatchObject({ hook: "SubagentStop", subtype: "" });
    expect(onNotification.mock.calls[2][0]).toMatchObject({ hook: "UserPromptSubmit", subtype: "" });
  });

  test("forwards unknown hook names to dispatcher (no early filter)", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    await postJson(url, { hook: "SomeFutureHook", notification_type: "new_subtype" });

    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ hook: "SomeFutureHook", subtype: "new_subtype" }),
    );
  });

  test("handles empty body", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const res = await postJson(url);

    expect(res.status).toBe(200);
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ws1:p1",
        hook: "Notification",
        subtype: "",
        notificationType: "idle_prompt",
        message: "",
        title: "",
      }),
    );
  });

  test("handles multiple sessions on the same server", async () => {
    const { handle, secret, onNotification } = await createServer();

    await postJson(buildNotifyUrl(handle.port, "ws1:p1", secret), { notification_type: "idle_prompt" });
    await postJson(buildNotifyUrl(handle.port, "ws2:p2", secret), { notification_type: "permission_prompt" });
    await postJson(buildNotifyUrl(handle.port, "ws3:p3", secret), { notification_type: "idle_prompt" });

    expect(onNotification).toHaveBeenCalledTimes(3);
    expect(onNotification.mock.calls[0][0].sessionId).toBe("ws1:p1");
    expect(onNotification.mock.calls[1][0].sessionId).toBe("ws2:p2");
    expect(onNotification.mock.calls[2][0].sessionId).toBe("ws3:p3");
  });

  test("coerces message and title to strings", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    await postJson(url, { notification_type: "idle_prompt", message: 123, title: null });

    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({ message: "123", title: "" }));
  });
});

// --- Security tests ---

describe("authentication", () => {
  test("rejects request with wrong secret", async () => {
    const { handle } = await createServer();
    const res = await postJson(`http://127.0.0.1:${handle.port}/notify?sid=ws1:p1&secret=wrong`, {
      notification_type: "idle_prompt",
    });
    expect(res.status).toBe(403);
  });

  test("rejects request with missing secret", async () => {
    const { handle } = await createServer();
    const res = await postJson(`http://127.0.0.1:${handle.port}/notify?sid=ws1:p1`, {
      notification_type: "idle_prompt",
    });
    expect(res.status).toBe(403);
  });

  test("rejects request with empty secret when server secret is set", async () => {
    const { handle } = await createServer();
    const res = await postJson(`http://127.0.0.1:${handle.port}/notify?sid=ws1:p1&secret=`, {
      notification_type: "idle_prompt",
    });
    expect(res.status).toBe(403);
  });
});

// --- HTTP method handling ---

describe("method filtering", () => {
  test("rejects GET requests", async () => {
    const { handle, secret } = await createServer();
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/notify?secret=${secret}`, "GET");
    expect(res.status).toBe(405);
  });

  test("rejects PUT requests", async () => {
    const { handle, secret } = await createServer();
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/notify?secret=${secret}`, "PUT");
    expect(res.status).toBe(405);
  });

  test("handles OPTIONS for CORS preflight", async () => {
    const { handle, secret } = await createServer();
    const res = await httpRequest(`http://127.0.0.1:${handle.port}/notify?secret=${secret}`, "OPTIONS");
    expect(res.status).toBe(204);
  });
});

// --- Path handling ---

describe("path routing", () => {
  test("returns 404 for unknown paths", async () => {
    const { handle, secret } = await createServer();
    const res = await postJson(`http://127.0.0.1:${handle.port}/other?secret=${secret}`, {});
    expect(res.status).toBe(404);
  });

  test("returns 404 for root path", async () => {
    const { handle, secret } = await createServer();
    const res = await postJson(`http://127.0.0.1:${handle.port}/?secret=${secret}`, {});
    expect(res.status).toBe(404);
  });
});

// --- Error handling ---

describe("error handling", () => {
  test("returns 400 for malformed JSON body", async () => {
    const { handle, secret } = await createServer();
    const url = `http://127.0.0.1:${handle.port}/notify?sid=ws1:p1&secret=${secret}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await new Promise<any>((resolve, reject) => {
      const parsed = new URL(url);
      const data = "{invalid json";
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });

    expect(res.status).toBe(400);
  });

  test("forwards unknown notification subtypes to onNotification (dispatcher classifies)", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const res = await postJson(url, { notification_type: "some_new_subtype" });

    expect(res.status).toBe(200);
    // No allowlist — every event reaches the dispatcher, which then decides.
    expect(onNotification).toHaveBeenCalledWith(
      expect.objectContaining({ hook: "Notification", subtype: "some_new_subtype" }),
    );
  });

  test("does not crash when onNotification throws", async () => {
    const onNotification = vi.fn(() => {
      throw new Error("handler error");
    });
    const { handle, secret } = await createServer({ onNotification });
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const res = await postJson(url, { notification_type: "idle_prompt" });

    expect(res.status).toBe(200);
    expect(onNotification).toHaveBeenCalledOnce();
  });

  // review-code-quality-2026-07.md finding §3: onNotification is invoked
  // synchronously above (see the "throws" test right before this one) — that
  // try/catch can only ever see a SYNCHRONOUS throw. The real onNotification
  // (runtime.ts's handleAgentHookNotification, wrapping the async
  // dispatchAgentHookEvent) is async under the hood, so before the fix a
  // rejection from it would have been an unhandled rejection this
  // synchronous catch could never observe. The fix never hands notify-server
  // a bare async function: it wraps the call in `void asyncFn(...).catch(...)`
  // itself so onNotification's return value is always void/undefined and any
  // rejection is already caught before notify-server sees it. This proves
  // that shape is safe end-to-end through the real server.
  test("does not crash or leak an unhandled rejection when a wrapped async onNotification's promise rejects", async () => {
    const caughtErrors: string[] = [];
    const onNotification = vi.fn((n) => {
      // Mirrors runtime.ts's `void dispatchAgentHookEvent(event).catch(...)`
      // wrapper shape: onNotification itself stays synchronous/void, the
      // async rejection is caught by the wrapper, not left dangling.
      void Promise.reject(new Error(`boom: ${n.sessionId}`)).catch((err: Error) => {
        caughtErrors.push(err.message);
      });
    });
    const { handle, secret } = await createServer({ onNotification });
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const res = await postJson(url, { notification_type: "idle_prompt" });

    expect(res.status).toBe(200);
    expect(onNotification).toHaveBeenCalledOnce();
    // Give the wrapped promise's own .catch() a tick to run.
    await new Promise((r) => setImmediate(r));
    expect(caughtErrors).toEqual(["boom: ws1:p1"]);
  });

  test("handles missing sessionId gracefully", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = `http://127.0.0.1:${handle.port}/notify?secret=${secret}`;

    const res = await postJson(url, { notification_type: "idle_prompt" });

    expect(res.status).toBe(200);
    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "" }));
  });
});

// --- Payload size limit ---

describe("payload size", () => {
  test("rejects payloads larger than the 256KB ceiling", async () => {
    const { handle, secret } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const largePayload = { notification_type: "idle_prompt", message: "x".repeat(300 * 1024) };
    const res = await postJson(url, largePayload);

    expect(res.status).toBe(413);
  });

  test("a big Write permission request is decided, not rejected", async () => {
    // The 64 KB ceiling this replaced turned a large `Write` into a 413: no
    // decision, no summary, and the prompt the setting promised to answer.
    // notify.mjs trims the payload before sending, but an untrimmed one from
    // an older installed script still has to get an answer.
    const { handle, secret } = await createServer({
      onPermissionOffer: () => ({ requestId: "req-big" }),
      onPermissionCommit: () => ({ hookSpecificOutput: { hookEventName: "PermissionRequest" } }),
    });
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const offer = await postJson(url, {
      hook: "PermissionRequest",
      phase: "offer",
      tool_name: "Write",
      tool_input: { file_path: "big.ts", content: "x".repeat(90 * 1024) },
    });

    expect(offer.status).toBe(200);
    expect(JSON.parse(offer.body)).toEqual({ offer: { requestId: "req-big" } });
  });

  test("accepts ordinary small payloads", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const payload = { notification_type: "idle_prompt", message: "x".repeat(1000) };
    const res = await postJson(url, payload);

    expect(res.status).toBe(200);
    expect(onNotification).toHaveBeenCalledOnce();
  });
});

// --- Concurrent requests ---

describe("concurrent requests", () => {
  test("handles multiple simultaneous requests correctly", async () => {
    const { handle, secret, onNotification } = await createServer();

    const requests = Array.from({ length: 10 }, (_, i) =>
      postJson(buildNotifyUrl(handle.port, `ws${i}:p${i}`, secret), {
        notification_type: "idle_prompt",
        message: `msg-${i}`,
      }),
    );

    const results = await Promise.all(requests);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(onNotification).toHaveBeenCalledTimes(10);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionIds = onNotification.mock.calls.map((c: any) => c[0].sessionId).sort();
    expect(sessionIds).toEqual(Array.from({ length: 10 }, (_, i) => `ws${i}:p${i}`).sort());
  });
});

describe("PermissionRequest decisions", () => {
  const HOOK_OUTPUT = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
  const OFFER = { requestId: "req-1" };

  function offerBody(extra: Record<string, unknown> = {}) {
    return { hook: "PermissionRequest", phase: "offer", ...extra };
  }

  test("phase 1 answers with an opaque requestId, not a decision", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onPermissionOffer = (n: any) => {
      seen.push(n);
      return OFFER;
    };
    const { handle, secret } = await createServer({ onPermissionOffer });
    const url = buildNotifyUrl(handle.port, "ws:panel", secret);

    const res = await postJson(url, offerBody({ tool_name: "Bash", tool_input: { command: "chmod +x deploy.sh" } }));

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ offer: OFFER });
    // The offerer still sees the whole payload, tool name and input included.
    expect(seen[0]).toMatchObject({
      hook: "PermissionRequest",
      sessionId: "ws:panel",
      payload: { tool_name: "Bash" },
    });
  });

  test("phase 2 returns the COMPLETE stdout document, hookSpecificOutput wrapper included", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const committed: any[] = [];
    const { handle, secret } = await createServer({
      onPermissionOffer: () => OFFER,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onPermissionCommit: (n: any, requestId: string) => {
        committed.push({ n, requestId });
        return HOOK_OUTPUT;
      },
    });
    const url = buildNotifyUrl(handle.port, "ws:panel", secret);

    const res = await postJson(url, {
      hook: "PermissionRequest",
      phase: "commit",
      request_id: "req-1",
    });

    expect(JSON.parse(res.body)).toEqual({ hookOutput: HOOK_OUTPUT });
    expect(committed[0].requestId).toBe("req-1");
  });

  test("a commit does NOT re-run the notification pipeline", async () => {
    // The dispatcher already saw this request during phase 1; running it again
    // would double every signal side effect the offer leg had.
    const onNotification = vi.fn();
    const { handle, secret } = await createServer({
      onNotification,
      onPermissionOffer: () => OFFER,
      onPermissionCommit: () => HOOK_OUTPUT,
    });
    const url = buildNotifyUrl(handle.port, "ws:panel", secret);

    await postJson(url, offerBody());
    await postJson(url, { hook: "PermissionRequest", phase: "commit", request_id: "req-1" });

    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  test("a commit without a request_id is refused", async () => {
    const onPermissionCommit = vi.fn(() => HOOK_OUTPUT);
    const { handle, secret } = await createServer({ onPermissionOffer: () => OFFER, onPermissionCommit });
    const res = await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), {
      hook: "PermissionRequest",
      phase: "commit",
    });
    expect(res.body).toBe("{}");
    expect(onPermissionCommit).not.toHaveBeenCalled();
  });

  test("a null offer answers {} so the agent shows its prompt", async () => {
    const { handle, secret } = await createServer({ onPermissionOffer: () => null });
    const res = await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), offerBody());
    expect(res.body).toBe("{}");
  });

  test("a null commit answers {} — an offer that could not be recorded issues nothing", async () => {
    const { handle, secret } = await createServer({
      onPermissionOffer: () => OFFER,
      onPermissionCommit: () => null,
    });
    const res = await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), {
      hook: "PermissionRequest",
      phase: "commit",
      request_id: "req-1",
    });
    expect(res.body).toBe("{}");
  });

  test("with no offerer wired the response is {} (auto-approve-off behaviour)", async () => {
    const { handle, secret } = await createServer();
    const res = await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), offerBody());
    expect(res.body).toBe("{}");
  });

  test("a throwing offerer fails silent rather than hanging the hook", async () => {
    const { handle, secret } = await createServer({
      onPermissionOffer: () => {
        throw new Error("boom");
      },
    });
    const res = await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), offerBody());
    expect(res.status).toBe(200);
    expect(res.body).toBe("{}");
  });

  test("a throwing committer fails silent too", async () => {
    const { handle, secret } = await createServer({
      onPermissionOffer: () => OFFER,
      onPermissionCommit: () => {
        throw new Error("boom");
      },
    });
    const res = await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), {
      hook: "PermissionRequest",
      phase: "commit",
      request_id: "req-1",
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("{}");
  });

  test("other hooks never consult the offerer and always answer {}", async () => {
    const onPermissionOffer = vi.fn(() => OFFER);
    const { handle, secret } = await createServer({ onPermissionOffer });
    const url = buildNotifyUrl(handle.port, "ws:panel", secret);

    for (const hook of ["Notification", "Stop", "SubagentStop", "UserPromptSubmit", "PreToolUse"]) {
      const res = await postJson(url, { hook });
      expect(res.body).toBe("{}");
    }
    expect(onPermissionOffer).not.toHaveBeenCalled();
  });

  test("onNotification still runs for PermissionRequest (signal + metrics)", async () => {
    const onNotification = vi.fn();
    const { handle, secret } = await createServer({ onNotification, onPermissionOffer: () => OFFER });
    await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), offerBody());
    expect(onNotification).toHaveBeenCalledTimes(1);
  });

  test("a throwing onNotification does not block the offer", async () => {
    const { handle, secret } = await createServer({
      onNotification: () => {
        throw new Error("dispatcher blew up");
      },
      onPermissionOffer: () => OFFER,
    });
    const res = await postJson(buildNotifyUrl(handle.port, "ws:panel", secret), offerBody());
    expect(JSON.parse(res.body)).toEqual({ offer: OFFER });
  });
});
