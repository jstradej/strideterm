import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AttachmentReadRequest, AttachmentReadResult } from "../shared/attachment-upload.js";
import {
  PEER_ATTACHMENT_COPY_FINISHED_CHANNEL,
  type PeerAttachmentCopyFinished,
} from "../shared/peer-attachment-copy-events.js";
import {
  defaultPeerSettings,
  type PeerAttachmentList,
  type PeerHello,
  type PeerIntegrationSettings,
} from "../shared/peers.js";
import type { AppState } from "../shared/types/state.js";
import type { RemoteClientRegistry } from "./remote-client-registry.js";
import { startRemoteServer } from "./remote-server.js";
import * as attachments from "./attachments.js";
import { createPeerAttachmentsHost } from "./peers/peer-attachments.js";
import { createFakeGlobalNoteHost } from "./peers/global-note-host.fake.js";
import { createPeerHost } from "./peers/peer-host.js";
import { createRuntimePeers, peerWindowClientId } from "./runtime-peers.js";
import type { Logger } from "./logger.js";

type LogCall = { level: string; label: string; message: string; meta?: Record<string, unknown> };
const logCalls = vi.hoisted(() => [] as LogCall[]);
// Records every call and still forwards it to the real logger.
vi.mock("./logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger.js")>();
  return {
    ...actual,
    getLogger: (label: string): Logger => {
      const real = actual.getLogger(label);
      const capture =
        (level: string, forward: Logger["info"]): Logger["info"] =>
        (message, meta) => {
          logCalls.push({ level, label, message, meta });
          forward(message, meta);
        };
      return {
        error: capture("error", real.error),
        warn: capture("warn", real.warn),
        info: capture("info", real.info),
        debug: capture("debug", real.debug),
        trace: capture("trace", real.trace),
      };
    },
  };
});

// A real host (peer listener + remote server) and the device side of the runtime. What the "window" sends is
// whatever a renderer could put in the request; the host must only ever see the id derived from the window.

const FORGED = "forged-client-0000";

