import {
  checkRegistryUrl,
  isRegistryAuthKind,
  isRegistryKind,
  isRegistryMode,
  type RegistryConnection,
} from "../../shared/registry.js";

const MAX_CONNECTIONS = 50;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Persisted registry connections, cleaned. A connection whose URL the host would not send a credential
 * to (not https, userinfo in the URL) is dropped, never repaired.
 */
export function normalizeRegistryConnections(raw: unknown): RegistryConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: RegistryConnection[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const id = text(entry.id, 128);
    const url = checkRegistryUrl(entry.url);
    if (!id || seen.has(id) || !isRegistryKind(entry.kind) || !url.ok) continue;
    const authKind = isRegistryAuthKind(entry.authKind) ? entry.authKind : "none";
    seen.add(id);
    out.push({
      id,
      profileId: text(entry.profileId, 128) || "default",
      label: text(entry.label, 120) || id,
      kind: entry.kind,
      url: url.url,
      mode: isRegistryMode(entry.mode) ? entry.mode : "mirror",
      authKind,
      username: authKind === "basic" ? text(entry.username, 256) : "",
      npmScope:
        entry.kind === "npm" && /^@[a-z0-9][a-z0-9._-]*$/iu.test(text(entry.npmScope, 214))
          ? text(entry.npmScope, 214)
          : "",
    });
    if (out.length >= MAX_CONNECTIONS) break;
  }
  return out;
}

export interface RegistrySaveInput {
  id: string;
  label: string;
  kind: string;
  url: string;
  mode: string;
  authKind: string;
  username: string;
  npmScope: string;
}

/** Validates one connection a user typed. Throws a message fit for the form. */
export function validateRegistryInput(input: RegistrySaveInput, profileId: string): RegistryConnection {
  const url = checkRegistryUrl(input.url);
  if (!url.ok) throw new Error(url.reason);
  if (!isRegistryKind(input.kind)) throw new Error("Choose a registry type.");
  const authKind = isRegistryAuthKind(input.authKind) ? input.authKind : "none";
  if (authKind === "basic" && !input.username.trim()) throw new Error("Enter the account name for basic sign-in.");
  const normalized = normalizeRegistryConnections([{ ...input, url: url.url, profileId, authKind }]);
  if (!normalized.length) throw new Error("The registry connection is not valid.");
  const connection = normalized[0];
  if (connection.kind === "npm") {
    if (input.npmScope.trim() && !connection.npmScope) throw new Error("The npm scope must look like @acme.");
    // npm asks one registry per package: next to the default it can only serve one scope, so without one nothing would use it.
    if (connection.mode === "additional" && !connection.npmScope) {
      throw new Error(
        "An additional npm registry needs the scope it serves, for example @acme. Use Mirror to replace the default registry.",
      );
    }
  }
  return connection;
}
