import { execFile } from "node:child_process";
import {
  SANDBOX_AGENT_IDS,
  SANDBOX_SRT_VERSION,
  type SandboxAgentStatus,
  type SandboxPrerequisite,
  type SandboxPrerequisiteId,
  type SandboxStatus,
} from "../../shared/sandbox.js";
import { windowsPathToWsl } from "../../shared/wsl-paths.js";
import { agentBinHome } from "./agent-profile.js";
import type { SandboxEnvironment } from "./types.js";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[], options?: { timeoutMs?: number }) => Promise<CommandResult>;

export const execRunner: CommandRunner = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs ?? 20_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
      },
    );
  });

/** `wsl.exe` writes UTF-16 to a pipe for its own messages; a command run inside the distro writes UTF-8. */
function clean(text: string): string {
  return text.replace(/\0/gu, "");
}

/** Where strIDEterm installs the sandbox runtime: a user-owned folder, so no root is needed and a Node version switch keeps it. */
const SANDBOX_RUNTIME_PREFIX = "$HOME/.local/share/strideterm/sandbox-runtime";

/**
 * Finds an agent CLI the sandbox can run: the first match on PATH that is not a Windows shim under `/mnt` (WSL puts
 * the Windows PATH in, and its npm shims can come first), else the agent installer's own folder, which only an
 * interactive shell's rc file adds to PATH. A Windows shim is reported only when nothing else was found.
 */
export const FIND_AGENT_SCRIPT = String.raw`
find_agent() {
  name=$1; shift; win=""
  while IFS= read -r found; do
    case "$found" in
      "") ;;
      /mnt/*) [ -n "$win" ] || win=$found ;;
      *) echo "$found"; return ;;
    esac
  done <<STRIDETERM_EOF
$(type -ap "$name" 2>/dev/null)
STRIDETERM_EOF
  for dir in "$@"; do
    if [ -x "$HOME/$dir/$name" ]; then echo "$HOME/$dir/$name"; return; fi
  done
  echo "$win"
}`;

const AGENT_PROBE_LINES = SANDBOX_AGENT_IDS.map((id) => {
  const dirs = agentBinHome(id)
    .map((dir) => ` "${dir}"`)
    .join("");
  return `echo "agent_${id}=$(find_agent ${id}${dirs})"`;
}).join("\n");

/**
 * One bash script, run where the sandbox runtime will run, that reports what is there as `key=value`
 * lines. A login shell, so a Node installed by nvm or Homebrew is on PATH as it is for the user.
 */
export const PROBE_SCRIPT = String.raw`
echo "home=$HOME"
echo "node=$(command -v node || true)"
echo "node_version=$(node -p process.versions.node 2>/dev/null || true)"
echo "bwrap=$(command -v bwrap || true)"
echo "socat=$(command -v socat || true)"
echo "rg=$(command -v rg || true)"
echo "sandbox_exec=$(command -v sandbox-exec || true)"
echo "uname=$(uname -s)"
echo "kernel=$(uname -r)"
echo "distro_name=$WSL_DISTRO_NAME"
echo "pm=$(for m in apt-get dnf pacman zypper apk; do command -v $m >/dev/null 2>&1 && echo $m && break; done)"
${FIND_AGENT_SCRIPT}
${AGENT_PROBE_LINES}
codex_path=$(find_agent codex)
case "$codex_path" in ""|/mnt/*) ;; *) echo "codex_version=$("$codex_path" --version 2>/dev/null | head -n 1)" ;; esac
root="$HOME/.local/share/strideterm/sandbox-runtime/node_modules/@anthropic-ai/sandbox-runtime"
if [ ! -f "$root/dist/index.js" ] && command -v npm >/dev/null 2>&1; then
  root="$(npm root -g 2>/dev/null)/@anthropic-ai/sandbox-runtime"
fi
if [ -f "$root/dist/index.js" ] && command -v node >/dev/null 2>&1; then
  echo "srt_module=$root/dist/index.js"
  echo "srt_version=$(node -p "require('$root/package.json').version" 2>/dev/null)"
fi
if command -v wslinfo >/dev/null 2>&1; then echo "wsl_net=$(wslinfo --networking-mode 2>/dev/null)"; fi
echo "wsl_gw=$(ip route show default 2>/dev/null | awk '{print $3; exit}')"
`;

/**
 * WSL version of the distribution the probe ran in, from its kernel release: WSL2 runs a real Linux kernel
 * (`...microsoft-standard-WSL2`), WSL1 translates system calls (`4.4.0-19041-Microsoft`). 0 = cannot tell
 * (a custom kernel), which is accepted: bubblewrap itself fails visibly on a kernel that cannot run it.
 */
