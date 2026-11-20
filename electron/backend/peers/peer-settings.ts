import {
  PEER_DEFAULT_PORT,
  type PeerDeviceRecord,
  type PeerHostRecord,
  type PeerIntegrationSettings,
} from "../../shared/peers.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const ADDRESS_PATTERN = /^[A-Za-z0-9.:_-]{1,253}$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isCanonicalKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeDevices(raw: unknown): PeerDeviceRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PeerDeviceRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = record(item);
    if (!entry || typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || seen.has(entry.id)) continue;
    if (!isCanonicalKey(entry.publicKey)) continue;
    seen.add(entry.id);
    out.push({
      id: entry.id,
      name: text(entry.name, 64) || "Desktop",
      platform: text(entry.platform, 16),
      publicKey: entry.publicKey,
      pairedAt: count(entry.pairedAt),
      lastSeenAt: count(entry.lastSeenAt),
      lastAddress: text(entry.lastAddress, 64),
    });
  }
  return out;
}

function normalizeHosts(raw: unknown): PeerHostRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PeerHostRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = record(item);
    if (!entry || typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || seen.has(entry.id)) continue;
    if (!isCanonicalKey(entry.hostPublicKey)) continue;
    if (typeof entry.address !== "string" || !ADDRESS_PATTERN.test(entry.address) || !validPort(entry.port)) continue;
    seen.add(entry.id);
    out.push({
      id: entry.id,
      label: text(entry.label, 64) || entry.address.slice(0, 64),
      address: entry.address,
      port: entry.port,
      hostPublicKey: entry.hostPublicKey,
      pairedAt: count(entry.pairedAt),
    });
  }
  return out;
}

/** Never mints an `instanceId`: normalizeState runs after every mutation and must not invent values. */
export function normalizePeerSettings(raw: unknown): PeerIntegrationSettings {
  const source = record(raw) ?? {};
  const hosting = record(source.hosting) ?? {};
  return {
    instanceId: typeof source.instanceId === "string" && ID_PATTERN.test(source.instanceId) ? source.instanceId : "",
    hosting: {
      enabled: hosting.enabled === true,
      port: validPort(hosting.port) ? hosting.port : PEER_DEFAULT_PORT,
    },
    devices: normalizeDevices(source.devices),
    hosts: normalizeHosts(source.hosts),
  };
}
