import crypto from "node:crypto";

// SHA-256 base64 without padding — matches `ssh-keygen -lf`.
function fingerprintOf(keyBuf) {
  return "SHA256:" + crypto.createHash("sha256").update(keyBuf).digest("base64").replace(/=+$/, "");
}

function hostKey(host) {
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
export function verifyHostKey(store, host, { key }) {
  const state = store.getState();
  const known = state.ssh?.knownHosts?.[hostKey(host)] || null;
  const incomingFp = fingerprintOf(key);
  const keyType = Buffer.isBuffer(key) && key.length >= 4 ? inferKeyType(key) : (key && key.type) || "";

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
export async function recordHostKey(store, host, { fingerprint, keyType }) {
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
function inferKeyType(buf) {
  try {
    const nameLen = buf.readUInt32BE(0);
    if (nameLen <= 0 || nameLen > 64 || nameLen + 4 > buf.length) return "";
    return buf.slice(4, 4 + nameLen).toString("utf8");
  } catch {
    return "";
  }
}