export function wslVersionOf(kernel: string | undefined): 0 | 1 | 2 {
  const release = (kernel || "").trim();
  if (/wsl2|microsoft-standard/iu.test(release)) return 2;
  if (/microsoft/iu.test(release)) return 1;
  return 0;
}

export function parseProbe(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of clean(output).split(/\r?\n/u)) {
    const match = /^([a-z_]+)=(.*)$/u.exec(line.trim());
    if (match) result[match[1]] = match[2];
  }
  return result;
}

export interface ProbeOptions {
  platform: NodeJS.Platform;
  distro?: string;
  run?: CommandRunner;
}

export interface ProbeResult {
  facts: Record<string, string>;
  /** Windows: false when WSL itself is missing or the distro does not start. */
  reachable: boolean;
  detail?: string;
}

export async function probeSandboxHost({ platform, distro, run = execRunner }: ProbeOptions): Promise<ProbeResult> {
  const result =
    platform === "win32"
      ? await run("wsl.exe", [...(distro ? ["-d", distro] : []), "-e", "bash", "-lc", PROBE_SCRIPT], {
          timeoutMs: 45_000,
        })
      : await run("bash", ["-lc", PROBE_SCRIPT], { timeoutMs: 20_000 });
  const facts = parseProbe(result.stdout);
  if (!facts.home) {
    return {
      facts,
      reachable: false,
      detail:
        clean(result.stderr).trim() || (platform === "win32" ? "WSL is not available." : "The probe did not run."),
    };
  }
  return { facts, reachable: true };
}

const LABELS: Record<SandboxPrerequisiteId, string> = {
  wsl: "WSL2 with a Linux distribution",
  node: "Node.js",
  srt: `Sandbox runtime (@anthropic-ai/sandbox-runtime ${SANDBOX_SRT_VERSION})`,
  bubblewrap: "bubblewrap",
  socat: "socat",
  ripgrep: "ripgrep",
  seatbelt: "macOS Seatbelt (sandbox-exec)",
};

function prerequisite(
  id: SandboxPrerequisiteId,
  ok: boolean,
  installable: boolean,
  detail?: string,
): SandboxPrerequisite {
  return { id, label: LABELS[id], ok, installable, ...(detail ? { detail } : {}) };
}

export interface HostDescription {
  status: SandboxStatus;
  /** Present when the host is ready to run sandboxes. */
  environment: SandboxEnvironment | null;
  packageManager: string;
}

/** `engines.node` of the pinned sandbox runtime. */
const SANDBOX_MIN_NODE = [22, 12] as const;

/** An unreported version is not judged: the launcher fails visibly when the runtime cannot load. */
function isNodeTooOld(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)/u.exec(version || "");
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major < SANDBOX_MIN_NODE[0] || (major === SANDBOX_MIN_NODE[0] && minor < SANDBOX_MIN_NODE[1]);
}

/** A Windows shim reached through WSL interop (`/mnt/c/...`) is not an install the sandbox can run: it denies `/mnt`. */
function describeAgents(platform: NodeJS.Platform, facts: Record<string, string>): SandboxAgentStatus[] {
  return SANDBOX_AGENT_IDS.map((id) => {
    const found = facts[`agent_${id}`] || "";
    const windowsOnly = platform === "win32" && found.startsWith("/mnt/");
    const ok = Boolean(found) && !windowsOnly;
    if (ok) return { id, ok };
    return {
      id,
      ok,
      ...(windowsOnly ? { windowsOnly } : {}),
      detail: windowsOnly
        ? "Installed on Windows only. Isolated tabs run inside WSL — install it there."
        : `Not installed${platform === "win32" ? " inside WSL" : ""}`,
    };
  });
}

