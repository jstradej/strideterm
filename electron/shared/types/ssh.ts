export interface SshAuth {
  methods: Array<"password" | "publickey" | "keyboard-interactive" | "agent">;
  passwordRef?: string;
  keyRef?: string;
  certRef?: string;
  passphraseRef?: string;
  agent?: "auto" | "socket" | "pageant" | "pipe" | "off" | null;
}

export interface SshHost {
  id: string;
  host: string;
  port?: number;
  username?: string;
  jump?: string[];
  auth?: SshAuth;
  name?: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  hostKeyPolicy?: "strict" | "warn" | "accept-new";
  advanced?: {
    launchVia?: SshLaunchVia;
    portOverride?: boolean;
    keepaliveIntervalMs?: number;
    keepaliveCountMax?: number;
    compression?: boolean;
    agentForward?: boolean;
    command?: string;
    sshPath?: string;
    env?: Record<string, string>;
    algorithms?: Record<string, unknown>;
    wsl?: { distro?: string | null; user?: string | null; exec?: string };
  };
}

export interface SshKey {
  id: string;
  label: string;
  kind: string;
  publicKey?: string;
  fingerprint?: string;
  source?: string;
  hasPassphrase: boolean;
  /** Time key metadata was added to the app; for imported keys this is not the key's original creation date. */
  createdAt: string;
}

export interface SshCert {
  id: string;
  keyId: string;
  publicCert?: string;
  type?: string;
  keyIdString?: string;
  principals?: string[];
  serial?: string;
  validBefore?: string | null;
  validAfter?: string | null;
  signatureKey?: string;
  extensions?: string[];
  criticalOptions?: string[];
  createdAt: string;
}

export interface SshAuthRequest {
  sessionId: string;
  promptId: string;
  prompt: {
    name?: string;
    instructions?: string;
    prompts: Array<{ prompt: string; echo: boolean }>;
  };
}

export interface SshAuthPromptCancel {
  sessionId: string;
  promptId: string;
}

export type SshConnectionStatus = "idle" | "connecting" | "connected" | "process-running" | "error" | "disconnected";

export interface SshConnectionState {
  sessionId: string;
  hostId: string;
  status: SshConnectionStatus;
  connected?: boolean;
  error?: string;
  connectedAt?: string;
}

export interface SshConnectionTestState {
  sessionId: string;
  mode: "ssh2" | "system-ssh" | "wsl";
  status: "connecting" | "authenticated" | "process-running" | "error" | "disconnected" | "cancelled";
  error?: string;
}

export interface SshKeyTransferState {
  operationId: string;
  hostId: string;
  keyId: string;
  status:
    | "connecting"
    | "uploading"
    | "verifying"
    | "installed"
    | "already-installed"
    | "verification-failed"
    | "error"
    | "cancelled";
  installed?: boolean;
  remoteMayHaveChanged?: boolean;
  error?: string;
}
import type { SshLaunchVia } from "../ssh-connection.js";

export type {
  EffectiveSshLaunchVia,
  SshConnectionSettings,
  SshLaunchVia,
  SshRuntimeCapabilities,
} from "../ssh-connection.js";
