// A "Registry" connection: a private package registry (Maven, npm, pip, Gradle) the host reaches
// with the stored sign-in, so the sandbox never holds a token. Shared by runtime and renderer.

export const REGISTRY_KINDS = ["maven", "npm", "pip", "gradle"] as const;
export type RegistryKind = (typeof REGISTRY_KINDS)[number];

export const REGISTRY_AUTH_KINDS = ["none", "basic", "bearer"] as const;
export type RegistryAuthKind = (typeof REGISTRY_AUTH_KINDS)[number];

/** `mirror` replaces the tool's default registry; `additional` is searched next to it. */
export const REGISTRY_MODES = ["mirror", "additional"] as const;
export type RegistryMode = (typeof REGISTRY_MODES)[number];

export interface RegistryConnection {
  id: string;
  profileId: string;
  label: string;
  kind: RegistryKind;
  /** Base URL of the registry (https; plain http only for a loopback or private host is NOT accepted). */
  url: string;
  mode: RegistryMode;
  authKind: RegistryAuthKind;
  /** Account name for `basic`; empty otherwise. */
  username: string;
  /** npm only: serve just this scope (`@acme`) from the registry; empty means the whole registry. */
  npmScope: string;
}

/** Credential-store reference for a registry's secret. Always derived from the id, never from a request. */
export function registrySecretRef(connectionId: string): string {
  return `registry:${connectionId}:secret`;
}

export const REGISTRY_TOKEN_ADVICE =
  "Use the narrowest token the registry offers: read-only, limited to the repositories the build needs.";

/** One window of aggregated registry use that the audit log records (workspace, connection, window). */
export const REGISTRY_AUDIT_WINDOW_MS = 5 * 60 * 1000;

export function isRegistryKind(value: unknown): value is RegistryKind {
  return typeof value === "string" && (REGISTRY_KINDS as readonly string[]).includes(value);
}

export function isRegistryAuthKind(value: unknown): value is RegistryAuthKind {
  return typeof value === "string" && (REGISTRY_AUTH_KINDS as readonly string[]).includes(value);
}

export function isRegistryMode(value: unknown): value is RegistryMode {
  return typeof value === "string" && (REGISTRY_MODES as readonly string[]).includes(value);
}

export type RegistryUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** A registry URL the host will send a stored credential to: https, no userinfo, no query or fragment. */
export function checkRegistryUrl(raw: unknown): RegistryUrlCheck {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "Enter the registry URL." };
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "The registry URL is not valid." };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "The registry URL must use https." };
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Do not put credentials in the URL; they are stored separately." };
  }
  if (parsed.search || parsed.hash) return { ok: false, reason: "The registry URL must not have a query or fragment." };
  const path = parsed.pathname.replace(/\/+$/u, "");
  return { ok: true, url: `${parsed.origin}${path}` };
}

export interface RegistrySavePayload {
  id: string;
  label: string;
  kind: RegistryKind;
  url: string;
  mode: RegistryMode;
  authKind: RegistryAuthKind;
  username: string;
  npmScope: string;
  /** The token or password to store; omitted to keep the stored one. Never sent back. */
  secret?: string;
}

export interface RegistryTestResult {
  ok: boolean;
  /** HTTP status of the probe, 0 when the registry could not be reached. */
  status: number;
  message: string;
}
