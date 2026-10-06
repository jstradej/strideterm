/**
 * The inbound-silence watchdog (production 2026-10-05), driven with fake timers against a scripted
 * socket: nothing real is listening, so the only clock in play is the one the test advances.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRelayConnector, type RelayConnector } from "./mobile-relay-connector.js";
import {
  encodeRelayFrame,
  RELAY_CONNECTOR_HEARTBEAT_MS,
  RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  type RelayFrameHeader,
} from "./mobile-relay-protocol.js";
import type { RelayInstallationIdentity } from "./mobile-relay-identity.js";

class ScriptedSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  terminated = false;
  send(): void {}
  close(): void {}
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close", 1006);
  }
  receive(header: RelayFrameHeader): void {
    this.emit("message", Buffer.from(encodeRelayFrame(header)), true);
  }
}

const SESSION = "relay-session-watchdog-0001";
const heartbeatEcho: RelayFrameHeader = {
  v: RELAY_PROTOCOL_VERSION,
  t: "conn.heartbeat",
  src: "relay",
  dst: "connector",
  s: SESSION,
};
const otherFrame: RelayFrameHeader = {
  v: RELAY_PROTOCOL_VERSION,
  t: "flow.credit",
  src: "relay",
  dst: "connector",
  s: SESSION,
  id: "no-such-stream",
  w: 1,
};

let sockets: ScriptedSocket[];
let socketOptions: { headers: Record<string, string> } | undefined;
let connector: RelayConnector;

async function ready(): Promise<ScriptedSocket> {
  await vi.advanceTimersByTimeAsync(0);
  const socket = sockets.at(-1)!;
  socket.receive({ v: RELAY_PROTOCOL_VERSION, t: "conn.ready", src: "relay", dst: "connector", s: SESSION });
  expect(connector.state()).toBe("ready");
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  socketOptions = undefined;
  connector = createRelayConnector({
    relayOrigin: "http://127.0.0.1:1",
    identity: {} as RelayInstallationIdentity,
    internalOrigin: { host: "127.0.0.1", port: 1, guardToken: "guard" },
    getGrant: async () => "grant",
    reconnectDelayMs: () => 1000,
    createSocket: (_url, _protocols, options) => {
      socketOptions = options;
      const socket = new ScriptedSocket();
      sockets.push(socket);
      return socket as never;
    },
  });
  connector.start();
});

afterEach(async () => {
  await connector.stop();
  vi.useRealTimers();
});

describe("inbound-silence watchdog", () => {
  test("a relay that never echoes heartbeats is never terminated, however long it is quiet", async () => {
    const socket = await ready();
    await vi.advanceTimersByTimeAsync(10 * RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS);
    expect(socket.terminated).toBe(false);
    expect(connector.state()).toBe("ready");
  });

  test("once the relay has echoed, silence for the full timeout terminates the socket and reconnects", async () => {
    const socket = await ready();
    await vi.advanceTimersByTimeAsync(RELAY_CONNECTOR_HEARTBEAT_MS);
    socket.receive(heartbeatEcho);

    // The check runs on the heartbeat tick: 59 s of silence is still inside the deadline.
    await vi.advanceTimersByTimeAsync(RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS - 1000);
    expect(socket.terminated).toBe(false);

    // The tick at 80 s sees 60 s of silence. Stop short of the 1 s reconnect delay so the new socket's
    // own handshake timer cannot overwrite lastError.
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.terminated).toBe(true);
    expect(connector.stats().lastError).toBe("relay-inbound-silence");
    expect(connector.stats().reconnects).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  test("any inbound frame, not only a heartbeat, resets the deadline", async () => {
    const socket = await ready();
    await vi.advanceTimersByTimeAsync(RELAY_CONNECTOR_HEARTBEAT_MS);
    socket.receive(heartbeatEcho);
    await vi.advanceTimersByTimeAsync(50_000);
    socket.receive(otherFrame);

    // 40 s after the last frame the old (heartbeat-based) deadline has long passed; the new one has not.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(socket.terminated).toBe(false);

    await vi.advanceTimersByTimeAsync(RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS);
    expect(socket.terminated).toBe(true);
  });

  test("the echo flag does not survive a reconnect: the next relay is detected afresh", async () => {
    const first = await ready();
    first.receive(heartbeatEcho);
    first.emit("close", 1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = await ready();
    await vi.advanceTimersByTimeAsync(10 * RELAY_CONNECTOR_HEARTBEAT_TIMEOUT_MS);
    expect(second.terminated).toBe(false);
  });
});

test("advertises system-channel support only when the handler is wired", async () => {
  await vi.advanceTimersByTimeAsync(0);
  expect(socketOptions).toBeUndefined();
  await connector.stop();

  socketOptions = undefined;
  connector = createRelayConnector({
    relayOrigin: "http://127.0.0.1:1",
    identity: {} as RelayInstallationIdentity,
    internalOrigin: { host: "127.0.0.1", port: 1, guardToken: "guard" },
    getGrant: async () => "grant",
    reconnectDelayMs: () => 1000,
    systemChannel: { open: () => null },
    createSocket: (_url, _protocols, options) => {
      socketOptions = options;
      const socket = new ScriptedSocket();
      sockets.push(socket);
      return socket as never;
    },
  });
  connector.start();
  await vi.advanceTimersByTimeAsync(0);
  expect((socketOptions as unknown as { headers: Record<string, string> }).headers).toEqual({
    "X-Strideterm-System-Channel": "1",
  });
  await connector.stop();
});
