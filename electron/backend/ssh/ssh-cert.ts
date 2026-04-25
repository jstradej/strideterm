import ssh2 from "ssh2";

const { utils } = ssh2;

export interface ParsedCertificate {
  type: string;
  keyIdString: string;
  principals: string[];
  validAfter: string | null;
  validBefore: string | null;
  serial: string;
  signatureKey: string;
  extensions: string[];
  criticalOptions: string[];
}

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
export function parseCertificate(blob: unknown): Partial<ParsedCertificate> {
  if (!blob || typeof blob !== "string") return {};
  const parsed = utils.parseKey(blob.trim());
  if (parsed instanceof Error) return {};

  // The ssh2 ParsedKey type doesn't expose certificate-specific fields in its
  // public typings, but ssh2 injects them at runtime. Cast through unknown.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = parsed as any;
  const cert = raw.cert || raw;
  if (!cert) return {};

  return {
    type: (cert.type || raw.type || "") as string,
    keyIdString: (cert.keyId || "") as string,
    principals: Array.isArray(cert.principals) ? [...(cert.principals as string[])] : [],
    validAfter: toIsoFromEpoch(cert.validAfter as unknown),
    validBefore: toIsoFromEpoch(cert.validBefore as unknown),
    serial: cert.serial != null ? String(cert.serial as unknown) : "",
    signatureKey: (cert.signatureKey?.fingerprint?.("sha256") as string | undefined) || "",
    extensions: cert.extensions ? Object.keys(cert.extensions as Record<string, unknown>) : [],
    criticalOptions: cert.critOptions ? Object.keys(cert.critOptions as Record<string, unknown>) : [],
  };
}

// ssh2 exposes certificate timestamps as seconds-since-epoch numbers or
// BigInt (UINT64_MAX for "valid forever"). Convert to ISO; forever stays null.
function toIsoFromEpoch(value: unknown): string | null {
  if (value == null) return null;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // ssh2 uses UINT64_MAX to denote "no expiry". Cap reasonable dates.
  if (n > 253402300799) return null;
  return new Date(n * 1000).toISOString();
}
