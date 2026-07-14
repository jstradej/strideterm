export interface SshAuth {
  methods: string[];
  password?: string;
  privateKey?: string;
  agent?: boolean;
}

export interface SshHost {
  id: string;
  host: string;
  port?: number;
  username?: string;
  jump?: string[];
  auth?: SshAuth;
  label?: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export interface SshKey {
  id: string;
  label: string;
  type: string;
  fingerprint: string;
  path: string;
  hasPassphrase: boolean;
  createdAt: string;
}

export interface SshCert {
  id: string;
  keyId: string;
  serial: string;
  validBefore: string;
  validAfter: string;
  createdAt: string;
}

export interface SshAuthRequest {
  sessionId: string;
  hostId: string;
  kind: "password" | "keyboard-interactive" | "passphrase";
  prompt: string;
  // Generation token, echoed back on answers and used to scope prompt dismissals.
  promptId?: string;
}

export interface SshAuthPromptCancel {
  sessionId: string;
  promptId: string;
}

export type SshConnectionStatus = "idle" | "connecting" | "connected" | "error" | "disconnected";

export interface SshConnectionState {
  sessionId: string;
  hostId: string;
  status: SshConnectionStatus;
  error?: string;
  connectedAt?: string;
}
