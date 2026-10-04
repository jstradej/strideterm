import { afterEach, describe, expect, test, vi } from "vitest";
import http from "node:http";
import { createSshMcpBroker } from "./ssh-mcp-broker.js";

const context = {
  sessionId: "workspace:panel",
  profileId: "profile-a",
  workspaceId: "workspace",
  panelId: "panel",
  command: "claude --model sonnet",
};

const brokers: ReturnType<typeof createSshMcpBroker>[] = [];

async function broker(
  overrides: { isGrantLive?: (_grant: typeof context) => boolean | Promise<boolean>; service?: object } = {},
) {
  const service = overrides.service || {
    listHosts: vi.fn(() => [
      { id: "host-1", name: "Build", host: "build.local", username: "dev", port: 22, methods: ["publickey"] },
    ]),
    runCommand: vi.fn(async ({ hostId, command }: { hostId: string; command: string }) => ({
      hostId,
      stdout: `ran ${command}`,
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
    })),
  };
  const instance = createSshMcpBroker({
    service: service as never,
    isGrantLive: overrides.isGrantLive || (() => true),
  });
  brokers.push(instance);
  const started = await instance.start();
  const grant = instance.mintGrant(context);
  return { instance, service, url: started.url, grant };
}

afterEach(async () => {
  for (const instance of brokers.splice(0).reverse()) await instance.close();
});