function makeHostRuntime() {
  const payload = {
    appState: {
      settings: { remoteAccess: { enabled: false, host: "127.0.0.1", port: 1, token: "never-valid-here" } },
      profiles: [
        { id: "home", name: "Home", color: "#fff", workspaceIds: ["ws-home"] },
        { id: "work", name: "Work", color: "#000", workspaceIds: ["ws-work"] },
      ],
      workspaces: [
        { id: "ws-home", name: "Home repo", profileId: "home", cwd: "/home-root", panels: [{ id: "a" }] },
        { id: "ws-work", name: "Work repo", profileId: "work", cwd: "/work-root", panels: [{ id: "b" }] },
      ],
      windowSlots: [{ id: "win-home", profileId: "home", activeWorkspaceId: "ws-home" }],
    },
  };
  const registries: RemoteClientRegistry[] = [];
  const base: Record<string, unknown> = {
    getPayload: () => payload,
    getInitialState: async () => payload,
    setRemoteInfo: () => undefined,
    setRemoteClientRegistry: () => undefined,
    addRemoteClientRegistry: (registry: RemoteClientRegistry) => {
      registries.push(registry);
      return () => registries.splice(registries.indexOf(registry), 1);
    },
    listRemoteUrls: () => [],
    on: () => () => undefined,
    isSshTestSessionId: () => false,
    isPrivateSshOperationSessionId: () => false,
    isReviewAgentPreparationSessionId: () => false,
    activateProfileForRemoteClient: (sessionId: string, profileId: string, registry: RemoteClientRegistry) =>
      registry.activateProfile(sessionId, profileId, payload.appState),
  };
  const runtime = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return prop in target ? target[prop] : () => payload;
    },
  });
  return { runtime, registries };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function startPair() {
  const hostSettings = defaultPeerSettings();
  hostSettings.hosting.enabled = true;
  const hostSecrets = new Map<string, string>();
  const peerHost = createPeerHost({
    getSettings: () => hostSettings,
    updateSettings: async (_reason, update) => {
      await Promise.resolve();
      update(hostSettings);
    },
    credentials: {
      getSecret: (ref) => hostSecrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        hostSecrets.set(ref, secret);
      },
      isEncryptionAvailable: () => true,
    },
    appVersion: "1.0.0",
    hostName: () => "Host PC",
    emit: () => undefined,
  });
  const { instanceId: hostId } = await peerHost.ensureIdentity();
  const helloOverride = { appVersion: "1.0.0", hostInstanceId: hostId };
  const hello = (): PeerHello => ({
    protocolVersion: 1,
    hostInstanceId: helloOverride.hostInstanceId,
    hostName: "Host PC",
    appVersion: helloOverride.appVersion,
    profiles: [{ id: "home", name: "Home", color: "#fff", workspaceCount: 1 }],
  });
  const host = makeHostRuntime();
  const note = createFakeGlobalNoteHost();
  const hostAttachState = {
    profiles: [{ id: "home", name: "Home" }],
    workspaces: [] as Array<Record<string, unknown>>,
  };
  const hostAttachments = createPeerAttachmentsHost({ getState: () => hostAttachState as never });
  const hostHooks = {
    list: (): Promise<PeerAttachmentList> => hostAttachments.list(),
    read: (request: AttachmentReadRequest): Promise<AttachmentReadResult> => hostAttachments.read(request),
  };
  let hostServer: Awaited<ReturnType<typeof startRemoteServer>> | null = null;
  const bindHost = async (port: number) => {
    hostServer = await startRemoteServer({
      runtime: host.runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
      peerOrigin: {
        host: "127.0.0.1",
        port,
        peerHost,
        hello,
        listDirectories: async () => {
          throw new Error("unused");
        },
        attention: () => ({ total: 0, profiles: [], globalNoteRevision: note.revision() }),
        getGlobalNote: () => note.get(),
        saveGlobalNote: (input) => note.save(input),
        undoGlobalNote: (input) => note.undo(input),
        listAttachments: () => hostHooks.list(),
        readAttachment: (request) => hostHooks.read(request),
      },
    });
    return hostServer;
  };
  const server = await bindHost(0);
  const hostPort = server.address!.port;

  const peers: PeerIntegrationSettings = defaultPeerSettings();
  const state = {
    settings: { terminalFontSizeLocal: 15, integrations: { peers } },
    peerWindows: [],
    windowSlots: [{ id: "local-1", profileId: "default", bounds: { x: 0, y: 0, width: 1, height: 1 } }],
    profiles: [],
    workspaces: [],
  } as unknown as AppState;
  const secrets = new Map<string, string>();
  const events: Array<{ event: string; payload: unknown }> = [];
  const device = createRuntimePeers({
    getState: () => state,
    mutate: async (_reason, mutator) => {
      await Promise.resolve();
      mutator(state);
    },
    credentials: {
      getSecret: (ref) => secrets.get(ref) ?? "",
      setSecret: async (ref, secret) => {
        secrets.set(ref, secret);
      },
      deleteSecret: async (ref) => {
        secrets.delete(ref);
      },
      isEncryptionAvailable: () => true,
    },
    appVersion: "1.0.0",
    emit: (event, payload) => events.push({ event, payload }),
  });
  open.push(async () => {
    device.dispose();
    await hostServer?.close();
  });

  const started = await device.startPairing({ address: "127.0.0.1", port: hostPort });
  const pending = peerHost.listPending();
  expect(await peerHost.approvePairing(pending[0]!.pairingId, started.code)).toBe("approved");
  await waitFor(() => peers.hosts.length === 1, "paired host");
  return {
    device,
    host,
    peers,
    state,
    hostId,
    events,
    peerHost,
    helloOverride,
    hostAttachState,
    hostHooks,
    note,
    stopHost: async () => {
      await hostServer?.close();
      hostServer = null;
    },
    startHost: async () => {
      await bindHost(hostPort);
    },
  };
}

