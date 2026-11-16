// Metadata about the credentials strIDEterm stores for external systems. Shared by runtime and renderer.
// It never carries a secret value: a row says what is stored and who owns it, nothing more.

export const CREDENTIAL_SYSTEMS = ["azure", "github", "jira", "registry", "ssh", "telegram", "connection"] as const;
export type CredentialSystem = (typeof CREDENTIAL_SYSTEMS)[number];

export const CREDENTIAL_KINDS = [
  "personal-access-token",
  "api-token",
  "gateway-key",
  "gateway-key-passphrase",
  "registry-secret",
  "ssh-password",
  "ssh-private-key",
  "ssh-key-passphrase",
  "ssh-certificate",
  "bot-token",
  "connection-token",
  "temporary",
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const CREDENTIAL_SYSTEM_LABELS: Record<CredentialSystem, string> = {
  azure: "Azure DevOps",
  github: "GitHub",
  jira: "Jira",
  registry: "Package registries",
  ssh: "SSH",
  telegram: "Telegram",
  connection: "Removed connections",
};

export const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  "personal-access-token": "Personal access token",
  "api-token": "API token",
  "gateway-key": "API gateway key",
  "gateway-key-passphrase": "API gateway certificate password",
  "registry-secret": "Registry password or token",
  "ssh-password": "Password",
  "ssh-private-key": "Private key",
  "ssh-key-passphrase": "Key passphrase",
  "ssh-certificate": "Certificate",
  "bot-token": "Bot token",
  "connection-token": "Connection token",
  temporary: "Left over from a connection check",
};

export interface CredentialEntry {
  /** The credential-store reference. It names the entry; the stored value never leaves the runtime. */
  ref: string;
  system: CredentialSystem;
  kind: CredentialKind;
  ownerId: string;
  ownerLabel: string;
  profileId: string;
  profileName: string;
  /** No connection, host or key references this secret any more. */
  orphan: boolean;
  /** Where the provider lets the user manage the token, only when the address is certain. */
  manageUrl?: string;
}

export interface CredentialRow extends CredentialEntry {
  storage: "encrypted" | "plain";
}

export interface CredentialOverview {
  rows: CredentialRow[];
  /** Whether the OS keychain is available for new secrets; a row's own `storage` is what is on disk. */
  encryptionAvailable: boolean;
}

export interface CredentialRemoveResult {
  removed: number;
}
