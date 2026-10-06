import { describe, expect, test, vi } from "vitest";

const loggerCapture = vi.hoisted(() => ({
  entries: [] as Array<{ level: string; message: string; fields: unknown }>,
}));

vi.mock("../logger.js", () => ({
  getLogger: () =>
    Object.fromEntries(
      ["error", "warn", "info", "debug", "trace"].map((level) => [
        level,
        (message: string, fields: unknown) => loggerCapture.entries.push({ level, message, fields }),
      ]),
    ),
}));
import { readFileSync } from "node:fs";
import path from "node:path";
import { openEnvelope, sealEnvelope } from "./mobile-crypto.js";
import { decodeRelayFrame, encodeRelayFrame } from "./mobile-relay-protocol.js";
import {
  buildSystemChannelAad,
  createMobileSystemChannel,
  deriveSystemChannelKey,
  SYSTEM_CHANNEL_KEY_INFO,
  SYSTEM_CHANNEL_KEY_SALT,
  type MobileSystemChannelOptions,
} from "./mobile-system-channel.js";
import type { MobileWorkspaceRow } from "./mobile-workspace-projection.js";
import { createCachedMobileSystemPayloadSource } from "./mobile-system-channel-source.js";

const DEVICE = "mobile-AAAAAAAAAAAAAAAAAAAAAA";
const PAIR = "pair-AAAAAAAAAAAAAAAAAAAAAA";
const PROFILE = "profile-work";
const KEY = Buffer.alloc(32, 19);
const CHANNEL_KEY = deriveSystemChannelKey(KEY);

interface TestChange {
  id: string;
  set: Record<string, unknown>;
  unset: string[];
}

interface TestMessage {
  v: number;
  type: string;
  profileId: string;
  epoch: string;
  baseRevision: number;
  revision: number;
  batchId: string;
  part: number;
  parts: number;
  mode: string;
  changes: TestChange[];
  removed: string[];
  order?: string[];
}

