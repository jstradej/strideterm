import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { resolveAgent } from "./ssh-agent.js";
import { detectWslDistros } from "./ssh-wsl.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

async function detectSshKeygenBinary() {
  try {
    await execFileAsync("ssh-keygen", ["-?"], { timeout: 1500 });
    return true;
  } catch (err) {
    // ssh-keygen with no args typically exits non-zero but prints usage, which
    // is still proof of existence. Only ENOENT means it's missing.
    return err.code !== "ENOENT";
  }
}

async function detectSshBinary() {
  try {
    await execFileAsync("ssh", ["-V"], { timeout: 1500 });
    return true;
  } catch (err) {
    return err.code !== "ENOENT";
  }
}

function loadSafeStorage() {
  try {
    return require("electron").safeStorage;
  } catch {
    return null;
  }
}

export async function runPlatformPreflight(appConfig = { ssh: { allowSystemSshFallback: true } }) {
  const safeStorage = loadSafeStorage();

  const wslCaps = await detectWslDistros();
  const agentSocket = await resolveAgent("auto");
  const sshKeygen = await detectSshKeygenBinary();
  const systemSsh = await detectSshBinary();

  const caps = {
    platform: process.platform,
    arch: process.arch,
    safeStorageAvailable: !!(safeStorage && typeof safeStorage.isEncryptionAvailable === "function"
      ? safeStorage.isEncryptionAvailable()
      : false),
    sshKeygen,
    systemSsh,
    openSshAgent: !!agentSocket && agentSocket !== "pageant",
    pageant: process.platform === "win32",
    wsl: wslCaps,
  };

  const warnings = [];
  if (!caps.safeStorageAvailable) {
    warnings.push({
      level: "error",
      code: "NO_SECURE_STORAGE",
      message: "Electron safeStorage is not available. Private keys cannot be stored encrypted.",
      remedy:
        process.platform === "linux"
          ? "Install gnome-keyring or kwallet and restart strIDEterm."
          : "Unexpected on this platform — file an issue.",
    });
  }
  if (!caps.sshKeygen) {
    warnings.push({
      level: "info",
      code: "NO_SSH_KEYGEN",
      message: "ssh-keygen not found in PATH. Key generation will use the sshpk fallback.",
      remedy:
        process.platform === "win32"
          ? "Install OpenSSH Client (Settings → Apps → Optional Features)."
          : "Install the openssh package.",
    });
  }
  if (!caps.systemSsh && appConfig.ssh?.allowSystemSshFallback) {
    warnings.push({
      level: "info",
      code: "NO_SYSTEM_SSH",
      message: "System 'ssh' binary not found. Per-host launch mode 'system-ssh' will be disabled.",
    });
  }
  return { capabilities: caps, warnings };
}
