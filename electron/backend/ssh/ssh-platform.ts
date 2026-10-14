/// <reference types="node" />
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { resolveAgent } from "./ssh-agent.js";
import { detectWslDistros, listRunningWslDistros } from "./ssh-wsl.js";
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
  wsl:
    | (WslDistros & {
        /** Only distributions whose answer is KNOWN; a name absent here is not "unavailable". */
        sshAvailableByDistro: Record<string, boolean>;
        /** Distributions not asked (stopped — asking would boot them) or whose probe timed out. */
        sshUnknownDistros: string[];
      })
    | null;
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

/** `unknown`: the probe was killed (timeout) before it could answer — not evidence of absence. */
type ProbeOutcome = "works" | "missing" | "unknown";

async function probeBinary(file: string, args: string[], allowUsageExit = false): Promise<ProbeOutcome> {
  if (!file) return "missing";
  try {
    await execFileAsync(file, args, { timeout: 1500, windowsHide: true });
    return "works";
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (failure.killed || failure.signal) return "unknown";
    if (failure.code === "ENOENT") return "missing";
    const exitCode = typeof failure.code === "number" ? failure.code : undefined;
    const output = `${String((failure as Error & { stdout?: unknown }).stdout || "")} ${String((failure as Error & { stderr?: unknown }).stderr || "")}`;
    return allowUsageExit && exitCode !== undefined && /usage|invalid option|unknown option/i.test(output)
      ? "works"
      : "missing";
  }
}

async function binaryWorks(file: string, args: string[], allowUsageExit = false): Promise<boolean> {
  return (await probeBinary(file, args, allowUsageExit)) === "works";
}

/**
 * WSL and the ssh inside each distribution.
 *
 * Only RUNNING distributions are asked: `wsl -d <distro> -- ssh -V` boots a stopped one, which takes
 * several seconds — far past the probe's timeout, so the answer used to be a false "SSH is not
 * installed" for every stopped distribution, after starting it. A stopped distribution, and a running
 * one whose probe timed out, is reported as unknown; the connect itself finds out for real.
 */
async function probeWsl(wslSshExec: string): Promise<PlatformCapabilities["wsl"]> {
  const [detected, running] = await Promise.all([detectWslDistros(), listRunningWslDistros()]);
  if (!detected) return null;
  const runningDistros = new Set(running ?? []);
  const outcomes = await Promise.all(
    detected.distros.map(async (distro) =>
      runningDistros.has(distro)
        ? ([distro, await probeBinary("wsl.exe", ["-d", distro, "--", wslSshExec, "-V"])] as const)
        : ([distro, "unknown"] as const),
    ),
  );
  return {
    ...detected,
    sshAvailableByDistro: Object.fromEntries(
      outcomes.filter(([, outcome]) => outcome !== "unknown").map(([distro, outcome]) => [distro, outcome === "works"]),
    ),
    sshUnknownDistros: outcomes.filter(([, outcome]) => outcome === "unknown").map(([distro]) => distro),
  };
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
  const systemSshPath = options.systemSshPath || (process.platform === "win32" ? "ssh.exe" : "ssh");
  // Independent probes, run together: one after another they added up to several seconds per call.
  const [wsl, openSshAgent, pageant, sshKeygen, systemSsh] = await Promise.all([
    probeWsl(options.wslSshExec || "ssh"),
    resolveAgent("auto", options.agentPath).then(
      async (agentSocket) => agentSocket !== "pageant" && (await agentResponds(agentSocket)),
    ),
    pageantResponds(),
    binaryWorks("ssh-keygen", ["-?"], true),
    binaryWorks(systemSshPath, ["-V"]),
  ]);
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