function fixture(initial: MobileWorkspaceRow[], sendResult = true, supportedProfiles = [PROFILE]) {
  let rows = initial;
  let available = true;
  let listener: (() => void) | null = null;
  let profileAllowlist = [PROFILE];
  let capabilities: string[] = ["status.read"];
  const getRows = vi.fn((profileId: string) => (available && supportedProfiles.includes(profileId) ? rows : null));
  const options: MobileSystemChannelOptions = {
    resolveDevice: (deviceId) =>
      deviceId === DEVICE ? { deviceId: DEVICE, pairId: PAIR, sessionKey: KEY, capabilities, profileAllowlist } : null,
    source: {
      getRows,
      subscribe: (callback) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
    },
  };
  const channel = createMobileSystemChannel(options);
  const sent: Array<{ sequence: number; ciphertext: Buffer }> = [];
  const close = vi.fn();
  let connectionId = "grant-AAAAAAAAAAAAAAAAAAAAAA";
  let connection = channel.open({ connectionId, deviceId: DEVICE, send: emit, close })!;
  let inboundSequence = 0;
  function emit(sequence: number, ciphertext: Buffer): boolean {
    sent.push({ sequence, ciphertext });
    return sendResult;
  }
  function reconnect(nextConnectionId: string) {
    connectionId = nextConnectionId;
    inboundSequence = 0;
    sent.length = 0;
    connection = channel.open({ connectionId, deviceId: DEVICE, send: emit, close })!;
    return connection;
  }
  function phoneSend(value: unknown): void {
    const sequence = inboundSequence++;
    const sealed = sealEnvelope(
      Buffer.from(JSON.stringify(value)),
      CHANNEL_KEY,
      buildSystemChannelAad({
        connectionId,
        pairId: PAIR,
        deviceId: DEVICE,
        sequence,
        direction: "phone-to-desktop",
      }),
    );
    connection.receive(sequence, Buffer.concat([sealed.nonce, sealed.ciphertext]));
  }
  function additionalPeer(peerConnectionId: string) {
    const peerSent: Array<{ sequence: number; ciphertext: Buffer }> = [];
    const peerClose = vi.fn();
    let peerSequence = 0;
    const peerConnection = channel.open({
      connectionId: peerConnectionId,
      deviceId: DEVICE,
      send: (sequence, ciphertext) => {
        peerSent.push({ sequence, ciphertext });
        return true;
      },
      close: peerClose,
    })!;
    return {
      close: peerClose,
      connection: peerConnection,
      send(value: unknown) {
        const sequence = peerSequence++;
        const sealed = sealEnvelope(
          Buffer.from(JSON.stringify(value)),
          CHANNEL_KEY,
          buildSystemChannelAad({
            connectionId: peerConnectionId,
            pairId: PAIR,
            deviceId: DEVICE,
            sequence,
            direction: "phone-to-desktop",
          }),
        );
        peerConnection.receive(sequence, Buffer.concat([sealed.nonce, sealed.ciphertext]));
      },
      read() {
        return peerSent.map(({ sequence, ciphertext }) => {
          const plaintext = openEnvelope(
            ciphertext.subarray(12),
            ciphertext.subarray(0, 12),
            CHANNEL_KEY,
            buildSystemChannelAad({
              connectionId: peerConnectionId,
              pairId: PAIR,
              deviceId: DEVICE,
              sequence,
              direction: "desktop-to-phone",
            }),
          );
          return JSON.parse(plaintext.toString("utf8")) as TestMessage;
        });
      },
    };
  }
  function readSent() {
    return sent.map(({ sequence, ciphertext }) => {
      const plaintext = openEnvelope(
        ciphertext.subarray(12),
        ciphertext.subarray(0, 12),
        CHANNEL_KEY,
        buildSystemChannelAad({
          connectionId,
          pairId: PAIR,
          deviceId: DEVICE,
          sequence,
          direction: "desktop-to-phone",
        }),
      );
      return JSON.parse(plaintext.toString("utf8")) as TestMessage;
    });
  }
  return {
    channel,
    close,
    connection,
    reconnect,
    sent,
    getRows,
    additionalPeer,
    isSubscribed: () => listener !== null,
    setAllowlist(next: string[]) {
      profileAllowlist = next;
    },
    setCapabilities(next: string[]) {
      capabilities = next;
    },
    setAvailable(next: boolean) {
      available = next;
    },
    phoneSend,
    readSent,
    change(next: MobileWorkspaceRow[]) {
      rows = next;
      listener?.();
    },
  };
}

