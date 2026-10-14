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
    /** Only distributions whose answer is KNOWN. A name absent here is unknown, not unavailable. */
    sshAvailableByDistro: Record<string, boolean>;
    /** Stopped (asking would boot them) or their probe timed out; the connect itself will tell. */
    sshUnknownDistros?: string[];
    error?: string;
  } | null;
  permissions: { canManageHosts: boolean; reason?: string };
}