async function post(url: string, capability: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("SSH MCP loopback broker", () => {
  test("uses a loopback URL with an out-of-band, panel-bound capability", async () => {
    const { url, grant, instance } = await broker();

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ssh-mcp$/u);
    expect(url).not.toContain(grant.capability);
    const result = await post(grant.url, grant.capability, { operation: "list" });

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      result: {
        hosts: [
          { id: "host-1", name: "Build", host: "build.local", username: "dev", port: 22, methods: ["publickey"] },
        ],
      },
    });
    instance.revokeSession(context.sessionId);
    expect((await post(grant.url, grant.capability, { operation: "list" })).status).toBe(401);
  });

  test("rejects invalid bearer tokens and malformed payloads", async () => {
    const { url, grant } = await broker();

    expect((await post(url, "invalid-capability", { operation: "list" })).status).toBe(401);
    const malformed = await post(url, grant.capability, {
      operation: "run",
      hostId: "host",
      command: "x",
      extra: true,
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  test("validates the exact profile and panel context supplied by the runtime", async () => {
    let seenContext: typeof context | null = null;
    let live = true;
    const { url, grant } = await broker({
      isGrantLive: (value) => {
        seenContext = value;
        return (
          live && value.profileId === "profile-a" && value.workspaceId === "workspace" && value.panelId === "panel"
        );
      },
    });

    expect((await post(url, grant.capability, { operation: "list" })).status).toBe(200);
    expect(seenContext).toEqual(context);
    live = false;
    expect((await post(url, grant.capability, { operation: "list" })).status).toBe(403);
  });

  test("preserves UTF-8 when a command body is split inside a multibyte character", async () => {
    const service = {
      listHosts: vi.fn(() => []),
      runCommand: vi.fn(async ({ command }: { command: string }) => ({ hostId: "host-1", stdout: command })),
    };
    const { url, grant } = await broker({ service });
    const body = Buffer.from(JSON.stringify({ operation: "run", hostId: "host-1", command: "echo π" }));
    const splitAt = body.indexOf(Buffer.from("π")) + 1;
    const responseText = await new Promise<string>((resolve, reject) => {
      const request = http.request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${grant.capability}`,
            "Content-Type": "application/json",
            "Content-Length": body.length,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      request.on("error", reject);
      request.write(body.subarray(0, splitAt));
      setTimeout(() => request.end(body.subarray(splitAt)), 15);
    });

    expect(JSON.parse(responseText)).toMatchObject({ result: { stdout: "echo π" } });
    expect(service.runCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "echo π" }));
  });

  test("rejects request bodies over the byte ceiling", async () => {
    const { url, grant } = await broker();
    const body = JSON.stringify({ operation: "list", padding: "x".repeat(17 * 1024) });

    await expect(post(url, grant.capability, body)).rejects.toBeDefined();
  });

  test("expires clients that leave a request body incomplete", async () => {
    const { url, grant } = await broker();
    const result = new Promise<number>((resolve) => {
      const request = http.request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${grant.capability}`,
            "Content-Type": "application/json",
            "Content-Length": 100,
          },
        },
        (response) => resolve(response.statusCode || 0),
      );
      request.on("error", () => resolve(0));
      request.write("{");
    });

    expect([0, 408]).toContain(await result);
  }, 8_000);

  test("revalidates grant membership after an asynchronous live check", async () => {
    let finishCheck!: (_value: boolean) => void;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => (checkStarted = resolve));
    const checked = new Promise<boolean>((resolve) => (finishCheck = resolve));
    const service = { listHosts: vi.fn(() => []), runCommand: vi.fn() };
    const { instance, url, grant } = await broker({
      service,
      isGrantLive: () => {
        checkStarted();
        return checked;
      },
    });

    const pending = post(url, grant.capability, { operation: "list" });
    await started;
    instance.revokeSession(context.sessionId);
    finishCheck(true);

    const response = await pending;
    expect(response.status).toBe(401);
    expect(service.listHosts).not.toHaveBeenCalled();
  });

  test("rechecks grant after body read and aborts a command when its panel is revoked", async () => {
    let liveCheckCount = 0;
    let finishSecondCheck!: (_value: boolean) => void;
    let secondCheckStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => (secondCheckStarted = resolve));
    const secondCheck = new Promise<boolean>((resolve) => (finishSecondCheck = resolve));
    const service = {
      listHosts: vi.fn(() => []),
      runCommand: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })),
              { once: true },
            );
          }),
      ),
    };
    const { instance, url, grant } = await broker({
      service,
      isGrantLive: () => {
        liveCheckCount += 1;
        if (liveCheckCount === 2) {
          secondCheckStarted();
          return secondCheck;
        }
        return true;
      },
    });

    const pending = post(url, grant.capability, { operation: "run", hostId: "host-1", command: "id" });
    await secondStarted;
    instance.revokeSession(context.sessionId);
    finishSecondCheck(true);

    expect((await pending).status).toBe(401);
    expect(service.runCommand).not.toHaveBeenCalled();
  });

  test("revoking a live grant cancels its command and returns a clear expired result", async () => {
    const service = {
      listHosts: vi.fn(() => []),
      runCommand: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })),
              { once: true },
            );
          }),
      ),
    };
    const { instance, url, grant } = await broker({ service });

    const pending = post(url, grant.capability, { operation: "run", hostId: "host-1", command: "id" });
    await vi.waitFor(() => expect(service.runCommand).toHaveBeenCalledOnce());
    instance.revokeSession(context.sessionId);

    const response = await pending;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "grant_expired" } });
  });

  test("enforces two concurrent calls per panel and eight across the broker", async () => {
    const service = {
      listHosts: vi.fn(() => []),
      runCommand: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })),
              { once: true },
            );
          }),
      ),
    };
    const { instance, url, grant } = await broker({ service });
    const pending: Promise<Response>[] = [];
    pending.push(post(url, grant.capability, { operation: "run", hostId: "h", command: "one" }));
    pending.push(post(url, grant.capability, { operation: "run", hostId: "h", command: "two" }));
    await vi.waitFor(() => expect(service.runCommand).toHaveBeenCalledTimes(2));
    expect((await post(url, grant.capability, { operation: "run", hostId: "h", command: "three" })).status).toBe(429);

    const grantSessionIds = [context.sessionId];
    for (let index = 1; index <= 6; index += 1) {
      const nextContext = { ...context, sessionId: `workspace:panel-${index}`, panelId: `panel-${index}` };
      const nextGrant = instance.mintGrant(nextContext);
      grantSessionIds.push(nextContext.sessionId);
      pending.push(post(url, nextGrant.capability, { operation: "run", hostId: "h", command: "global" }));
    }
    await vi.waitFor(() => expect(service.runCommand).toHaveBeenCalledTimes(8));
    const extra = instance.mintGrant({ ...context, sessionId: "workspace:panel-extra", panelId: "panel-extra" });
    expect((await post(url, extra.capability, { operation: "run", hostId: "h", command: "ninth" })).status).toBe(429);

    for (const sessionId of grantSessionIds) instance.revokeSession(sessionId);
    expect(service.runCommand.mock.calls.map(([args]) => args.signal.aborted)).toEqual(Array(8).fill(true));
    await Promise.all(pending);
  });

  test("aborts an in-flight operation when the requesting HTTP client disconnects", async () => {
    let operationSignal: AbortSignal | undefined;
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => (operationStarted = resolve));
    const service = {
      listHosts: vi.fn(() => []),
      runCommand: vi.fn(({ signal }: { signal: AbortSignal }) => {
        operationSignal = signal;
        operationStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }),
    };
    const { url, grant } = await broker({ service });
    const controller = new AbortController();
    const pending = postWithSignal(
      url,
      grant.capability,
      { operation: "run", hostId: "h", command: "slow" },
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));
  });

  test("broker shutdown cancels running SSH operations", async () => {
    let operationSignal: AbortSignal | undefined;
    let operationStarted!: () => void;
    const started = new Promise<void>((resolve) => (operationStarted = resolve));
    const service = {
      listHosts: vi.fn(() => []),
      runCommand: vi.fn(({ signal }: { signal: AbortSignal }) => {
        operationSignal = signal;
        operationStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      }),
    };
    const { instance, url, grant } = await broker({ service });
    const pending = post(url, grant.capability, { operation: "run", hostId: "h", command: "slow" });
    await started;
    await instance.close();

    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true));
    await pending;
  });
});

function postWithSignal(url: string, capability: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${capability}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