describe("native mobile system channel", () => {
  test("reads fresh payloads before subscribing and after source unsubscription", () => {
    let payload = { revision: 1 };
    // Assigned only inside the subscribe closure, so declare the widened type explicitly: a plain
    // `null` initialiser would let control-flow analysis narrow the later call site to `never`.
    let listener = null as ((next: { revision: number }) => void) | null;
    const getPayload = vi.fn(() => payload);
    const source = createCachedMobileSystemPayloadSource({
      getPayload,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    });

    expect(source.getPayload()).toEqual({ revision: 1 });
    payload = { revision: 2 };
    expect(source.getPayload()).toEqual({ revision: 2 });

    const changed = vi.fn();
    const unsubscribe = source.subscribe(changed);
    expect(source.getPayload()).toEqual({ revision: 2 });
    payload = { revision: 3 };
    listener?.(payload);
    expect(source.getPayload()).toEqual({ revision: 3 });
    expect(changed).toHaveBeenCalledOnce();

    unsubscribe();
    payload = { revision: 4 };
    expect(source.getPayload()).toEqual({ revision: 4 });
    expect(getPayload).toHaveBeenCalledTimes(4);
  });

  test("answers a valid one-shot liveness ping without reading catalog state", () => {
    const f = fixture([]);
    f.phoneSend({ v: 1, type: "ping", id: "resume_opaque-123" });

    expect(f.readSent()).toEqual([{ v: 1, type: "pong", id: "resume_opaque-123" }]);
    expect(f.getRows).not.toHaveBeenCalled();
    expect(f.channel.stats()).toMatchObject({ profiles: 0, batches: 0, connections: 1 });
    const pingLog = loggerCapture.entries.findLast((entry) => entry.message === "system channel liveness ping");
    expect(pingLog?.level).toBe("debug");
    expect(pingLog?.fields).toEqual({ connectionRef: expect.any(String) });
  });

  test.each([
    { v: 1, type: "ping" },
    { v: 1, type: "ping", id: "" },
    { v: 1, type: "ping", id: "not canonical!" },
    { v: 1, type: "ping", id: "valid-id", extra: true },
  ])("rejects malformed liveness ping %#", (message) => {
    const f = fixture([]);
    f.phoneSend(message);
    expect(f.close).toHaveBeenCalledWith("protocol-error");
    expect(f.sent).toHaveLength(0);
    expect(f.getRows).not.toHaveBeenCalled();
  });

  test("matches and opens the cross-runtime golden frame", () => {
    const vector = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "test-fixtures/system-channel.json"), "utf8"),
    );
    const aad = buildSystemChannelAad({
      connectionId: vector.aadFields.connectionId,
      pairId: vector.aadFields.pairId,
      deviceId: vector.aadFields.deviceId,
      sequence: vector.aadFields.sequence,
      direction: vector.aadFields.direction,
    });
    expect(aad.toString("utf8")).toBe(vector.aadUtf8);
    expect(vector.channelKeySaltUtf8).toBe(SYSTEM_CHANNEL_KEY_SALT);
    expect(vector.channelKeyInfoUtf8).toBe(SYSTEM_CHANNEL_KEY_INFO);
    const channelKey = deriveSystemChannelKey(Buffer.from(vector.sessionKeyBase64, "base64"));
    expect(channelKey.toString("base64")).toBe(vector.channelKeyBase64);
    const payload = Buffer.from(vector.payloadBase64, "base64");
    expect(openEnvelope(payload.subarray(12), payload.subarray(0, 12), channelKey, aad).toString("utf8")).toBe(
      vector.plaintextUtf8,
    );
    const ready = Buffer.from(vector.readyFrameBase64, "base64");
    expect(encodeRelayFrame(vector.readyHeader)).toEqual(ready);
    expect(decodeRelayFrame(ready)).toEqual({ header: vector.readyHeader, payload: Buffer.alloc(0) });
    const dataHeader = vector.dataHeader;
    const data = Buffer.from(vector.dataFrameBase64, "base64");
    expect(encodeRelayFrame(dataHeader, payload)).toEqual(data);
    const decoded = decodeRelayFrame(data);
    expect(decoded.header).toEqual(dataHeader);
    expect(decoded.payload).toEqual(payload);
  });

  test("sends a multipart immutable snapshot for 5,000 rows with a four-part ACK window", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      id: `workspace-${index}`,
      name: `Workspace ${index}`,
      kind: "task",
      tabCount: index % 9,
      taskState: "running",
    }));
    const f = fixture(rows);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    let parts = f.readSent();
    expect(parts.length).toBe(4);
    expect(parts.every((part) => part.parts > 4)).toBe(true);
    const full: TestMessage[] = [...parts];
    for (let index = 0; index < parts[0].parts; index++) {
      const part = parts.find((candidate) => candidate.part === index);
      if (!part) throw new Error(`missing part ${index}`);
      f.phoneSend({
        v: 1,
        type: "ack.part",
        profileId: PROFILE,
        epoch: part.epoch,
        revision: part.revision,
        batchId: part.batchId,
        part: index,
      });
      const nowSent = f.readSent();
      const before = full.length;
      for (const emitted of nowSent.slice(full.length)) full.push(emitted);
      expect(full.length - before).toBeLessThanOrEqual(1);
      parts = nowSent;
    }
    const allParts = full;
    expect(allParts.length).toBe(parts[0].parts);
    expect(new Set(allParts.map((part) => part.batchId)).size).toBe(1);
    expect(new Set(allParts.map((part) => part.revision))).toEqual(new Set([1]));
    expect(allParts.map((part) => part.part)).toEqual(allParts.map((_, index) => index));
    expect(allParts.every((part) => part.parts === allParts.length && part.mode === "snapshot")).toBe(true);
    expect(allParts.every((part) => Buffer.byteLength(JSON.stringify(part)) <= 32 * 1024)).toBe(true);
    expect(allParts.flatMap((part) => part.changes)).toHaveLength(5000);
    expect(allParts.flatMap((part) => part.order)).toHaveLength(5000);
    expect(allParts[0].changes[0]).toEqual({
      id: "workspace-0",
      set: { name: "Workspace 0", kind: "task", tabCount: 0, taskState: "running" },
      unset: [],
    });
  });

  test("confirms an exact current cursor and scopes unsubscribe to the subscribed profile", () => {
    const f = fixture([{ id: "one", name: "One" }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const batch = f.readSent()[0];
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: batch.epoch, revision: batch.revision });
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE, epoch: batch.epoch, revision: batch.revision });
    expect(f.readSent().at(-1)).toEqual({
      v: 1,
      type: "catalog.synced",
      profileId: PROFILE,
      epoch: batch.epoch,
      revision: batch.revision,
    });

    f.phoneSend({ v: 1, type: "unsubscribe", profileId: "wrong-profile" });
    expect(f.close).toHaveBeenCalledWith("protocol-error");
  });

  test("logs lifecycle and catalog metrics without identifiers, keys, or workspace data", () => {
    loggerCapture.entries.length = 0;
    const privateWorkspaceName = "PRIVATE_WORKSPACE_NAME_7fc2";
    const f = fixture([{ id: "private-workspace-id", name: privateWorkspaceName }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const encodedLog = JSON.stringify(loggerCapture.entries);
    expect(encodedLog).toContain("catalog batch");
    expect(encodedLog).not.toContain(privateWorkspaceName);
    expect(encodedLog).not.toContain("private-workspace-id");
    expect(encodedLog).not.toContain(KEY.toString("hex"));
    expect(encodedLog).not.toContain("grant-AAAAAAAAAAAAAAAAAAAAAA");
    expect(JSON.parse(JSON.stringify(f.channel.stats()))).toMatchObject({ opened: 1, batches: 1 });

    loggerCapture.entries.length = 0;
    const denied = fixture([]);
    denied.phoneSend({ v: 1, type: "subscribe", profileId: "private-profile-id" });
    const deniedLog = JSON.stringify(loggerCapture.entries);
    expect(deniedLog).toContain("subscription rejected");
    expect(deniedLog).not.toContain("private-profile-id");
    expect(denied.readSent()).toEqual([
      { v: 1, type: "catalog.error", profileId: "private-profile-id", code: "permission-denied" },
    ]);
    expect(denied.close).not.toHaveBeenCalled();
  });

  test("a device without status.read gets no channel, and losing it refuses the live profile", () => {
    const f = fixture([{ id: "one", name: "One" }]);
    f.setCapabilities(["notifications", "remote.webSession"]);
    const close = vi.fn();
    expect(
      f.channel.open({ connectionId: "grant-BBBBBBBBBBBBBBBBBBBBBB", deviceId: DEVICE, send: () => true, close }),
    ).toBeNull();

    f.setCapabilities(["status.read"]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.batch", profileId: PROFILE });
    const delivered = f.readSent().length;

    // The desktop owner withdraws status.read while the feed is live: the next source change refuses
    // the subscribed profile instead of delivering it, and the socket itself stays open.
    f.setCapabilities(["notifications"]);
    f.change([{ id: "one", name: "Renamed" }]);
    const after = f.readSent().slice(delivered);
    expect(after).toEqual([{ v: 1, type: "catalog.error", profileId: PROFILE, code: "permission-denied" }]);
    expect(f.close).not.toHaveBeenCalled();

    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    expect(f.readSent().at(-1)).toEqual({ v: 1, type: "catalog.error", profileId: PROFILE, code: "permission-denied" });
  });

  test("closes cleanly when the relay send queue refuses a frame", () => {
    const f = fixture([{ id: "one", name: "One" }], false);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    expect(f.close).toHaveBeenCalledWith("queue-overflow");
    expect(f.channel.stats().connections).toBe(0);
  });

  test("rejects an ACK for a part outside the sent window", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ id: `workspace-${index}`, name: `Workspace ${index}` }));
    const f = fixture(rows);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const [first] = f.readSent();
    expect(first.parts).toBeGreaterThan(4);
    f.phoneSend({
      v: 1,
      type: "ack.part",
      profileId: PROFILE,
      epoch: first.epoch,
      revision: first.revision,
      batchId: first.batchId,
      part: 4,
    });
    expect(f.close).toHaveBeenCalledWith("protocol-error");
  });

  test("replays retained changes on a fresh connection and falls back to snapshot after a history gap", () => {
    const f = fixture([{ id: "one", name: "One", count: 0 }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const original = f.readSent()[0];
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: original.epoch, revision: original.revision });
    f.change([{ id: "one", name: "One", count: 1 }]);
    const keepingHistory = f.additionalPeer("grant-DDDDDDDDDDDDDDDDDDDDDD");
    keepingHistory.send({ v: 1, type: "subscribe", profileId: PROFILE, epoch: original.epoch, revision: 1 });
    expect(keepingHistory.read()[0]).toMatchObject({
      type: "catalog.batch",
      mode: "delta",
      baseRevision: 1,
      revision: 2,
    });
    f.connection.close("client-cancelled");
    f.reconnect("grant-BBBBBBBBBBBBBBBBBBBBBB");
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE, epoch: original.epoch, revision: 1 });
    expect(f.readSent()[0]).toMatchObject({ type: "catalog.batch", mode: "delta", baseRevision: 1, revision: 2 });

    f.connection.close("client-cancelled");
    for (let count = 2; count <= 70; count++) f.change([{ id: "one", name: "One", count }]);
    f.reconnect("grant-CCCCCCCCCCCCCCCCCCCCCC");
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE, epoch: original.epoch, revision: 1 });
    expect(f.readSent()[0]).toMatchObject({ type: "catalog.batch", mode: "snapshot", baseRevision: 0, revision: 71 });
  });

  test("uses a new epoch when an idle profile history expires and resets its revision", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([{ id: "one", name: "One" }]);
      f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
      const first = f.readSent()[0];
      f.phoneSend({ v: 1, type: "unsubscribe", profileId: PROFILE });
      f.change([{ id: "one", name: "Changed while unsubscribed" }]);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(f.channel.stats().profiles).toBe(0);
      expect(f.isSubscribed()).toBe(false);

      f.sent.length = 0;
      f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE, epoch: first.epoch, revision: first.revision });
      const restarted = f.readSent()[0];
      expect(restarted).toMatchObject({ mode: "snapshot", revision: 1 });
      expect(restarted.epoch).not.toBe(first.epoch);
      expect(restarted.changes[0].set.name).toBe("Changed while unsubscribed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("expires idle profile history and unsubscribes the source while the system socket stays open", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([{ id: "one", name: "One" }]);
      f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
      f.phoneSend({ v: 1, type: "unsubscribe", profileId: PROFILE });
      expect(f.isSubscribed()).toBe(false);
      expect(f.channel.stats().connections).toBe(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(f.channel.stats()).toMatchObject({ profiles: 0, connections: 1 });
      expect(f.isSubscribed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("shutdown clears the history timer after closing an active subscriber", () => {
    vi.useFakeTimers();
    try {
      const f = fixture([{ id: "one", name: "One" }]);
      f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
      f.channel.stop();
      expect(f.channel.stats()).toMatchObject({ profiles: 0, connections: 0 });
      expect(f.isSubscribed()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a restarted broker changes epoch and requires a snapshot", () => {
    const first = fixture([{ id: "one", name: "One" }]);
    first.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const previous = first.readSent()[0];
    const restarted = fixture([{ id: "one", name: "One" }]);
    restarted.phoneSend({
      v: 1,
      type: "subscribe",
      profileId: PROFILE,
      epoch: previous.epoch,
      revision: previous.revision,
    });
    const snapshot = restarted.readSent()[0];
    expect(snapshot.mode).toBe("snapshot");
    expect(snapshot.epoch).not.toBe(previous.epoch);
  });

  test("closes a connection whose outstanding multipart batch misses its ACK deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([{ id: "one", name: "One" }]);
      f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.close).toHaveBeenCalledWith("timeout");
      expect(f.channel.stats().connections).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a delta carries only four changed rows and omits unchanged fields", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `workspace-${index}`,
      name: `Workspace ${index}`,
      kind: "terminal",
      tabCount: 2,
    }));
    const f = fixture(rows);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const snapshot = f.readSent()[0];
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: snapshot.epoch, revision: snapshot.revision });
    f.sent.length = 0;
    const changed = rows.map((row, index) => (index < 4 ? { ...row, name: `Renamed ${index}` } : row));
    f.change(changed);
    const [delta] = f.readSent();
    expect(delta).toMatchObject({ mode: "delta", baseRevision: 1, revision: 2, part: 0, parts: 1 });
    expect(delta.changes).toHaveLength(4);
    expect(
      delta.changes.every((change) => Object.keys(change.set).join() === "name" && change.unset.length === 0),
    ).toBe(true);
    expect(delta.removed).toEqual([]);
    expect(delta).not.toHaveProperty("order");
  });

  test("preserves false, zero, unset, removals, and changed order in a sparse patch", () => {
    const f = fixture([
      { id: "one", name: "One", enabled: true, count: 4 },
      { id: "two", name: "Two", enabled: false, count: 0, optional: "remove me" },
    ]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const snapshot = f.readSent()[0];
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: snapshot.epoch, revision: snapshot.revision });
    f.sent.length = 0;
    f.change([
      { id: "two", name: "Two", enabled: false, count: 0, optional: "remove me" },
      { id: "one", name: "One", enabled: false, count: 0 },
    ]);
    const [delta] = f.readSent();
    expect(delta.changes).toEqual([{ id: "one", set: { enabled: false, count: 0 }, unset: [] }]);
    expect(delta.removed).toEqual([]);
    expect(delta.order).toEqual(["two", "one"]);

    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: delta.epoch, revision: delta.revision });
    f.sent.length = 0;
    f.change([{ id: "two", name: "Two", enabled: false, count: 0 }]);
    const [deletePatch] = f.readSent();
    expect(deletePatch.changes).toEqual([{ id: "two", set: {}, unset: ["optional"] }]);
    expect(deletePatch.removed).toEqual(["one"]);
    expect(deletePatch.order).toEqual(["two"]);
  });

  test("holds an immutable snapshot baseline while source changes are coalesced", () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({
      id: `workspace-${index}`,
      name: `Workspace ${index}`,
      description: "x".repeat(100),
    }));
    const f = fixture(rows);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const snapshot = f.readSent()[0];
    expect(f.readSent()).toHaveLength(4);
    f.change(rows.map((row, index) => (index === 0 ? { ...row, name: "Changed during snapshot" } : row)));
    for (let part = 0; part < snapshot.parts; part++) {
      f.phoneSend({
        v: 1,
        type: "ack.part",
        profileId: PROFILE,
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        batchId: snapshot.batchId,
        part,
      });
    }
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: snapshot.epoch, revision: snapshot.revision });
    const sent = f.readSent();
    const delta = sent.find((message) => message.type === "catalog.batch" && message.revision === 2);
    if (!delta) throw new Error("expected sparse delta after snapshot commit");
    expect(delta).toMatchObject({ mode: "delta", baseRevision: 1, revision: 2 });
    expect(delta.changes).toEqual([{ id: "workspace-0", set: { name: "Changed during snapshot" }, unset: [] }]);
  });

  test("coalesces source changes behind one outstanding ACK from the acknowledged base", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `workspace-${index}`,
      name: `Workspace ${index}`,
      kind: "terminal",
      tabCount: 2,
    }));
    const f = fixture(rows);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const snapshot = f.readSent()[0];
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: snapshot.epoch, revision: 1 });
    f.sent.length = 0;

    f.change(rows.map((row, index) => (index < 4 ? { ...row, name: `Intermediate ${index}` } : row)));
    const first = f.readSent()[0];
    expect(first.revision).toBe(2);
    f.change(
      rows.map((row, index) =>
        index < 4 ? { ...row, name: `Latest ${index}` } : index === 4 ? { ...row, name: "Latest fifth" } : row,
      ),
    );
    f.change(
      rows.map((row, index) =>
        index < 4 ? { ...row, name: `Final ${index}` } : index === 4 ? { ...row, name: "Final fifth" } : row,
      ),
    );

    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: first.epoch, revision: 2 });
    const coalesced = f.readSent()[1];
    expect(coalesced).toMatchObject({ mode: "delta", baseRevision: 2, revision: 4 });
    expect(coalesced.changes).toHaveLength(5);
    expect(coalesced.changes.map((change) => change.set.name)).toEqual([
      "Final 0",
      "Final 1",
      "Final 2",
      "Final 3",
      "Final fifth",
    ]);
  });

  test("profile authorization errors stay within the request while sequence and authentication failures close the channel", () => {
    const denied = fixture([]);
    denied.phoneSend({ v: 1, type: "subscribe", profileId: "profile-secret" });
    expect(denied.readSent()).toEqual([
      { v: 1, type: "catalog.error", profileId: "profile-secret", code: "permission-denied" },
    ]);
    expect(denied.close).not.toHaveBeenCalled();

    const sequenceGap = fixture([]);
    sequenceGap.connection.receive(2, Buffer.alloc(28));
    expect(sequenceGap.close).toHaveBeenCalledWith("protocol-error");

    const badTag = fixture([]);
    badTag.connection.receive(0, Buffer.alloc(28));
    expect(badTag.close).toHaveBeenCalledWith("protocol-error");
  });

  test("a denied replacement request detaches the current topic and preserves the channel", () => {
    const f = fixture([{ id: "one", name: "One" }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const snapshot = f.readSent()[0];
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: snapshot.epoch, revision: snapshot.revision });
    f.setAllowlist([]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });

    expect(f.readSent().at(-1)).toEqual({
      v: 1,
      type: "catalog.error",
      profileId: PROFILE,
      code: "permission-denied",
    });
    expect(f.close).not.toHaveBeenCalled();

    // This may already be queued by the client before catalog.error arrives.
    f.phoneSend({ v: 1, type: "unsubscribe", profileId: PROFILE });
    expect(f.close).not.toHaveBeenCalled();

    f.setAllowlist([PROFILE]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.batch", mode: "snapshot", revision: 1 });
    expect(f.close).not.toHaveBeenCalled();
  });

  test("a profile permission revocation reports an encrypted topic error and preserves the channel", () => {
    const f = fixture([{ id: "one", name: "One" }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    f.setAllowlist([]);
    f.change([{ id: "one", name: "One changed" }]);

    expect(f.readSent().at(-1)).toEqual({
      v: 1,
      type: "catalog.error",
      profileId: PROFILE,
      code: "permission-denied",
    });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.isSubscribed()).toBe(false);
  });

  test("ignores only ACKs matching the batch rejected by a profile revocation", () => {
    const f = fixture([{ id: "one", name: "One" }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const batch = f.readSent()[0];
    f.setAllowlist([]);
    f.change([{ id: "one", name: "Changed" }]);
    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.error", code: "permission-denied" });

    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: batch.epoch, revision: batch.revision });
    expect(f.close).not.toHaveBeenCalled();
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: batch.epoch, revision: batch.revision + 1 });
    expect(f.close).toHaveBeenCalledWith("protocol-error");
  });

  test("ignores the final ACK after a missing profile rejects its multipart snapshot", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ id: `workspace-${index}`, name: `Workspace ${index}` }));
    const f = fixture(rows);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const first = f.readSent()[0];
    for (let part = 0; part < first.parts; part++) {
      f.phoneSend({
        v: 1,
        type: "ack.part",
        profileId: PROFILE,
        epoch: first.epoch,
        revision: first.revision,
        batchId: first.batchId,
        part,
      });
    }
    f.setAvailable(false);
    f.change(rows);
    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.error", code: "permission-denied" });
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: first.epoch, revision: first.revision });
    expect(f.close).not.toHaveBeenCalled();
  });

  test("ignores a rejected batch part after a same-revision snapshot is resent", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => ({ id: `workspace-${index}`, name: `Workspace ${index}` }));
    const f = fixture(rows);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const rejected = f.readSent()[0];
    f.setAllowlist([]);
    f.change(rows);
    f.setAllowlist([PROFILE]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE, epoch: "expired-epoch", revision: 0 });
    const current = f.readSent().at(-1)!;
    expect(current).toMatchObject({ type: "catalog.batch", revision: rejected.revision });
    expect(current.batchId).not.toBe(rejected.batchId);
    const sentBeforeLateAck = f.readSent().length;

    f.phoneSend({
      v: 1,
      type: "ack.part",
      profileId: PROFILE,
      epoch: rejected.epoch,
      revision: rejected.revision,
      batchId: rejected.batchId,
      part: 0,
    });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.readSent()).toHaveLength(sentBeforeLateAck);
    f.phoneSend({
      v: 1,
      type: "ack.part",
      profileId: PROFILE,
      epoch: current.epoch,
      revision: current.revision,
      batchId: current.batchId,
      part: 0,
    });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.readSent()).toHaveLength(sentBeforeLateAck + 1);
    expect(f.readSent().at(-1)).toMatchObject({ batchId: current.batchId, part: 4 });
  });

  test("processes a new current ACK even when it matches a prior rejected cursor", () => {
    const f = fixture([{ id: "one", name: "One" }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const original = f.readSent()[0];
    f.setAllowlist([]);
    f.change([{ id: "one", name: "One" }]);
    f.setAllowlist([PROFILE]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE, epoch: original.epoch, revision: 0 });
    const resent = f.readSent().at(-1)!;
    expect(resent).toMatchObject({ type: "catalog.batch", epoch: original.epoch, revision: original.revision });
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: resent.epoch, revision: resent.revision });
    expect(f.close).not.toHaveBeenCalled();
    f.change([{ id: "one", name: "Changed after ACK" }]);
    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.batch", baseRevision: 1, revision: 2 });
  });

  test("a too-large source update reports a topic error and ignores only its late ACK", () => {
    const f = fixture([{ id: "one", name: "One" }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });
    const first = f.readSent()[0];
    f.change([{ id: "one", name: "x".repeat(40 * 1024) }]);
    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.error", code: "too-large" });
    f.phoneSend({ v: 1, type: "ack", profileId: PROFILE, epoch: first.epoch, revision: first.revision });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.channel.stats()).toMatchObject({ connections: 1, profiles: 0 });
  });

  test("reports an unrepresentable catalog as a topic error and keeps the system channel open", () => {
    const f = fixture([{ id: "one", name: "x".repeat(40 * 1024) }]);
    f.phoneSend({ v: 1, type: "subscribe", profileId: PROFILE });

    expect(f.readSent().at(-1)).toEqual({
      v: 1,
      type: "catalog.error",
      profileId: PROFILE,
      code: "too-large",
    });
    expect(f.close).not.toHaveBeenCalled();
    expect(f.channel.stats()).toMatchObject({ connections: 1, profiles: 0 });
  });

  test("evicts the oldest inactive history before refusing a seventeenth profile", () => {
    const profileIds = Array.from({ length: 17 }, (_, index) => `profile-${index}`);
    const f = fixture([{ id: "one", name: "One" }], true, profileIds);
    f.setAllowlist(profileIds);
    let oldestEpoch = "";
    for (const profileId of profileIds.slice(0, 16)) {
      f.phoneSend({ v: 1, type: "subscribe", profileId });
      if (profileId === profileIds[0]) oldestEpoch = f.readSent().at(-1)!.epoch;
      f.phoneSend({ v: 1, type: "unsubscribe", profileId });
    }
    expect(f.channel.stats().profiles).toBe(16);
    f.phoneSend({ v: 1, type: "subscribe", profileId: profileIds[16] });

    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.batch", profileId: profileIds[16] });
    expect(f.channel.stats()).toMatchObject({ profiles: 16, connections: 1 });
    expect(f.close).not.toHaveBeenCalled();
    f.phoneSend({ v: 1, type: "unsubscribe", profileId: profileIds[16] });
    f.phoneSend({ v: 1, type: "subscribe", profileId: profileIds[0], epoch: oldestEpoch, revision: 1 });
    expect(f.readSent().at(-1)).toMatchObject({ type: "catalog.batch", mode: "snapshot", revision: 1 });
    expect(f.readSent().at(-1)?.epoch).not.toBe(oldestEpoch);
  });
});
