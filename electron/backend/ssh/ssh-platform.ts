/// <reference types="node" />
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { resolveAgent } from "./ssh-agent.js";
import { detectWslDistros } from "./ssh-wsl.js";
import type { WslDistros } from "./ssh-wsl.js";

const execFileAsync = promisify(execFile);

export interface PlatformCapabilities {
  platform: string;
  arch: string;
  safeStorageAvailable: boolean;
  sshKeygen: boolean;
  systemSsh: boolean;
  openSshAgent: boolean;
  pageant: boolean;
  wsl: (WslDistros & { sshAvailableByDistro: Record<string, boolean> }) | null;
  permissions: { canManageHosts: boolean; reason?: string };
}

interface PreflightWarning {
  level: string;
  code: string;
  message: string;
  remedy?: string;
}

export interface PreflightResult {
  capabilities: PlatformCapabilities;
  warnings: PreflightWarning[];
}

interface PreflightOptions {
  safeStorageAvailable: boolean;
  systemSshPath?: string;
  wslSshExec?: string;
  agentPath?: string;
  canManageHosts?: boolean;
}

async function binaryWorks(file: string, args: string[], allowUsageExit = false): Promise<boolean> {
  if (!file) return false;
  try {
    await execFileAsync(file, args, { timeout: 1500, windowsHide: true });
    return true;
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (failure.killed || failure.signal || failure.code === "ENOENT") return false;
    const exitCode = typeof failure.code === "number" ? failure.code : undefined;
    const output = `${String((failure as Error & { stdout?: unknown }).stdout || "")} ${String((failure as Error & { stderr?: unknown }).stderr || "")}`;
    return allowUsageExit && exitCode !== undefined && /usage|invalid option|unknown option/i.test(output);
  }
}

async function agentResponds(agentPath: string | undefined): Promise<boolean> {
  if (!agentPath) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection(agentPath);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function pageantResponds(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await execFileAsync("tasklist.exe", ["/FI", "IMAGENAME eq pageant.exe", "/FO", "CSV", "/NH"], {
      timeout: 1000,
      windowsHide: true,
    });
    return /"pageant\.exe"/i.test(stdout);
  } catch {
    return false;
  }
}

export async function runPlatformPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const wslDetected = await detectWslDistros();
  const wsl = wslDetected
    ? {
        ...wslDetected,
        sshAvailableByDistro: Object.fromEntries(
          await Promise.all(
            wslDetected.distros.map(
              async (distro) =>
                [
                  distro,
                  await binaryWorks("wsl.exe", ["-d", distro, "--", options.wslSshExec || "ssh", "-V"]),
                ] as const,
            ),
          ),
        ),
      }
    : null;
  const agentSocket = await resolveAgent("auto", options.agentPath);
  const openSshAgent = agentSocket !== "pageant" && (await agentResponds(agentSocket));
  const pageant = await pageantResponds();
  const sshKeygen = await binaryWorks("ssh-keygen", ["-?"], true);
  const systemSshPath = options.systemSshPath || (process.platform === "win32" ? "ssh.exe" : "ssh");
  const systemSsh = await binaryWorks(systemSshPath, ["-V"]);
  const caps: PlatformCapabilities = {
    platform: process.platform,
    arch: process.arch,
    safeStorageAvailable: options.safeStorageAvailable,
    sshKeygen,
    systemSsh,
    openSshAgent,
    pageant,
    wsl,
    permissions: {
      canManageHosts: options.canManageHosts !== false,
      ...(options.canManageHosts === false
        ? { reason: "SSH host and credential management is available on the desktop only." }
        : {}),
    },
  };

  const warnings: PreflightWarning[] = [];
  if (!caps.safeStorageAvailable) {
    warnings.push({
      level: "error",
      code: "NO_SECURE_STORAGE",
      message: "Encrypted storage is not available. Private-key saving follows the configured storage policy.",
    });
  }
  if (!caps.sshKeygen) {
    warnings.push({ level: "info", code: "NO_SSH_KEYGEN", message: "ssh-keygen was not found or did not respond." });
  }
  if (!caps.systemSsh) {
    warnings.push({
      level: "info",
      code: "NO_SYSTEM_SSH",
      message: "The selected system SSH executable was not found or did not respond.",
    });
  }
  return { capabilities: caps, warnings };
}
