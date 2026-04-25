/// <reference types="node" />
import crypto from "node:crypto";

interface HostLike {
  host: string;
  port?: number;
  hostKeyPolicy?: string;
}

interface KnownHostEntry {
  fingerprint: string;
  keyType: string;
  addedAt: string;
  firstSeenFrom?: string;
}

interface AppState {
  ssh?: {
    hosts?: unknown[];
    keys?: unknown[];
    certificates?: unknown[];
    knownHosts?: Record<string, KnownHostEntry>;
    settings?: Record<string, unknown>;
  };
}

export interface Store {
  getState(): AppState;
  mutate(mutator: (state: AppState) => void): Promise<unknown>;
}

export type HostKeyVerdict =
  | { ok: true; first: true; fingerprint: string; keyType: string }
  | { ok: true; fingerprint: string; keyType: string }
  | { ok: false; mismatch: false; fingerprint: string; keyType: string; previous: null }
  | { ok: false; mismatch: true; fingerprint: string; keyType: string; previous: { fingerprint: string; keyType: string; addedAt: string } };

// SHA-256 base64 without padding — matches `ssh-keygen -lf`.
function fingerprintOf(keyBuf: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(keyBuf).digest("base64").replace(/=+$/, "");
}

function hostKey(host: HostLike): string {
  const port = host.port || 22;
  return `${host.host}:${port}`;
}

/**
 * Inspect a presented host key against the known-hosts store.
 * Returns a structured verdict:
 *   { ok: true }                       — already trusted, proceed
 *   { ok: false, mismatch: true, … }   — known host but fingerprint changed
 *   { ok: false, mismatch: false, … }  — new host (caller decides by policy)
 * Does NOT mutate the store; recording is caller's responsibility after the
 * connection is confirmed.
 */
export function verifyHostKey(store: Store, host: HostLike, { key }: { key: Buffer | { type?: string } }): HostKeyVerdict {
  const state = store.getState();
  const known = state.ssh?.knownHosts?.[hostKey(host)] || null;
  const keyBuf = Buffer.isBuffer(key) ? key : null;
  const incomingFp = keyBuf ? fingerprintOf(keyBuf) : "";
  const keyType = keyBuf && keyBuf.length >= 4 ? inferKeyType(keyBuf) : (!Buffer.isBuffer(key) && key && key.type) || "";

  if (!known) {
    // Brand-new host.
    if (host.hostKeyPolicy === "strict") {
      return { ok: false, mismatch: false, fingerprint: incomingFp, keyType, previous: null };
    }
    // accept-new / warn: accept but let caller persist on successful connect.
    return { ok: true, first: true, fingerprint: incomingFp, keyType };
  }

  if (known.fingerprint !== incomingFp) {
    return {
      ok: false,
      mismatch: true,
      fingerprint: incomingFp,
      keyType,
      previous: { fingerprint: known.fingerprint, keyType: known.keyType, addedAt: known.addedAt },
    };
  }

  return { ok: true, fingerprint: incomingFp, keyType };
}

/**
 * Persist (or overwrite) a fingerprint for a host after a successful connect.
 */
export async function recordHostKey(store: Store, host: HostLike, { fingerprint, keyType }: { fingerprint?: string; keyType?: string }): Promise<void> {
  if (!fingerprint) return;
  await store.mutate((state) => {
    if (!state.ssh) state.ssh = { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} };
    if (!state.ssh.knownHosts) state.ssh.knownHosts = {};
    state.ssh.knownHosts[hostKey(host)] = {
      fingerprint,
      keyType: keyType || "",
      addedAt: new Date().toISOString(),
      firstSeenFrom: "tofu",
    };
  });
}

// SSH key blobs start with a length-prefixed algorithm string.
function inferKeyType(buf: Buffer): string {
  try {
    const nameLen = buf.readUInt32BE(0);
    if (nameLen <= 0 || nameLen > 64 || nameLen + 4 > buf.length) return "";
    return buf.slice(4, 4 + nameLen).toString("utf8");
  } catch {
    return "";
  }
}