describe("windows attached to another desktop reach the host as the window, not as the renderer says", () => {
  test("an HTTP request carries the window's derived client id whatever the renderer sent", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    const clientId = peerWindowClientId(peers.instanceId, slot.id);
    expect(clientId).toMatch(/^[a-zA-Z0-9_-]{8,80}$/);

    for (const header of ["X-Strideterm-Client-Id", "x-strideterm-client-id"]) {
      const response = await device.peerWindowRequest(slot.id, {
        method: "GET",
        pathname: "/api/state",
        headers: { [header]: FORGED },
      });
      expect(response.status).toBe(200);
    }
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${clientId}`)).toBeDefined();
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${FORGED}`)).toBeUndefined();
    expect(device.getWindowBackend(slot.id)).toEqual({
      kind: "peer",
      hostId,
      hostLabel: "Host PC",
      remoteProfileId: "home",
      clientId,
      terminalFontSize: 15,
    });
  });

  test("a WebSocket carries the window's derived client id whatever the renderer sent", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    const clientId = peerWindowClientId(peers.instanceId, slot.id);

    const socket = device.peerWindowOpenSocket(slot.id, { clientId: FORGED, ClientID: FORGED, rev: "999" });
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(data));
    await waitFor(() => frames.some((frame) => frame.includes('"stateProtocol":2')), "first state frame");
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${clientId}`)).toBeDefined();
    expect(host.registries[0]!.get(`peer:${peers.instanceId}:${FORGED}`)).toBeUndefined();
    socket.close();
  });

  test("a window that is not attached cannot use the link, and removing the host closes its windows' route", async () => {
    const { device, state, hostId, events } = await startPair();
    await expect(
      device.peerWindowRequest("local-1", { method: "GET", pathname: "/api/state", headers: {} }),
    ).rejects.toThrow("This window is not attached to another desktop.");
    expect(() => device.peerWindowOpenSocket("local-1", {})).toThrow("This window is not attached to another desktop.");

    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    expect(state.peerWindows).toHaveLength(1);
    expect(await device.removeHost(hostId)).toBe(true);
    expect(events).toContainEqual({ event: "peers:host-removed", payload: { hostId, windowIds: [slot.id] } });
    await expect(
      device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} }),
    ).rejects.toThrow();
  });
});

describe("the first contact already names the profile the window is bound to", () => {
  const contextOf = (host: { registries: RemoteClientRegistry[] }, instanceId: string, windowId: string) =>
    host.registries[0]!.get(`peer:${instanceId}:${peerWindowClientId(instanceId, windowId)}`);

  test("a new window bound to a non-fallback profile starts there, and a forged profileId is replaced", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "work" });

    const response = await device.peerWindowRequest(slot.id, {
      method: "GET",
      pathname: "/api/state?profileId=home&x=1",
      headers: {},
    });
    expect(response.status).toBe(200);
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");
    const payload = JSON.parse(String(response.body)) as {
      appState: { workspaces: Array<{ id: string }> };
      remoteClient: { profileId: string };
    };
    expect(payload.remoteClient.profileId).toBe("work");
    expect(payload.appState.workspaces.map((workspace) => workspace.id)).toEqual(["ws-work"]);
  });

  test("a new socket starts on the bound profile whatever the renderer sent", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "work" });
    const socket = device.peerWindowOpenSocket(slot.id, { profileId: "home", PROFILEID: "home", rev: "999" });
    const frames: string[] = [];
    socket.on("message", (data) => frames.push(data));
    await waitFor(() => frames.some((frame) => frame.includes('"stateProtocol":2')), "first state frame");
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");
    socket.close();
  });

  test("a bound profile the host no longer has falls back without an error", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "gone" });
    const response = await device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} });
    expect(response.status).toBe(200);
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("home");
  });

  test("a later request with a stale profile does not move a context the user switched", async () => {
    const { device, host, peers, hostId } = await startPair();
    const slot = await device.createPeerWindowSlot({ hostId, profileId: "home" });
    await device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} });
    const activate = await device.peerWindowRequest(slot.id, {
      method: "POST",
      pathname: "/api/remote-client/profile/activate",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "work" }),
    });
    expect(activate.status).toBe(200);
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");

    await device.peerWindowRequest(slot.id, { method: "GET", pathname: "/api/state", headers: {} });
    expect(contextOf(host, peers.instanceId, slot.id)?.profileId).toBe("work");
  });
});

describe("a window may only be opened or switched to a host that is reachable, current and paired", () => {
  test("an online host passes, and the other four states are refused with their reason", async () => {
    const { device, hostId, peerHost, helloOverride } = await startPair();
    await expect(device.requireHostOnline(hostId)).resolves.toMatchObject({ state: "online" });

    helloOverride.appVersion = "2.0.0";
    await expect(device.requireHostOnline(hostId)).rejects.toThrow(
      "Host PC runs strIDEterm 2.0.0, this desktop runs 1.0.0. Both must run the same version.",
    );
    helloOverride.appVersion = "1.0.0";

    helloOverride.hostInstanceId = "another-instance-id";
    await expect(device.requireHostOnline(hostId)).rejects.toThrow(
      "The address of Host PC now answers as another strIDEterm.",
    );
    helloOverride.hostInstanceId = hostId;
    await expect(device.requireHostOnline(hostId)).resolves.toMatchObject({ state: "online" });

    await peerHost.removeDevice(peerHost.listDevices()[0]!.id);
    await device.refreshHost(hostId, { force: true });
    await expect(device.requireHostOnline(hostId)).rejects.toThrow(
      "Host PC no longer accepts this desktop. Pair it again.",
    );
  });

  test("a host that does not answer is reported as unreachable, an unknown one as not attached", async () => {
    const { device, hostId, peers } = await startPair();
    peers.hosts[0]!.port = 1;
    await expect(device.requireHostOnline(hostId)).rejects.toThrow("Host PC cannot be reached.");
    await expect(device.requireHostOnline("host-unknown1")).rejects.toThrow("This desktop is not attached.");
  });
});

describe("a paired host's global note, read and written from the device", () => {
  test("reads, saves and undoes it, and a concurrent save comes back as the host's own sentence", async () => {
    const pair = await startPair();
    const empty = await pair.device.getHostGlobalNote(pair.hostId);
    expect(empty).toEqual({
      note: { id: "global", text: "", revision: 0, canUndo: false },
      installationName: "Host PC",
    });

    const saved = await pair.device.saveHostGlobalNote(pair.hostId, { text: "from the laptop", expectedRevision: 0 });
    expect(saved.note).toMatchObject({ text: "from the laptop", revision: 1, canUndo: true });
    expect(pair.note.get().note.text).toBe("from the laptop");

    await pair.note.save({ text: "typed on the host meanwhile", expectedRevision: 1 });
    await expect(pair.device.saveHostGlobalNote(pair.hostId, { text: "stale", expectedRevision: 1 })).rejects.toThrow(
      "This note has changed. Reload it before trying again.",
    );
    expect(pair.note.get().note.text).toBe("typed on the host meanwhile");

    const latest = await pair.device.getHostGlobalNote(pair.hostId);
    const undone = await pair.device.undoHostGlobalNote(pair.hostId, { expectedRevision: latest.note.revision });
    expect(undone.note.text).toBe("from the laptop");
  });

  test("refuses an unknown host and one that cannot be reached, with the reason", async () => {
    const pair = await startPair();
    await expect(pair.device.getHostGlobalNote("host-unknown-1")).rejects.toThrow(/not attached/);
    await pair.stopHost();
    await pair.device.refreshHost(pair.hostId, { force: true });
    await expect(pair.device.getHostGlobalNote(pair.hostId)).rejects.toThrow(/cannot be reached/);
    await expect(pair.device.saveHostGlobalNote(pair.hostId, { text: "x", expectedRevision: 0 })).rejects.toThrow(
      /cannot be reached/,
    );
    expect(pair.note.get().note.revision).toBe(0);
  });

  test("a host of another version is refused before anything is sent", async () => {
    const pair = await startPair();
    pair.helloOverride.appVersion = "9.9.9";
    await pair.device.refreshHost(pair.hostId, { force: true });
    await expect(pair.device.getHostGlobalNote(pair.hostId)).rejects.toThrow(/Both must run the same version/);
  });
});

describe("copying a paired desktop's attachment into a local workspace", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  });

  const tempRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-peer-copy-"));
    roots.push(root);
    return root;
  };

  async function seedHost(pair: Awaited<ReturnType<typeof startPair>>, bytes: Buffer, name = "photo.png") {
    const root = await tempRoot();
    const started = await attachments.begin(
      root,
      name,
      bytes.length,
      "",
      "seed",
      `seed-${name}`,
      attachments.DESKTOP_LIMITS,
    );
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
      await attachments.chunk(
        root,
        started.transferId,
        offset,
        bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
        "seed",
      );
    }
    await attachments.finish(root, started.transferId, "seed");
    const workspaceId = `hws-${randomUUID().slice(0, 8)}`;
    pair.hostAttachState.workspaces.push({
      id: workspaceId,
      name: "Host repo",
      profileId: "home",
      cwd: root,
      panels: [],
    });
    return {
      workspaceId,
      transferId: started.transferId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      name,
      size: bytes.length,
    };
  }

  async function localWorkspace(pair: Awaited<ReturnType<typeof startPair>>, extra: Record<string, unknown> = {}) {
    const root = await tempRoot();
    const workspace = {
      id: `lw-${randomUUID().slice(0, 8)}`,
      name: "Local",
      profileId: "default",
      cwd: root,
      panels: [],
      ...extra,
    };
    (pair.state.workspaces as unknown as Array<Record<string, unknown>>).push(workspace);
    return { id: workspace.id as string, root };
  }

  const request = (
    pair: Awaited<ReturnType<typeof startPair>>,
    source: Awaited<ReturnType<typeof seedHost>>,
    targetWorkspaceId: string,
  ) => ({
    hostId: pair.hostId,
    source: {
      workspaceId: source.workspaceId,
      transferId: source.transferId,
      name: source.name,
      size: source.size,
      sha256: source.sha256,
    },
    targetWorkspaceId,
  });

  const finishedEvents = (pair: Awaited<ReturnType<typeof startPair>>) =>
    pair.events
      .filter((entry) => entry.event === PEER_ATTACHMENT_COPY_FINISHED_CHANNEL)
      .map((entry) => entry.payload as PeerAttachmentCopyFinished);

  const BYTES = randomBytes(1024 * 1024 + 300_000);

  test("lists the host's attachments and copies a whole file into the target workspace", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const target = await localWorkspace(pair);

    const list = await pair.device.listHostAttachments(pair.hostId);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      profileName: "Home",
      workspaceName: "Host repo",
      name: "photo.png",
      size: BYTES.length,
    });

    const { copyId } = await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    expect(pair.device.getAttachmentCopiesPayload().running.map((run) => run.copyId)).toEqual([copyId]);
    await waitFor(() => finishedEvents(pair).length === 1, "the finish event");

    const [event] = finishedEvents(pair);
    expect(event).toMatchObject({
      copyId,
      state: "succeeded",
      workspaceId: target.id,
      hostId: pair.hostId,
      profileId: "default",
    });
    expect(event!.result).toMatchObject({ name: "photo.png", size: BYTES.length, sha256: source.sha256 });
    const payload = pair.device.getAttachmentCopiesPayload();
    expect(payload.running).toEqual([]);
    expect(payload.lastResults.map((run) => [run.copyId, run.state, run.bytesDone])).toEqual([
      [copyId, "succeeded", BYTES.length],
    ]);

    const local = await attachments.list(target.root);
    expect(local.map((entry) => entry.sha256)).toEqual([source.sha256]);
    const block = await attachments.read(target.root, local[0]!.transferId, "photo.png", 0, 512 * 1024);
    expect(block.bytes.equals(BYTES.subarray(0, 512 * 1024))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("psk");
  });

  test("one malformed item is dropped and logged once; the rest of the list survives, a malformed envelope fails it", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const real = await createPeerAttachmentsHost({ getState: () => pair.hostAttachState as never }).list();
    const good = real.items[0]!;
    pair.hostHooks.list = async () =>
      ({
        items: [{ ...good, sha256: "not-a-hash" }, good, { ...good, name: "" }],
        truncated: false,
      }) as PeerAttachmentList;
    logCalls.length = 0;
    const list = await pair.device.listHostAttachments(pair.hostId);
    expect(list.items.map((item) => item.transferId)).toEqual([source.transferId]);
    expect(logCalls.filter((call) => call.message === "peer attachment list dropped items it cannot read")).toEqual([
      expect.objectContaining({ level: "warn", meta: expect.objectContaining({ dropped: 2 }) }),
    ]);

    pair.hostHooks.list = async () => ({ items: "nope", truncated: false }) as unknown as PeerAttachmentList;
    await expect(pair.device.listHostAttachments(pair.hostId)).rejects.toThrow(/cannot read/);
  });

  test("a second start of a running copy returns the same copy; of a finished one, answers from the store", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const target = await localWorkspace(pair);
    const first = await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    const again = await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    expect(again.copyId).toBe(first.copyId);
    await waitFor(() => finishedEvents(pair).length === 1, "the first finish");
    await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    await waitFor(() => finishedEvents(pair).length === 2, "the second finish");
    expect(finishedEvents(pair)[1]!.result!.transferId).toBe(finishedEvents(pair)[0]!.result!.transferId);
    expect(await attachments.list(target.root)).toHaveLength(1);
  });

  test("a failure mid-transfer ends in an error event and the log, and Retry resumes from the offset", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const target = await localWorkspace(pair);
    const offsets: number[] = [];
    let failAt = 2;
    pair.hostHooks.read = async (req) => {
      offsets.push(req.offset);
      if (offsets.length === failAt) throw new Error("disk hiccup on the host");
      return createPeerAttachmentsHost({ getState: () => pair.hostAttachState as never }).read(req);
    };

    await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    await waitFor(() => finishedEvents(pair).length === 1, "the failure");
    expect(finishedEvents(pair)[0]).toMatchObject({ state: "failed" });
    expect(finishedEvents(pair)[0]!.error!.message).toMatch(/refused to send/);
    expect(logCalls).toContainEqual(
      expect.objectContaining({
        level: "warn",
        label: "peers",
        message: "peer attachment copy failed",
        meta: expect.objectContaining({
          copyId: finishedEvents(pair)[0]!.copyId,
          err: finishedEvents(pair)[0]!.error!.message,
        }),
      }),
    );
    expect(pair.device.getAttachmentCopiesPayload().lastResults[0]).toMatchObject({
      state: "failed",
      bytesDone: 512 * 1024,
    });
    expect(await attachments.list(target.root)).toEqual([]);
    const partial = await attachments.listWithUsage(target.root, attachments.DESKTOP_LIMITS);
    expect(partial.usage.activeTransfers).toBe(1);
    expect(partial.usage.storageBytes).toBe(512 * 1024);

    offsets.length = 0;
    failAt = 0;
    await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    await waitFor(() => finishedEvents(pair).length === 2, "the retry");
    expect(finishedEvents(pair)[1]).toMatchObject({ state: "succeeded" });
    expect(offsets).toEqual([512 * 1024, 1024 * 1024]);
    expect((await attachments.list(target.root)).map((entry) => entry.sha256)).toEqual([source.sha256]);
  });

  test("a checksum that does not match deletes the copy and reports the error", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const target = await localWorkspace(pair);
    const wrong = { ...source, sha256: "0".repeat(64) };
    await pair.device.startAttachmentCopy(request(pair, wrong, target.id), "local-1");
    await waitFor(() => finishedEvents(pair).length === 1, "the failure");
    expect(finishedEvents(pair)[0]).toMatchObject({ state: "failed" });
    expect(finishedEvents(pair)[0]!.error!.message).toMatch(/did not arrive intact/);
    expect(await attachments.list(target.root)).toEqual([]);
    expect((await attachments.listWithUsage(target.root, attachments.DESKTOP_LIMITS)).usage).toMatchObject({
      fileCount: 0,
      activeTransfers: 0,
      storageBytes: 0,
    });
  });

  test("a host that goes offline mid-transfer fails the copy, and Retry works once it is back", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const target = await localWorkspace(pair);
    let reads = 0;
    pair.hostHooks.read = async (req) => {
      reads += 1;
      if (reads === 2) {
        await pair.stopHost();
        throw new Error("gone");
      }
      return createPeerAttachmentsHost({ getState: () => pair.hostAttachState as never }).read(req);
    };
    await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    await waitFor(() => finishedEvents(pair).length === 1, "the failure");
    expect(finishedEvents(pair)[0]).toMatchObject({ state: "failed" });

    await pair.startHost();
    pair.hostHooks.read = (req) =>
      createPeerAttachmentsHost({ getState: () => pair.hostAttachState as never }).read(req);
    await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    await waitFor(() => finishedEvents(pair).length === 2, "the retry");
    expect(finishedEvents(pair)[1]).toMatchObject({ state: "succeeded" });
  });

  test("an offline host, a full workspace, a foreign profile and an SSH workspace are refused before anything starts", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const target = await localWorkspace(pair);

    const full = await localWorkspace(pair);
    const id = randomUUID();
    const dir = path.join(full.root, ".strideterm", ".attachment-transfers", id);
    await mkdir(dir, { recursive: true });
    const done = {
      transferId: id,
      path: `.strideterm/attachments/${id}/x`,
      size: 4 * 1024 ** 3,
      sha256: "a".repeat(64),
      name: "x",
    };
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        id,
        name: "x",
        size: done.size,
        sha256: done.sha256,
        offset: done.size,
        createdAt: 1,
        updatedAt: Date.now(),
        done,
      }),
    );
    await expect(pair.device.startAttachmentCopy(request(pair, source, full.id), "local-1")).rejects.toThrow(
      /quota exceeded/,
    );

    const foreign = await localWorkspace(pair, { profileId: "other" });
    await expect(pair.device.startAttachmentCopy(request(pair, source, foreign.id), "local-1")).rejects.toThrow(
      /not available in this profile/,
    );
    const ssh = await localWorkspace(pair, { kind: "ssh" });
    await expect(pair.device.startAttachmentCopy(request(pair, source, ssh.id), "local-1")).rejects.toThrow(
      /unavailable for SSH or container/,
    );
    await expect(
      pair.device.startAttachmentCopy(request(pair, source, target.id), "peer-window-or-unknown"),
    ).rejects.toThrow(/window of this desktop/);
    await expect(
      pair.device.startAttachmentCopy({ ...request(pair, source, target.id), hostId: "unknownhost1" }, "local-1"),
    ).rejects.toThrow(/not attached/);

    await pair.stopHost();
    await pair.device.refreshHost(pair.hostId, { force: true });
    await expect(pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1")).rejects.toThrow(
      /cannot be reached/,
    );
    await expect(pair.device.listHostAttachments(pair.hostId)).rejects.toThrow(/cannot be reached/);
    expect(pair.device.getAttachmentCopiesPayload()).toEqual({ running: [], lastResults: [] });
    expect(finishedEvents(pair)).toEqual([]);
    expect(await attachments.list(target.root)).toEqual([]);
  });

  test("at most two copies per host run at once, the rest wait, and a waiting one can be cancelled", async () => {
    const pair = await startPair();
    const target = await localWorkspace(pair);
    const sources = [];
    for (let index = 0; index < 3; index++) sources.push(await seedHost(pair, randomBytes(700_000), `f${index}.bin`));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = createPeerAttachmentsHost({ getState: () => pair.hostAttachState as never });
    pair.hostHooks.read = async (req) => {
      await gate;
      return host.read(req);
    };
    const ids = [];
    for (const source of sources)
      ids.push((await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1")).copyId);
    expect(
      pair.device
        .getAttachmentCopiesPayload()
        .running.map((run) => run.state)
        .sort(),
    ).toEqual(["queued", "running", "running"]);
    pair.device.cancelAttachmentCopy(ids[2]!, "local-1");
    expect(finishedEvents(pair)).toHaveLength(1);
    expect(finishedEvents(pair)[0]).toMatchObject({ copyId: ids[2], state: "cancelled" });
    release();
    await waitFor(() => finishedEvents(pair).length === 3, "the two running copies");
    expect(finishedEvents(pair).filter((event) => event.state === "succeeded")).toHaveLength(2);
    expect(await attachments.list(target.root)).toHaveLength(2);
  });

  test("cancelling a queued or running copy ends it as cancelled and removes the partial transfer", async () => {
    const pair = await startPair();
    const source = await seedHost(pair, BYTES);
    const target = await localWorkspace(pair);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstRead!: () => void;
    const started = new Promise<void>((resolve) => {
      firstRead = resolve;
    });
    let reads = 0;
    pair.hostHooks.read = async (req) => {
      reads += 1;
      if (reads === 2) {
        firstRead();
        await gate;
      }
      return createPeerAttachmentsHost({ getState: () => pair.hostAttachState as never }).read(req);
    };
    const { copyId } = await pair.device.startAttachmentCopy(request(pair, source, target.id), "local-1");
    await started;
    expect(() => pair.device.cancelAttachmentCopy(copyId, "unknown-window")).toThrow();
    pair.device.cancelAttachmentCopy(copyId, "local-1");
    release();
    await waitFor(() => finishedEvents(pair).length === 1, "the cancellation");
    expect(finishedEvents(pair)[0]).toMatchObject({ copyId, state: "cancelled" });
    expect((await attachments.listWithUsage(target.root, attachments.DESKTOP_LIMITS)).usage).toMatchObject({
      activeTransfers: 0,
      storageBytes: 0,
    });
    expect(() => pair.device.cancelAttachmentCopy(copyId, "local-1")).toThrow(/not running/);
  });
});