/** Turns a probe into the status shown to the user and, when everything is there, the environment to launch in. */
export function describeSandboxHost(platform: NodeJS.Platform, probe: ProbeResult, distro?: string): HostDescription {
  const os: "linux" | "darwin" = platform === "darwin" ? "darwin" : "linux";
  const statusPlatform = platform === "win32" || platform === "darwin" ? platform : "linux";
  const notes: string[] = [];
  const prerequisites: SandboxPrerequisite[] = [];
  const facts = probe.facts;

  if (platform === "win32") {
    const wslVersion = probe.reachable ? wslVersionOf(probe.facts.kernel) : 0;
    const wslDetail = !probe.reachable
      ? probe.detail
      : wslVersion === 1
        ? `This distribution runs as WSL1, which cannot run the sandbox. Convert it to WSL2${probe.facts.distro_name ? ` (wsl --set-version ${probe.facts.distro_name} 2)` : ""}.`
        : undefined;
    // Missing WSL and a WSL1 distribution are both something strIDEterm can lead the user through (see planInstall).
    prerequisites.push(prerequisite("wsl", probe.reachable && wslVersion !== 1, true, wslDetail));
    notes.push(
      "Agents run inside WSL2: the project needs Linux build tools there.",
      "A workspace on a Windows drive (C:) goes through a slow file system; a workspace inside WSL is faster.",
    );
  }
  if (!probe.reachable) {
    return {
      status: {
        platform: statusPlatform,
        ready: false,
        prerequisites,
        notes,
        gateway: "unavailable",
        gatewayDetail: "The sandbox host is not reachable.",
        agents: [],
      },
      environment: null,
      packageManager: "",
    };
  }

  const pm = facts.pm || "";
  const nodeTooOld = isNodeTooOld(facts.node_version);
  const needsPackages = platform !== "darwin";
  prerequisites.push(
    prerequisite(
      "node",
      Boolean(facts.node) && !nodeTooOld,
      false,
      nodeTooOld
        ? `Found ${facts.node_version}, the sandbox runtime needs Node.js ${SANDBOX_MIN_NODE.join(".")} or newer.`
        : facts.node
          ? undefined
          : `Install Node.js ${SANDBOX_MIN_NODE.join(".")} or newer.`,
    ),
  );
  const srtVersionOk = facts.srt_version === SANDBOX_SRT_VERSION;
  prerequisites.push(
    prerequisite(
      "srt",
      Boolean(facts.srt_module) && srtVersionOk,
      Boolean(facts.node),
      facts.srt_module && !srtVersionOk
        ? `Found ${facts.srt_version || "unknown"}, needs ${SANDBOX_SRT_VERSION}.`
        : undefined,
    ),
  );
  if (needsPackages) {
    prerequisites.push(prerequisite("bubblewrap", Boolean(facts.bwrap), Boolean(pm)));
    prerequisites.push(prerequisite("socat", Boolean(facts.socat), Boolean(pm)));
    prerequisites.push(prerequisite("ripgrep", Boolean(facts.rg), Boolean(pm)));
  } else {
    prerequisites.push(prerequisite("seatbelt", Boolean(facts.sandbox_exec), false));
  }

  const ready = prerequisites.every((item) => item.ok);
  let gateway: SandboxStatus["gateway"] = "available";
  let gatewayDetail: string | undefined;
  let hostAddress: string | undefined;
  if (platform === "win32") {
    const mirrored = facts.wsl_net === "mirrored";
    hostAddress = mirrored ? "127.0.0.1" : facts.wsl_gw || "";
    if (!hostAddress) {
      gateway = "unavailable";
      gatewayDetail = "WSL did not report how to reach Windows, so MCP tools, hooks and registries are not offered.";
    }
  }

  const status: SandboxStatus = {
    platform: statusPlatform,
    ready,
    prerequisites,
    notes,
    gateway,
    ...(gatewayDetail ? { gatewayDetail } : {}),
    agents: describeAgents(platform, facts),
    ...(platform === "win32" && facts.distro_name && facts.home.startsWith("/")
      ? { wslHome: `\\\\wsl.localhost\\${facts.distro_name}${facts.home.replace(/\//gu, "\\")}` }
      : {}),
  };
  const environment: SandboxEnvironment | null = ready
    ? {
        os,
        platform,
        home: facts.home,
        nodePath: facts.node,
        srtModule: facts.srt_module,
        ...(distro ? { distro } : {}),
        ...(hostAddress ? { hostAddress } : {}),
        ...(facts.codex_version ? { codexVersion: facts.codex_version } : {}),
      }
    : null;
  return { status, environment, packageManager: pm };
}

export interface InstallPlan {
  /** Steps strIDEterm runs itself, after the user confirmed. */
  steps: Array<{ label: string; file: string; args: string[] }>;
  /** What the user must run by hand when a step needs a password. */
  manual: string[];
}

const PACKAGE_INSTALL: Record<string, (packages: string[]) => string> = {
  "apt-get": (packages) => `apt-get install -y ${packages.join(" ")}`,
  dnf: (packages) => `dnf install -y ${packages.join(" ")}`,
  pacman: (packages) => `pacman -S --noconfirm ${packages.join(" ")}`,
  zypper: (packages) => `zypper --non-interactive install ${packages.join(" ")}`,
  apk: (packages) => `apk add ${packages.join(" ")}`,
};

const PACKAGE_NAMES: Partial<Record<SandboxPrerequisiteId, string>> = {
  bubblewrap: "bubblewrap",
  socat: "socat",
  ripgrep: "ripgrep",
};

/** The folder given as `$1` is never part of the script text: a path with a quote or a `$` in it stays a path. */
const COPY_RUNTIME_SCRIPT = [
  "set -e",
  `prefix="${SANDBOX_RUNTIME_PREFIX}"`,
  'rm -rf "$prefix"',
  'mkdir -p "$prefix"',
  'cp -R "$1/node_modules" "$prefix/"',
  'chmod -R u+rwX,go+rX "$prefix"',
  // A tree copied from an NTFS checkout may have lost the bit; bubblewrap executes these helpers.
  'find "$prefix/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp" -type f -exec chmod 755 {} +',
].join("\n");

