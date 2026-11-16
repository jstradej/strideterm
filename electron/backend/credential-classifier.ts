import { connectionSecretRef } from "./shared/connection-secret.js";
import type { CredentialEntry, CredentialKind, CredentialSystem } from "../shared/credential-overview.js";
import { CREDENTIAL_SYSTEMS } from "../shared/credential-overview.js";

interface Owned {
  id: string;
  label?: string;
  profileId?: string;
}

interface SshAuthLike {
  keyRef?: string;
  passphraseRef?: string;
  passwordRef?: string;
  certRef?: string;
}

interface SshInlineHolder {
  launch?: { sshInline?: { auth?: SshAuthLike } } | null;
  sftp?: { sshInline?: { auth?: SshAuthLike } } | null;
}

/** The slice of the app state that says who owns a stored secret. */
export interface CredentialOwnerState {
  profiles?: Array<{ id: string; name: string }>;
  workspaces?: Array<{ panels?: SshInlineHolder[] }>;
  ssh?: {
    hosts?: Array<{ id: string; name?: string; host?: string; auth?: SshAuthLike }>;
    keys?: Array<{ id: string; label?: string }>;
    certificates?: Array<{ id: string; keyIdString?: string }>;
  };
  settings?: {
    integrations?: {
      azureDevops?: { connections?: Array<Owned & { orgUrl?: string; tokenRef?: string }> };
      github?: { connections?: Array<Owned & { hostUrl?: string; tokenRef?: string }> };
      telegram?: { connections?: Array<Owned & { botTokenRef?: string }> };
      jira?: {
        connections?: Array<
          Owned & { deployment?: string; auth?: { kind?: string; secretRef?: string; passphraseRef?: string } }
        >;
      };
      registry?: { connections?: Array<Owned & { authKind?: string }> };
    };
  };
}

const SHARED_PROFILE_NAME = "All profiles";
const JIRA_PERMANENT = /^jira:(.+):(pat|api-token|apim-key|apim-passphrase)$/u;
const JIRA_TEMPORARY =
  /^jira:(.+):(?:verify|verify-key|verify-pass|test-api-token|test-key|test-pass|test-pat):[0-9a-f-]{36}$/u;
const REGISTRY_REF = /^registry:(.+):secret$/u;
const SSH_KEY_REF = /^ssh:key:.+$/u;
const SSH_PASSPHRASE_REF = /^ssh:passphrase:(.+)$/u;
const SSH_CERT_REF = /^ssh:cert:.+$/u;
const SSH_PASSWORD_REF = /^ssh:password:.+$/u;

const JIRA_KIND: Record<string, CredentialKind> = {
  pat: "personal-access-token",
  "api-token": "api-token",
  "apim-key": "gateway-key",
  "apim-passphrase": "gateway-key-passphrase",
};

function azureTokenPage(orgUrl: string | undefined): string | undefined {
  try {
    const url = new URL(orgUrl || "");
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "dev.azure.com") return undefined;
    const org = url.pathname.split("/").find(Boolean);
    return org
      ? `https://dev.azure.com/${encodeURIComponent(decodeURIComponent(org))}/_usersSettings/tokens`
      : undefined;
  } catch {
    return undefined;
  }
}

function githubTokenPage(hostUrl: string | undefined): string | undefined {
  try {
    const url = new URL(hostUrl || "");
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"
      ? "https://github.com/settings/tokens"
      : undefined;
  } catch {
    return undefined;
  }
}

const ATLASSIAN_TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";

/**
 * Classifies credential-store references of external systems against the app state. An ALLOWLIST: a reference
 * whose shape is not listed here (Mobile keys, the remote-access token, the account, anything unknown) is
 * absent from the result, so it can neither be shown nor removed through the overview.
 */
