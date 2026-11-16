import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSandboxPolicy } from "./sandbox-policy.js";
import { windowsPathToWsl } from "../../shared/wsl-paths.js";
import {
  SandboxUnavailableError,
  type SandboxBackend,
  type SandboxEnvironment,
  type SandboxLaunch,
  type SandboxSpec,
} from "./types.js";

/**
 * The default backend: process isolation by `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux and
 * in WSL2, Seatbelt on macOS), driven through the launcher script. The runtime's settings are
 * generated here, per launch, into a folder strIDEterm owns — never read from the workspace tree.
 */

export interface SrtBackendOptions {
  /** Folder (host notation) holding the per-session launch files; created on demand, mode 0700. */
  sessionsDir: string;
  /** Host path of the written launcher script. */
  launcherPath: string;
  /** How long the launcher waits for the user to decide on a destination. */
  askTimeoutMs?: number;
  writeFile?: (file: string, content: string) => void;
  makeDir?: (dir: string) => void;
  /** The host's environment, source of the Windows system variables `wsl.exe` itself needs. */
  hostEnv?: Record<string, string | undefined>;
}

/** Variables that must not travel into the sandbox from the launcher's own environment. */
const LAUNCHER_ONLY_ENV = ["ELECTRON_RUN_AS_NODE", "WSLENV"];

/**
 * Windows system variables for `wsl.exe` itself: under ConPTY it fails without `SystemRoot`
 * ("Wsl/Service/0x8007072c"). Not named in WSLENV, so they never reach the distro.
 */
const WSL_HOST_ENV = ["SystemRoot", "SystemDrive", "windir"];

export const DEFAULT_ASK_TIMEOUT_MS = 90_000;

/** Folder of one session's launch files, in host notation. */
export function sessionLaunchDir(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId.replace(/[^A-Za-z0-9._-]/gu, "_"));
}

export class SrtBackend implements SandboxBackend {
  readonly id = "srt" as const;

  constructor(private readonly options: SrtBackendOptions) {}

  /** The files of one session in host notation: launch config, denials, decisions. */
  sessionFiles(sessionId: string) {
    const dir = sessionLaunchDir(this.options.sessionsDir, sessionId);
    return {
      dir,
      launchConfig: path.join(dir, "launch.json"),
      denialsFile: path.join(dir, "denials.jsonl"),
      decisionsDir: path.join(dir, "decisions"),
    };
  }

  toolDir(sessionId: string, environment: SandboxEnvironment): string {
    const dir = this.toSandboxPath(environment, this.sessionFiles(sessionId).dir);
    return path.posix.join(dir.replace(/\\/gu, "/"), "tools");
  }

  /** Where the sandbox host sees a host path. */
  private toSandboxPath(environment: SandboxEnvironment, hostPath: string): string {
    if (environment.platform !== "win32") return hostPath;
    const mapped = windowsPathToWsl(hostPath);
    if (!mapped) throw new SandboxUnavailableError(`The path ${hostPath} cannot be reached from WSL.`);
    return mapped.path;
  }

  buildLaunch(spec: SandboxSpec, environment: SandboxEnvironment): SandboxLaunch {
    const write = this.options.writeFile ?? ((file, content) => writeFileSync(file, content, { mode: 0o600 }));
    const makeDir = this.options.makeDir ?? ((dir) => void mkdirSync(dir, { recursive: true, mode: 0o700 }));
    const files = this.sessionFiles(spec.sessionId);
    makeDir(files.dir);
    makeDir(files.decisionsDir);
    write(files.denialsFile, "");

    const policy = buildSandboxPolicy({
      ...spec,
      toolConfigDir: this.toolDir(spec.sessionId, environment),
      gatewaySocket: spec.gateway?.socketPath,
    });

    const launchConfig = {
      srtModule: environment.srtModule,
      // Names the denial requests the launcher writes, which become file names: letters, digits, dot, dash only.
      sessionId: spec.sessionId.replace(/[^A-Za-z0-9._-]/gu, "_"),
      askTimeoutMs: this.options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS,
      denialsFile: this.toSandboxPath(environment, files.denialsFile),
      decisionsDir: this.toSandboxPath(environment, files.decisionsDir),
      ensureDirs: policy.ensureDirs,
      toolFiles: spec.toolFiles,
      confinedLinks: spec.confinedLinks ?? [],
      seededFiles: spec.seededFiles ?? [],
      confinedMirrors: spec.confinedMirrors ?? [],
      pathPrepend: spec.pathPrepend ?? [],
      pathAppend: spec.pathAppend ?? [],
      relay: spec.gateway?.relay
        ? {
            unixSocket: spec.gateway.socketPath,
            tcpHost: spec.gateway.relay.tcpHost,
            tcpPort: spec.gateway.relay.tcpPort,
          }
        : undefined,
      optional: policy.optional,
      homeOverride: spec.homeOverride,
      unsetEnv: LAUNCHER_ONLY_ENV,
      keepEnv: Object.keys(spec.env).filter((name) => !LAUNCHER_ONLY_ENV.includes(name)),
      command: spec.command,
      runtime: policy.runtime,
    };
    write(files.launchConfig, JSON.stringify(launchConfig));

    const launcher = this.toSandboxPath(environment, this.options.launcherPath);
    const config = this.toSandboxPath(environment, files.launchConfig);

    if (environment.platform === "win32") {
      const env = { ...spec.env };
      const forwarded = Object.keys(env).filter((name) => !LAUNCHER_ONLY_ENV.includes(name));
      env.WSLENV = forwarded.join(":");
      const hostEnv = this.options.hostEnv ?? process.env;
      for (const name of WSL_HOST_ENV) {
        const value = hostEnv[name] ?? hostEnv[name.toUpperCase()];
        if (value) env[name] = value;
      }
      return {
        file: "wsl.exe",
        args: [
          ...(environment.distro ? ["-d", environment.distro] : []),
          "--cd",
          spec.cwd,
          "-e",
          "bash",
          "-lc",
          'exec "$@"',
          "strideterm-sandbox",
          environment.nodePath,
          launcher,
          config,
        ],
        env,
        cwd: process.cwd(),
      };
    }
    return {
      file: environment.nodePath,
      args: [launcher, config],
      env: { ...spec.env },
      cwd: spec.cwd,
    };
  }
}
