export type SshLaunchVia = "default" | "ssh2" | "system-ssh" | "wsl";
export type EffectiveSshLaunchVia = Exclude<SshLaunchVia, "default">;

export interface SshConnectionSettings {
  defaultLaunchVia: EffectiveSshLaunchVia;
  systemSshPath: string;
  wslDefaultDistro: string;
  wslSshExec: string;
  agentPath: string;
  defaultAgentMode: "auto" | "socket" | "pageant" | "pipe" | "off";
  requireEncryptedStorage: boolean;
  storagePolicyMigrationNotice?: boolean;
}

const EFFECTIVE_MODES: readonly EffectiveSshLaunchVia[] = ["ssh2", "system-ssh", "wsl"];

function effectiveMode(value: unknown): EffectiveSshLaunchVia | undefined {
  return EFFECTIVE_MODES.includes(value as EffectiveSshLaunchVia) ? (value as EffectiveSshLaunchVia) : undefined;
}

/** Resolve host → stored setting → environment → product default. */
export function resolveSshLaunchVia(
  hostLaunchVia: unknown,
  settingsDefaultLaunchVia: unknown,
  envDefaultLaunchVia: unknown = undefined,
  productDefault: EffectiveSshLaunchVia = "ssh2",
): EffectiveSshLaunchVia {
  return (
    effectiveMode(hostLaunchVia) ||
    effectiveMode(settingsDefaultLaunchVia) ||
    effectiveMode(envDefaultLaunchVia) ||
    productDefault
  );
}

export interface SshRuntimeCapabilities {
  platform: string;
  arch: string;
  safeStorageAvailable: boolean;
  sshKeygen: boolean;
  systemSsh: boolean;
  openSshAgent: boolean;
  pageant: boolean;
  wsl: {
    installed: boolean;
    distros: string[];
    default?: string;
    sshAvailableByDistro: Record<string, boolean>;
    error?: string;
  } | null;
  permissions: { canManageHosts: boolean; reason?: string };
}