export function classifyCredentials(state: CredentialOwnerState, refs: readonly string[]): CredentialEntry[] {
  const profileName = (profileId: string | undefined): { profileId: string; profileName: string } => {
    const id = profileId || "default";
    return { profileId: id, profileName: state.profiles?.find((profile) => profile.id === id)?.name || id };
  };
  const integrations = state.settings?.integrations ?? {};
  const azure = integrations.azureDevops?.connections ?? [];
  const github = integrations.github?.connections ?? [];
  const telegram = integrations.telegram?.connections ?? [];
  const jira = integrations.jira?.connections ?? [];
  const registry = integrations.registry?.connections ?? [];
  const ssh = state.ssh ?? {};

  const sshHolders = new Map<string, { id: string; label: string }>();
  const addSshAuth = (auth: SshAuthLike | undefined, holder: { id: string; label: string }) => {
    for (const ref of [auth?.keyRef, auth?.passphraseRef, auth?.passwordRef, auth?.certRef]) {
      if (ref && !sshHolders.has(ref)) sshHolders.set(ref, holder);
    }
  };
  for (const host of ssh.hosts ?? []) addSshAuth(host.auth, { id: host.id, label: host.name || host.host || host.id });
  for (const workspace of state.workspaces ?? []) {
    for (const panel of workspace.panels ?? []) {
      const holder = { id: "", label: "An SSH tab" };
      addSshAuth(panel.launch?.sshInline?.auth, holder);
      addSshAuth(panel.sftp?.sshInline?.auth, holder);
    }
  }

  const entries: CredentialEntry[] = [];
  const add = (
    ref: string,
    system: CredentialSystem,
    kind: CredentialKind,
    owner: { id: string; label: string; profile: { profileId: string; profileName: string } } | null,
    manageUrl?: string,
  ) => {
    entries.push({
      ref,
      system,
      kind,
      ownerId: owner?.id ?? "",
      ownerLabel: owner?.label ?? "",
      profileId: owner?.profile.profileId ?? "",
      profileName: owner?.profile.profileName ?? "",
      orphan: owner === null,
      ...(owner && manageUrl ? { manageUrl } : {}),
    });
  };
  const sharedProfile = { profileId: "", profileName: SHARED_PROFILE_NAME };

  for (const ref of new Set(refs)) {
    if (ref.startsWith("cred:")) {
      const ownRef = (connection: Owned & { tokenRef?: string; botTokenRef?: string }, stored?: string) =>
        stored || connectionSecretRef(connection.id);
      const ado = azure.find((connection) => ownRef(connection, connection.tokenRef) === ref);
      const gh = github.find((connection) => ownRef(connection, connection.tokenRef) === ref);
      const tg = telegram.find((connection) => ownRef(connection, connection.botTokenRef) === ref);
      if (ado) {
        add(
          ref,
          "azure",
          "personal-access-token",
          { id: ado.id, label: ado.label || ado.id, profile: profileName(ado.profileId) },
          azureTokenPage(ado.orgUrl),
        );
      } else if (gh) {
        add(
          ref,
          "github",
          "personal-access-token",
          { id: gh.id, label: gh.label || gh.id, profile: profileName(gh.profileId) },
          githubTokenPage(gh.hostUrl),
        );
      } else if (tg) {
        add(ref, "telegram", "bot-token", {
          id: tg.id,
          label: tg.label || tg.id,
          profile: tg.profileId ? profileName(tg.profileId) : sharedProfile,
        });
      } else {
        add(ref, "connection", "connection-token", null);
      }
      continue;
    }

    const jiraTemporary = JIRA_TEMPORARY.exec(ref);
    if (jiraTemporary) {
      add(ref, "jira", "temporary", null);
      continue;
    }
    const jiraMatch = JIRA_PERMANENT.exec(ref);
    if (jiraMatch) {
      const connection = jira.find((item) => item.id === jiraMatch[1]);
      const used = connection?.auth?.secretRef === ref || connection?.auth?.passphraseRef === ref;
      const kind = JIRA_KIND[jiraMatch[2]];
      add(
        ref,
        "jira",
        kind,
        connection && used
          ? { id: connection.id, label: connection.label || connection.id, profile: profileName(connection.profileId) }
          : null,
        connection && used && kind === "api-token" && connection.auth?.kind === "cloud-api-token"
          ? ATLASSIAN_TOKEN_PAGE
          : undefined,
      );
      continue;
    }

    const registryMatch = REGISTRY_REF.exec(ref);
    if (registryMatch) {
      const connection = registry.find((item) => item.id === registryMatch[1]);
      add(
        ref,
        "registry",
        "registry-secret",
        connection && connection.authKind !== "none"
          ? { id: connection.id, label: connection.label || connection.id, profile: profileName(connection.profileId) }
          : null,
      );
      continue;
    }

    if (SSH_KEY_REF.test(ref)) {
      const key = ssh.keys?.find((item) => item.id === ref);
      const holder = sshHolders.get(ref);
      add(
        ref,
        "ssh",
        "ssh-private-key",
        key
          ? { id: key.id, label: key.label || key.id, profile: sharedProfile }
          : holder
            ? { ...holder, profile: sharedProfile }
            : null,
      );
      continue;
    }
    const passphrase = SSH_PASSPHRASE_REF.exec(ref);
    if (passphrase) {
      const key = ssh.keys?.find((item) => item.id === passphrase[1]);
      const holder = sshHolders.get(ref);
      add(
        ref,
        "ssh",
        "ssh-key-passphrase",
        key
          ? { id: key.id, label: key.label || key.id, profile: sharedProfile }
          : holder
            ? { ...holder, profile: sharedProfile }
            : null,
      );
      continue;
    }
    if (SSH_CERT_REF.test(ref)) {
      const cert = ssh.certificates?.find((item) => item.id === ref);
      const holder = sshHolders.get(ref);
      add(
        ref,
        "ssh",
        "ssh-certificate",
        cert
          ? { id: cert.id, label: cert.keyIdString || cert.id, profile: sharedProfile }
          : holder
            ? { ...holder, profile: sharedProfile }
            : null,
      );
      continue;
    }
    if (SSH_PASSWORD_REF.test(ref)) {
      const holder = sshHolders.get(ref);
      add(ref, "ssh", "ssh-password", holder ? { ...holder, profile: sharedProfile } : null);
    }
  }

  const order = (system: CredentialSystem) => CREDENTIAL_SYSTEMS.indexOf(system);
  return entries.sort(
    (a, b) =>
      order(a.system) - order(b.system) ||
      Number(a.orphan) - Number(b.orphan) ||
      a.ownerLabel.localeCompare(b.ownerLabel) ||
      a.kind.localeCompare(b.kind) ||
      a.ref.localeCompare(b.ref),
  );
}
