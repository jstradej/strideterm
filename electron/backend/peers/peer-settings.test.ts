import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { PEER_DEFAULT_PORT, defaultPeerSettings } from "../../shared/peers.js";
import { normalizePeerSettings } from "./peer-settings.js";

const key = () => randomBytes(32).toString("base64");

const device = (over: Record<string, unknown> = {}) => ({
  id: "device-0001",
  name: "Laptop",
  platform: "win32",
  publicKey: key(),
  pairedAt: 1,
  lastSeenAt: 2,
  lastAddress: "192.168.1.5",
  ...over,
});

const host = (over: Record<string, unknown> = {}) => ({
  id: "host-0001",
  label: "Office",
  address: "192.168.1.9",
  port: 43124,
  hostPublicKey: key(),
  pairedAt: 1,
  ...over,
});

describe("normalizePeerSettings", () => {
  test.each([undefined, null, "x", 5, []])("garbage %j gives defaults", (raw) => {
    expect(normalizePeerSettings(raw)).toEqual(defaultPeerSettings());
  });

  test("instanceId is kept only when valid and never generated", () => {
    expect(normalizePeerSettings({ instanceId: "abcd1234" }).instanceId).toBe("abcd1234");
    expect(normalizePeerSettings({ instanceId: "short" }).instanceId).toBe("");
    expect(normalizePeerSettings({ instanceId: "bad id with spaces" }).instanceId).toBe("");
    expect(normalizePeerSettings({ instanceId: 12345678 }).instanceId).toBe("");
    expect(normalizePeerSettings({}).instanceId).toBe("");
  });

  test("hosting enabled is strictly true and the port is a valid integer", () => {
    expect(normalizePeerSettings({ hosting: { enabled: "true" } }).hosting.enabled).toBe(false);
    expect(normalizePeerSettings({ hosting: { enabled: true } }).hosting.enabled).toBe(true);
    for (const port of [0, 65536, 1.5, "80", NaN, -1]) {
      expect(normalizePeerSettings({ hosting: { port } }).hosting.port).toBe(PEER_DEFAULT_PORT);
    }
    expect(normalizePeerSettings({ hosting: { port: 8080 } }).hosting.port).toBe(8080);
  });

  test("devices: invalid records are dropped, fields cleaned, duplicates removed", () => {
    const good = device();
    const out = normalizePeerSettings({
      devices: [
        good,
        device({ id: "device-0001", name: "Dup" }),
        device({ id: "bad" }),
        device({ id: "device-0002", publicKey: "abc" }),
        device({ id: "device-0003", publicKey: randomBytes(31).toString("base64") }),
        device({ id: "device-0004", publicKey: good.publicKey.slice(0, 43) }),
        null,
        device({
          id: "device-0005",
          name: "   ",
          platform: "x".repeat(40),
          pairedAt: -3,
          lastSeenAt: "nope",
          lastAddress: "a".repeat(100),
        }),
        device({ id: "device-0006", name: ` ${"n".repeat(100)} ` }),
      ],
    }).devices;
    expect(out.map((entry) => entry.id)).toEqual(["device-0001", "device-0005", "device-0006"]);
    expect(out[0]!.name).toBe("Laptop");
    expect(out[1]).toMatchObject({
      name: "Desktop",
      platform: "x".repeat(16),
      pairedAt: 0,
      lastSeenAt: 0,
      lastAddress: "a".repeat(64),
    });
    expect(out[2]!.name).toBe("n".repeat(64));
  });

  test("hosts: invalid records are dropped, label falls back to the address, duplicates removed", () => {
    const out = normalizePeerSettings({
      hosts: [
        host(),
        host({ label: "Dup" }),
        host({ id: "host-0002", label: "  ", address: "nas.local" }),
        host({ id: "host-0003", address: "bad address" }),
        host({ id: "host-0004", address: "" }),
        host({ id: "host-0005", port: 0 }),
        host({ id: "host-0006", port: 70000 }),
        host({ id: "host-0007", port: "43124" }),
        host({ id: "host-0008", hostPublicKey: "abc" }),
        host({ id: "x" }),
        host({ id: "host-0009", label: "L".repeat(80) }),
      ],
    }).hosts;
    expect(out.map((entry) => entry.id)).toEqual(["host-0001", "host-0002", "host-0009"]);
    expect(out[0]!.label).toBe("Office");
    expect(out[1]!.label).toBe("nas.local");
    expect(out[2]!.label).toBe("L".repeat(64));
  });

  test("is idempotent", () => {
    const once = normalizePeerSettings({
      instanceId: "abcd1234",
      hosting: { enabled: true, port: 9000 },
      devices: [device(), device({ id: "device-0002", name: "  " })],
      hosts: [host(), host({ id: "host-0002", label: "" })],
    });
    expect(normalizePeerSettings(once)).toEqual(once);
  });
});
