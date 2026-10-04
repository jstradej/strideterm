export interface SshConnectionIdentityDraft {
  host: string;
  username?: string;
  requireUsername: boolean;
  port?: number;
}

export function validateSshConnectionIdentity(draft: SshConnectionIdentityDraft): string | null {
  if (!draft.host.trim()) return "Enter a host name or SSH alias.";
  if (draft.requireUsername && !draft.username?.trim()) return "Enter the remote username for Built-in SSH.";
  if (draft.port !== undefined && (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535)) {
    return "Port must be between 1 and 65535.";
  }
  return null;
}
