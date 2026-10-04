import { describe, expect, test } from "vitest";
import { DEFERRED_SSH_RUNTIME_CHANNELS, registerDeferredSshIpcHandlers } from "./ssh-bootstrap-ipc.js";

function createIpcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      if (handlers.has(channel)) throw new Error(`Handler already registered: ${channel}`);
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  };
}

describe("deferred SSH IPC", () => {
  test("waits for runtime readiness, forwards adjacent RPC payloads once, and releases channels for full registration", async () => {
    const ipcMain = createIpcMain();
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const dispose = registerDeferredSshIpcHandlers(ipcMain, async (method, ...args) => {
      await ready;
      calls.push({ method, args });
      return { method, args };
    });
    const generatePayload = { kind: "ed25519", comment: "workstation" };
    const generate = ipcMain.handlers.get("ssh:keys:generate");
    expect(generate).toBeDefined();
    const pending = generate!({ sender: "renderer" }, generatePayload);

    expect(calls).toEqual([]);
    resolveReady();
    await expect(pending).resolves.toEqual({ method: "ssh:keys:generate", args: [generatePayload] });
    expect(calls).toEqual([{ method: "ssh:keys:generate", args: [generatePayload] }]);

    const renamePayload = { id: "key-1", label: "renamed" };
    await expect(ipcMain.handlers.get("ssh:keys:rename")!({}, renamePayload)).resolves.toEqual({
      method: "ssh:keys:rename",
      args: [renamePayload],
    });
    expect(calls.at(-1)).toEqual({ method: "ssh:keys:rename", args: [renamePayload] });
    expect(ipcMain.handlers.has("ssh:test:start")).toBe(false);
    expect(ipcMain.handlers.has("ssh:keys:transfer:start")).toBe(false);
    expect(ipcMain.handlers.has("ssh:auth:answer")).toBe(false);
    expect(ipcMain.handlers.has("ssh:host-key:accept")).toBe(false);

    dispose();
    expect(ipcMain.handlers.size).toBe(0);
    for (const channel of DEFERRED_SSH_RUNTIME_CHANNELS) ipcMain.handle(channel, async () => "full handler");
    expect(ipcMain.handlers.size).toBe(DEFERRED_SSH_RUNTIME_CHANNELS.length);
  });

  test("propagates runtime startup failure to the waiting SSH RPC", async () => {
    const ipcMain = createIpcMain();
    const startupFailure = new Error("Runtime startup failed.");
    const dispose = registerDeferredSshIpcHandlers(ipcMain, async () => {
      await Promise.reject(startupFailure);
    });

    await expect(ipcMain.handlers.get("ssh:keys:generate")!({}, { kind: "rsa" })).rejects.toBe(startupFailure);
    dispose();
  });
});
