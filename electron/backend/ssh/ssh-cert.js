import ssh2 from "ssh2";

const { utils } = ssh2;

/**
 * Parse an OpenSSH certificate blob (the content of `*-cert.pub`) into the
 * metadata we surface in the UI. ssh2.utils.parseKey returns an object with
 * algorithm-specific fields; for certificates it exposes the fields inline.
 *
 * Returns a plain object suitable for persisting alongside the cert:
 *   { keyIdString, principals, validAfter, validBefore, signatureKey,
 *     extensions, criticalOptions, serial, type }
 *
 * When parsing fails we don't throw — the UI can still show the raw blob,
 * the user just won't get decoded metadata. We log to stderr for debugging.
 */
export function parseCertificate(blob) {
  if (!blob || typeof blob !== "string") return {};
  const parsed = utils.parseKey(blob.trim());
  if (parsed instanceof Error) return {};

  const cert = parsed.cert || parsed;
  if (!cert) return {};

  return {
    type: cert.type || parsed.type || "",
    keyIdString: cert.keyId || "",
    principals: Array.isArray(cert.principals) ? [...cert.principals] : [],
    validAfter: toIsoFromEpoch(cert.validAfter),
    validBefore: toIsoFromEpoch(cert.validBefore),
    serial: cert.serial != null ? String(cert.serial) : "",
    signatureKey: cert.signatureKey?.fingerprint?.("sha256") || "",
    extensions: cert.extensions ? Object.keys(cert.extensions) : [],
    criticalOptions: cert.critOptions ? Object.keys(cert.critOptions) : [],
  };
}

// ssh2 exposes certificate timestamps as seconds-since-epoch numbers or
// BigInt (UINT64_MAX for "valid forever"). Convert to ISO; forever stays null.
function toIsoFromEpoch(value) {
  if (value == null) return null;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // ssh2 uses UINT64_MAX to denote "no expiry". Cap reasonable dates.
  if (n > 253402300799) return null;
  return new Date(n * 1000).toISOString();
}
