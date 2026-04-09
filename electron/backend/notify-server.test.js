import http from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startNotifyServer, generateNotifySecret, buildNotifyUrl } from "./notify-server.js";

function postJson(url, body = {}) {
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

function httpRequest(url, method = "GET") {
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

const servers = [];

async function createServer(options = {}) {
  const secret = options.secret || generateNotifySecret();
  const onNotification = options.onNotification || vi.fn();
  const handle = await startNotifyServer({ secret, onNotification, logger: null });
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
      notification_type: "idle_prompt",
      message: "Task complete",
      title: "Done",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
    expect(onNotification).toHaveBeenCalledOnce();
    expect(onNotification).toHaveBeenCalledWith({
      sessionId: "ws1:panel1",
      notificationType: "idle_prompt",
      message: "Task complete",
      title: "Done",
    });
  });

  test("handles permission_prompt notification type", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws2:panel3", secret);

    await postJson(url, { notification_type: "permission_prompt", message: "Approve?" });

    expect(onNotification).toHaveBeenCalledWith({
      sessionId: "ws2:panel3",
      notificationType: "permission_prompt",
      message: "Approve?",
      title: "",
    });
  });

  test("defaults to idle_prompt when notification_type is empty", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    await postJson(url, { message: "hello" });

    expect(onNotification).toHaveBeenCalledWith(expect.objectContaining({ notificationType: "idle_prompt" }));
  });

  test("handles empty body", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const res = await postJson(url);

    expect(res.status).toBe(200);
    expect(onNotification).toHaveBeenCalledWith({
      sessionId: "ws1:p1",
      notificationType: "idle_prompt",
      message: "",
      title: "",
    });
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

    const res = await new Promise((resolve, reject) => {
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

  test("silently ignores unknown notification types", async () => {
    const { handle, secret, onNotification } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const res = await postJson(url, { notification_type: "unknown_type" });

    expect(res.status).toBe(200);
    expect(onNotification).not.toHaveBeenCalled();
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
  test("rejects payloads larger than 64KB", async () => {
    const { handle, secret } = await createServer();
    const url = buildNotifyUrl(handle.port, "ws1:p1", secret);

    const largePayload = { notification_type: "idle_prompt", message: "x".repeat(70 * 1024) };
    const res = await postJson(url, largePayload);

    expect(res.status).toBe(413);
  });

  test("accepts payloads under 64KB", async () => {
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

    const sessionIds = onNotification.mock.calls.map((c) => c[0].sessionId).sort();
    expect(sessionIds).toEqual(Array.from({ length: 10 }, (_, i) => `ws${i}:p${i}`).sort());
  });
});
