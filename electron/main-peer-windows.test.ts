import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { answerWindowBackendDuringBoot } from "./shared/window-backend-bootstrap.js";
import { DEFERRED_SSH_RUNTIME_CHANNELS } from "./backend/ssh-bootstrap-ipc.js";
import { PEER_WINDOW_ALLOWED_CHANNELS, PEER_WINDOW_ALLOWED_EVENTS } from "./shared/peer-window-channels.js";

// main.ts cannot be loaded without Electron, so its peer-window decisions are pinned by reading the source: every
// channel it registers itself needs a decision, and the guard wrapper is the only way it registers one.

// Compared as LF: a checkout may give main.ts CRLF.
const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll("\r\n", "\n");

/** Registered in main.ts and refused in a window attached to another desktop: each touches local state, files or windows keyed to the host's ids. */
const REFUSED_IN_PEER_WINDOW = [
  "state:get",
  "workspace:activate",
  "project:activate",
  "session:activate",
  "attention:sync",
  "sandbox:requests",
  "sidebar-notes:list",
  "sidebar-notes:installation:get",
  "diff:popout:open",
  "diff:popout:get-init",
  "file:popout:open",
  "file:popout:get-init",
  "notes:popout:open",
  "notes:popout:get-init",
];

const registeredChannels = (): string[] => {
  const channels = new Set<string>();
  for (const match of source.matchAll(/\b(?:handleIpc|handle)\(\s*"([^"]+)"/g)) channels.add(match[1]!);
  return [...channels];
};

describe("channels registered directly in main.ts and the peer-window decision", () => {
  test("every channel is allowlisted or in the explicit refused list, never both", () => {
    const channels = registeredChannels();
    expect(channels.length).toBeGreaterThan(15);
    for (const channel of channels) {
      const allowed = PEER_WINDOW_ALLOWED_CHANNELS.has(channel);
      const refused = REFUSED_IN_PEER_WINDOW.includes(channel);
      expect(allowed !== refused, `${channel}: allowed=${allowed} refused=${refused}`).toBe(true);
    }
  });

  test("the refused list names only channels main.ts registers", () => {
    const channels = registeredChannels();
    for (const channel of REFUSED_IN_PEER_WINDOW) expect(channels, channel).toContain(channel);
  });

  test("nothing is registered on ipcMain with a literal channel: it all goes through the guard", () => {
    expect(source).not.toMatch(/ipcMain\.(?:handle|on|once)\(\s*"/);
    expect(source.match(/ipcMain\.(?:handle|on|once)\(/g)).toHaveLength(1);
    expect(source).toMatch(
      /function handleIpc\([^)]*\)[^{]*\{\s*ipcMain\.handle\(channel, \(event, \.\.\.args\) => \{\s*if \(refusedForPeerWindow\(channel, event\)\)/,
    );
  });

  test("the deferred SSH handlers are registered through the guard and none of them is allowed", () => {
    expect(source).toMatch(/registerDeferredSshIpcHandlers\(\s*\{\s*handle: handleIpc/);
    for (const channel of DEFERRED_SSH_RUNTIME_CHANNELS)
      expect(PEER_WINDOW_ALLOWED_CHANNELS.has(channel), channel).toBe(false);
  });

  test("both popouts and everything that reads local state are refused, the window chrome and updates are allowed", () => {
    for (const channel of ["diff:popout:open", "file:popout:open", "state:get", "workspace:activate"]) {
      expect(PEER_WINDOW_ALLOWED_CHANNELS.has(channel), channel).toBe(false);
    }
    for (const channel of [
      "window:get-id",
      "window:focus-current",
      "window:create",
      "window:close",
      "window:confirm-close-response",
      "app:update-status",
      "app:download-update",
      "app:open-update-release",
      "app:restart-for-update",
      "perf:get-snapshot",
      "shell:open-external",
    ]) {
      expect(PEER_WINDOW_ALLOWED_CHANNELS.has(channel), channel).toBe(true);
    }
  });
});

describe("window:get-backend before the runtime's IPC exists", () => {
  test("a bootstrap handler is registered with the others and removed before registerIpc registers the real one", () => {
    const registered = source.slice(source.indexOf("function registerBootstrapIpcHandlers"));
    expect(registered.slice(0, registered.indexOf("function unregisterBootstrapIpcHandlers"))).toMatch(
      /handleIpc\("window:get-backend"/,
    );
    const unregistered = source.slice(source.indexOf("function unregisterBootstrapIpcHandlers"));
    expect(unregistered.slice(0, unregistered.indexOf("\n}\n"))).toMatch(
      /ipcMain\.removeHandler\("window:get-backend"\)/,
    );
    expect(
      source.indexOf("unregisterBootstrapIpcHandlers();\n  runtimeState.disposeIpc = registerIpc("),
    ).toBeGreaterThan(0);
  });

  test("a restored peer window waits for registerIpc, and a runtime that fails to start rejects the wait", () => {
    expect(source).toMatch(/answerWindowBackendDuringBoot\(\{\s*isBootPeerWindow: bootPeerWindowIds\.has\(/);
    expect(source).toMatch(/ipcReady: ipcRegistered/);
    expect(source).toMatch(/\}\);\s*markIpcRegistered\(\);/);
    expect(source).toMatch(/runtimeReady\.catch\(\(error: unknown\) => \{\s*markIpcFailed\(error\);/);
  });
});

describe("answerWindowBackendDuringBoot", () => {
  const peer = {
    kind: "peer",
    hostId: "h",
    hostLabel: "H",
    remoteProfileId: "p",
    clientId: "c",
    terminalFontSize: 13,
  } as const;

  test("a local window is answered at once, without waiting for the runtime", async () => {
    const getBackend = vi.fn();
    const answer = await answerWindowBackendDuringBoot({
      isBootPeerWindow: false,
      ipcReady: new Promise<void>(() => {}),
      getBackend,
    });
    expect(answer).toEqual({ kind: "local" });
    expect(getBackend).not.toHaveBeenCalled();
  });

  test("a peer window resolves only after the IPC is registered, with the runtime's answer", async () => {
    let ready!: () => void;
    const ipcReady = new Promise<void>((resolve) => (ready = resolve));
    const getBackend = vi.fn(() => peer);
    let settled = false;
    const pending = answerWindowBackendDuringBoot({ isBootPeerWindow: true, ipcReady, getBackend }).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(getBackend).not.toHaveBeenCalled();
    ready();
    expect(await pending).toEqual(peer);
  });

  test("a peer window is rejected when the runtime failed to start", async () => {
    await expect(
      answerWindowBackendDuringBoot({
        isBootPeerWindow: true,
        ipcReady: Promise.reject(new Error("boom")),
        getBackend: () => peer,
      }),
    ).rejects.toThrow("boom");
  });
});

describe("events main.ts pushes into windows", () => {
  test("the broadcast is filtered by the peer event allowlist", () => {
    expect(source).toMatch(/const peerEvent = isEventAllowedInPeerWindow\(channel\);/);
    expect(source).toMatch(/if \(!peerEvent && isPeerWindowId\(windowId\)\) continue;/);
  });

  test("every event main.ts sends to one window itself is a window-level event a peer window may receive", () => {
    const sent = new Set<string>();
    for (const match of source.matchAll(/webContents\.send\(\s*"([^"]+)"/g)) sent.add(match[1]!);
    for (const match of source.matchAll(/emitToWindow\(\s*[A-Za-z.]+,\s*"([^"]+)"/g)) sent.add(match[1]!);
    expect(sent.size).toBeGreaterThan(2);
    for (const channel of sent) expect(PEER_WINDOW_ALLOWED_EVENTS.has(channel), channel).toBe(true);
  });
});

describe("main.ts never takes a window attached to another desktop for a window of a local profile", () => {
  test("a window's local profile is null for a peer window, and the screenshot picks a local window", () => {
    expect(source).toMatch(
      /function getWindowProfileId\(windowId: string\): string \| null \{\s*if \(isPeerWindowId\(windowId\)\) return null;/,
    );
    expect(source).toMatch(/getPrimaryWindow\(\{ localOnly: true \}\)/);
  });
});