/** Copies the tree shipped with the app into the runtime's prefix, where the sandbox runs. Null when it cannot be reached from there. */
export function bundledRuntimeCopyStep(
  platform: NodeJS.Platform,
  distro: string | undefined,
  bundledRuntimeDir: string | null | undefined,
): InstallPlan["steps"][number] | null {
  if (!bundledRuntimeDir) return null;
  if (platform !== "win32") {
    return {
      label: `Copy the sandbox runtime ${SANDBOX_SRT_VERSION}`,
      file: "bash",
      args: ["-lc", COPY_RUNTIME_SCRIPT, "strideterm-sandbox", bundledRuntimeDir],
    };
  }
  const mapped = windowsPathToWsl(bundledRuntimeDir);
  if (!mapped) return null;
  return {
    label: `Copy the sandbox runtime ${SANDBOX_SRT_VERSION} into WSL`,
    file: "wsl.exe",
    args: [
      ...(distro ? ["-d", distro] : []),
      "-e",
      "bash",
      "-lc",
      COPY_RUNTIME_SCRIPT,
      "strideterm-sandbox",
      mapped.path,
    ],
  };
}

/**
 * What installing the missing prerequisites takes. In WSL the packages are installed as root through
 * `wsl -u root` (no password). On a Linux host they need `sudo`; when that cannot run without a
 * password the exact command is handed back for the user to run.
 */
export function planInstall(
  platform: NodeJS.Platform,
  status: SandboxStatus,
  packageManager: string,
  distro?: string,
  bundledRuntimeDir?: string | null,
): InstallPlan {
  const missing = status.prerequisites.filter((item) => !item.ok && item.installable).map((item) => item.id);
  if (platform === "win32" && missing.includes("wsl")) {
    // Neither step can be run silently: installing WSL needs an elevated terminal and usually a restart, and
    // converting a distribution to WSL2 takes minutes. The user runs them; strIDEterm checks again afterwards.
    const wslDetail = status.prerequisites.find((item) => item.id === "wsl")?.detail || "";
    const converting = /WSL1/u.test(wslDetail);
    const target = /wsl --set-version (\S+) 2/u.exec(wslDetail)?.[1] || distro || "<distribution>";
    return {
      steps: converting
        ? [{ label: `Convert ${target} to WSL2`, file: "wsl.exe", args: ["--set-version", target, "2"] }]
        : [],
      manual: converting
        ? [`wsl --set-version ${target} 2`]
        : ["wsl --install -d Ubuntu   (in an elevated PowerShell; restart Windows when it asks)"],
    };
  }
  const packages = missing.map((id) => PACKAGE_NAMES[id]).filter((name): name is string => Boolean(name));
  const steps: InstallPlan["steps"] = [];
  const manual: string[] = [];
  const distroArgs = distro ? ["-d", distro] : [];

  if (packages.length && PACKAGE_INSTALL[packageManager]) {
    const command = PACKAGE_INSTALL[packageManager](packages);
    if (platform === "win32") {
      const refresh = packageManager === "apt-get" ? "apt-get update && " : "";
      steps.push({
        label: `Install ${packages.join(", ")} in WSL`,
        file: "wsl.exe",
        args: [...distroArgs, "-u", "root", "-e", "sh", "-c", `${refresh}${command}`],
      });
    } else {
      const refresh = packageManager === "apt-get" ? "sudo apt-get update && " : "";
      manual.push(`${refresh}sudo ${command}`);
      steps.push({
        label: `Install ${packages.join(", ")}`,
        file: "bash",
        args: ["-lc", `sudo -n true 2>/dev/null && ${refresh.replace("sudo ", "sudo -n ")}sudo -n ${command}`],
      });
    }
  }
  if (missing.includes("srt")) {
    const copy = bundledRuntimeCopyStep(platform, distro, bundledRuntimeDir);
    if (copy) {
      steps.push(copy);
    } else {
      const npm = `npm install --prefix "${SANDBOX_RUNTIME_PREFIX}" --no-audit --no-fund @anthropic-ai/sandbox-runtime@${SANDBOX_SRT_VERSION}`;
      manual.push(npm);
      steps.push(
        platform === "win32"
          ? {
              label: `Install the sandbox runtime ${SANDBOX_SRT_VERSION} in WSL`,
              file: "wsl.exe",
              args: [...distroArgs, "-e", "bash", "-lc", npm],
            }
          : { label: `Install the sandbox runtime ${SANDBOX_SRT_VERSION}`, file: "bash", args: ["-lc", npm] },
      );
    }
  }
  return { steps, manual };
}
