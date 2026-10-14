/**
 * The runtime's cache in front of the SSH platform preflight. The preflight spawns processes and took
 * 2.6–4 s; the renderer asks for it from several places at startup, and every one of them used to pay
 * for its own probe. Only the probe is replaced here — the handler, its cache and its key are the real
 * ones `createRuntime` wires (runtime.ts: `createSshHandlers({ sshManager, store, credentialStore, … })`).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { preflightMock } = vi.hoisted(() => ({ preflightMock: vi.fn() }));
vi.mock("./ssh-platform.js", () => ({ runPlatformPreflight: preflightMock }));

import { createSshHandlers, SSH_CAPABILITIES_TTL_MS } from "./runtime-ssh-handlers.js";

function capabilities(tag: string) {
  return {
    platform: "win32",
    arch: "x64",
    safeStorageAvailable: true,
    sshKeygen: true,
    systemSsh: true,
    openSshAgent: false,
    pageant: false,
    wsl: null,
    permissions: { canManageHosts: true },
    tag,
  };
}

function fixture() {
  let clock = 1_000_000;
  const state = { settings: { ssh: { systemSshPath: "", wslSshExec: "ssh", agentPath: "" } } };
  const handlers = createSshHandlers({
    store: { getState: () => state },
    credentialStore: { isEncryptionAvailable: () => true },
    sshManager: {},
    broadcastState: () => undefined,
    now: () => clock,
  });
  return {
    state,
    get: () => handlers["ssh:capabilities:get"](),
    // The payload the IPC handler and the remote route pass on for Settings → SSH (`ssh.load(true)`).
    refresh: () => handlers["ssh:capabilities:get"]({ refresh: true }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("ssh:capabilities:get cache", () => {
  beforeEach(() => {
    preflightMock.mockReset();
  });

  test("callers that ask while a probe is running share it", async () => {
    let release: (value: unknown) => void = () => undefined;
    preflightMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { get } = fixture();

    const first = get();
    const second = get();
    const third = get();
    release({ capabilities: capabilities("one"), warnings: [] });

    expect(await Promise.all([first, second, third])).toEqual([
      expect.objectContaining({ tag: "one" }),
      expect.objectContaining({ tag: "one" }),
      expect.objectContaining({ tag: "one" }),
    ]);
    expect(preflightMock).toHaveBeenCalledTimes(1);
  });

  test("answers from the cache inside the TTL and probes again after it", async () => {
    preflightMock
      .mockResolvedValueOnce({ capabilities: capabilities("first"), warnings: [] })
      .mockResolvedValueOnce({ capabilities: capabilities("second"), warnings: [] });
    const { get, advance } = fixture();

    expect(await get()).toMatchObject({ tag: "first" });
    advance(SSH_CAPABILITIES_TTL_MS - 1);
    expect(await get()).toMatchObject({ tag: "first" });
    expect(preflightMock).toHaveBeenCalledTimes(1);

    advance(1);
    expect(await get()).toMatchObject({ tag: "second" });
    expect(preflightMock).toHaveBeenCalledTimes(2);
  });

  test("a change to settings.ssh is a miss at once, and the probe gets the new settings", async () => {
    preflightMock
      .mockResolvedValueOnce({ capabilities: capabilities("old"), warnings: [] })
      .mockResolvedValueOnce({ capabilities: capabilities("new"), warnings: [] });
    const { get, state } = fixture();

    expect(await get()).toMatchObject({ tag: "old" });
    state.settings.ssh = { ...state.settings.ssh, systemSshPath: "C:/tools/ssh.exe" };
    expect(await get()).toMatchObject({ tag: "new" });
    expect(preflightMock).toHaveBeenLastCalledWith(expect.objectContaining({ systemSshPath: "C:/tools/ssh.exe" }));
  });

  test("an explicit refresh is never answered from the cache, and its result serves the next caller", async () => {
    // Someone who just installed OpenSSH or started an agent and opens Settings → SSH must see it now,
    // not when the cached answer expires.
    preflightMock
      .mockResolvedValueOnce({ capabilities: capabilities("before-install"), warnings: [] })
      .mockResolvedValueOnce({ capabilities: capabilities("after-install"), warnings: [] });
    const { get, refresh, advance } = fixture();

    expect(await get()).toMatchObject({ tag: "before-install" });
    advance(1_000);
    expect(await refresh()).toMatchObject({ tag: "after-install" });
    expect(await get()).toMatchObject({ tag: "after-install" });
    expect(preflightMock).toHaveBeenCalledTimes(2);
  });

  test("an explicit refresh joins a probe that is already running instead of starting another", async () => {
    let release: (value: unknown) => void = () => undefined;
    preflightMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const { get, refresh } = fixture();

    const startup = get();
    const fromSettings = refresh();
    release({ capabilities: capabilities("running"), warnings: [] });

    expect(await fromSettings).toMatchObject({ tag: "running" });
    expect(await startup).toMatchObject({ tag: "running" });
    expect(preflightMock).toHaveBeenCalledTimes(1);
  });

  test("a failed probe is not cached", async () => {
    preflightMock
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce({ capabilities: capabilities("retry"), warnings: [] });
    const { get } = fixture();

    await expect(get()).rejects.toThrow("spawn failed");
    expect(await get()).toMatchObject({ tag: "retry" });
    expect(preflightMock).toHaveBeenCalledTimes(2);
  });
});
