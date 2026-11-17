import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { RegistryConnection } from "../shared/registry.js";
import { registrySecretRef } from "../shared/registry.js";
import {
  SANDBOX_MAX_WORKSPACE_DOMAINS,
  normalizeSandboxDomain,
  type SandboxDeniedRequest,
  type SandboxStatus,
} from "../shared/sandbox.js";
import { SANDBOX_DENIED_CHANNEL, SANDBOX_DENIED_SETTLED_CHANNEL } from "../shared/sandbox-events.js";
import type { AppState } from "../shared/types/state.js";
import { getLogger } from "./logger.js";
import { SandboxGateway } from "./sandbox/gateway.js";
import { createRegistryAudit } from "./sandbox/registry-audit.js";
import { validateRegistryInput, type RegistrySaveInput } from "./sandbox/registry-connections.js";
import { createSandboxAuditLogStore } from "./sandbox/sandbox-audit-log-store.js";
import { findBundledSandboxRuntime } from "./sandbox/bundled-runtime.js";
import { SandboxService } from "./sandbox/sandbox-service.js";
import type { CommandRunner } from "./sandbox/sandbox-environment.js";
import type { SessionSandboxHooks } from "./session-manager.js";
import type { SandboxMcpTarget } from "./review-bridge-agent-launch.js";
import { windowsPathToWsl } from "../shared/wsl-paths.js";

const log = getLogger("sandbox");

interface SecretStore {
  setSecret(ref: string, secret: string, opts?: { requireEncryptedStorage?: boolean }): Promise<void>;
  getSecret(ref: string): string;
  deleteSecret(ref: string): Promise<void>;
}

export interface RuntimeSandboxDeps {
  /** Folder strIDEterm keeps its data in. */
  dataDir: string;
  /** Folder of the audit databases. */
  auditDir: string;
  getState: () => AppState;
  mutate: (fn: (draft: AppState) => void) => Promise<unknown>;
  credentialStore: SecretStore;
  getWindowProfileId: (windowId: string | undefined) => string | null;
  emit: (channel: string, payload: unknown) => void;
  broadcastState: () => void;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** Test seam: the shipped sandbox runtime folder; looked up from the app's resources when absent. */
  bundledRuntimeDir?: string | null;
  fetchImpl?: typeof fetch;
  tmpDir?: string;
}

/** Variables a server inside the sandbox needs from its tab to reach the host gateway through the sandbox proxy. */
export const SANDBOX_PROXY_ENV_NAMES = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];

/** Nearest folder at or above a script that holds a package.json: the bridge's dependencies live there. */
function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(file);
}

/**
 * What a bridge script needs from its package: the top folder it lives in (a build output such as dist-electron),
 * the dependencies and the package.json Node reads for the module type. Never the whole package, which in a
 * development checkout is the source repository.
 */
function scriptReadPaths(file: string): string[] {
  const root = packageRootOf(file);
  const top = path.relative(root, file).split(/[\\/]/u)[0];
  const own = top && top !== path.basename(file) && !top.startsWith("..") ? path.join(root, top) : file;
  return [own, path.join(root, "node_modules"), path.join(root, "package.json")];
}

function isScriptFile(target: string): boolean {
  try {
    return /\.(?:m?js|cjs)$/iu.test(target) && statSync(target).isFile();
  } catch {
    return false;
  }
}

/** A destination as the allowlist spells it: the port only when it is not the scheme's default. */
function domainForRequest(request: SandboxDeniedRequest): string {
  const port = request.port && request.port !== 443 && request.port !== 80 ? `:${request.port}` : "";
  return `${request.host}${port}`;
}

/**
 * Everything the runtime needs from the sandbox: the service, the host gateway, the audit trail, the hooks
 * the session manager calls, and the handlers behind the desktop-only IPC channels. Nothing here is routed
 * through the remote server — turning isolation on, connecting a registry and allowing a destination are
 * decisions for the machine that runs the agents.
 */
export function createRuntimeSandbox(deps: RuntimeSandboxDeps) {
  const auditStore = createSandboxAuditLogStore(path.join(deps.auditDir, "sandbox-audit-log.db"));
  const audit = createRegistryAudit(auditStore);

  const registriesOfProfile = (profileId: string): RegistryConnection[] =>
    (deps.getState().settings.integrations.registry?.connections ?? []).filter(
      (connection) => (connection.profileId || "default") === profileId,
    );

  const gateway = new SandboxGateway({
    audit,
    fetchImpl: deps.fetchImpl,
    resolveRegistry: (connectionId, profileId) => {
      const connection = registriesOfProfile(profileId).find((item) => item.id === connectionId);
      if (!connection) return null;
      const secret =
        connection.authKind === "none" ? "" : deps.credentialStore.getSecret(registrySecretRef(connection.id));
      if (connection.authKind !== "none" && !secret) return null;
      return { connection, secret };
    },
  });

  const service = new SandboxService({
    dataDir: deps.dataDir,
    gateway,
    platform: deps.platform,
    run: deps.run,
    bundledRuntimeDir: deps.bundledRuntimeDir !== undefined ? deps.bundledRuntimeDir : findBundledSandboxRuntime(),
    tmpDir: deps.tmpDir,
    getRegistries: registriesOfProfile,
    getWorkspaceDomains: (workspaceId) =>
      deps.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.sandboxAllowedDomains ?? [],
    onDenied: (request) => {
      log.info("sandbox is waiting on a destination", { workspaceId: request.workspaceId, host: request.host });
      deps.emit(SANDBOX_DENIED_CHANNEL, request);
    },
    onDeniedSettled: (request) => deps.emit(SANDBOX_DENIED_SETTLED_CHANNEL, request),
  });
  service.writeLauncher();

  const hooks: SessionSandboxHooks = {
    async prepare({ workspace, panel, sessionId }) {
      if (!service.isEligible(workspace, panel)) return false;
      await service.prepare({
        sessionId,
        workspace,
        panel,
        cwd: panel.cwd || workspace.cwd || "",
      });
      return true;
    },
    wrap: ({ workspace, panel, sessionId, launcher, cwd, env }) =>
      service.wrap({ sessionId, workspace, panel, launcher, cwd, env }),
    release: (sessionId) => service.release(sessionId),
  };

  async function addWorkspaceDomain(workspaceId: string, domain: string): Promise<void> {
    await deps.mutate((draft) => {
      const workspace = draft.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) throw new Error("The workspace no longer exists.");
      const current = workspace.sandboxAllowedDomains ?? [];
      if (current.includes(domain)) return;
      if (current.length >= SANDBOX_MAX_WORKSPACE_DOMAINS) {
        throw new Error(`A workspace can allow at most ${SANDBOX_MAX_WORKSPACE_DOMAINS} destinations.`);
      }
      workspace.sandboxAllowedDomains = [...current, domain];
    });
  }

  return {
    service,
    gateway,
    auditStore,
    hooks,

    /**
     * The process description MCP launch builders use for a tab. Unchanged for an ordinary tab; for a sandboxed one
     * it names plain `node` of the sandbox host and maps each path the bridge needs, granting the sandbox read
     * access to exactly that path (a script's package root, or the folder a bridge is told to read).
     */
    processInfoFor<T extends object>(sessionId: string, base: T): T & { sandbox?: SandboxMcpTarget } {
      const environment = service.environmentOf(sessionId);
      if (!environment) return base;
      const sandbox: SandboxMcpTarget = {
        // WSL cannot run the Windows executable, so its bridges run on the distro's own node; a native host keeps the app's.
        nodePath: environment.platform === "win32" ? environment.nodePath : null,
        forwardEnv: SANDBOX_PROXY_ENV_NAMES,
        mapPath: (hostPath) => {
          // A plain node cannot read inside an asar; the app's own executable can, and needs the archive file itself.
          const asar = /^(.*?\.asar)(?:[\\/]|$)/iu.exec(hostPath);
          if (asar && environment.platform === "win32") return null;
          const mapped = environment.platform === "win32" ? (windowsPathToWsl(hostPath)?.path ?? null) : hostPath;
          if (!mapped) return null;
          // A shipped bridge bundle is one file with no dependencies: its own folder is all the sandbox may read.
          const bundled = /[\\/]mcp-bridges[\\/][^\\/]+\.mjs$/iu.test(hostPath);
          service.addReadPaths(
            sessionId,
            asar
              ? [asar[1]]
              : bundled
                ? [path.dirname(hostPath)]
                : isScriptFile(hostPath)
                  ? scriptReadPaths(hostPath)
                  : [hostPath],
          );
          return mapped;
        },
      };
      return { ...base, sandbox };
    },

    getStatus: (request: { force?: boolean; distro?: string } = {}): Promise<SandboxStatus> =>
      service.getStatus(request),

    installPrerequisites: (request: { distro?: string } = {}) => service.installPrerequisites(request.distro),

    listPending: (): SandboxDeniedRequest[] => service.listPending(),
    listAutomationRequests: (workspaceIds: Set<string>): SandboxDeniedRequest[] =>
      service.listAutomationRequests(workspaceIds),

    /**
     * The user's answer to "sandbox wanted X". Allowing with `remember` adds the destination to the
     * workspace's allowlist so the next sandbox of that workspace starts with it; without it the answer
     * covers this session only. A request that was already refused can still be remembered for the workspace,
     * so the next attempt is not asked; any other answer to it is refused, not silently ignored.
     */
    async decide(request: { requestId: string; allow: boolean; remember?: boolean }) {
      const pending = service.getRequest(request.requestId);
      if (pending && (pending.state === "expired" || pending.state === "denied") && request.allow && request.remember) {
        const domain = normalizeSandboxDomain(domainForRequest(pending));
        if (!domain) throw new Error("Only a named host can be remembered for the workspace, not an IP address.");
        await addWorkspaceDomain(pending.workspaceId, domain);
        deps.broadcastState();
        return { ok: true, remembered: domain, late: true };
      }
      if (!pending || pending.state !== "pending") {
        throw new Error("This request has expired: the sandbox already refused the connection.");
      }
      let domain = "";
      if (request.allow && request.remember) {
        domain = normalizeSandboxDomain(domainForRequest(pending)) ?? "";
        if (!domain) throw new Error("Only a named host can be remembered for the workspace, not an IP address.");
        await addWorkspaceDomain(pending.workspaceId, domain);
        deps.broadcastState();
      }
      if (!service.decide(request.requestId, request.allow)) {
        throw new Error("The sandbox that asked is gone.");
      }
      return { ok: true, remembered: domain };
    },

    async saveRegistry(input: RegistrySaveInput & { secret?: string }, windowId: string | undefined) {
      const profileId = deps.getWindowProfileId(windowId) || "default";
      const existing = (deps.getState().settings.integrations.registry?.connections ?? []).find(
        (connection) => connection.id === input.id,
      );
      if (existing && (existing.profileId || "default") !== profileId) {
        throw new Error("This registry belongs to another profile.");
      }
      const connection = validateRegistryInput(input, profileId);
      if (
        connection.authKind !== "none" &&
        !input.secret &&
        !deps.credentialStore.getSecret(registrySecretRef(connection.id))
      ) {
        throw new Error("Enter the token or password for this registry.");
      }
      if (connection.authKind === "none") await deps.credentialStore.deleteSecret(registrySecretRef(connection.id));
      else if (input.secret) {
        await deps.credentialStore.setSecret(registrySecretRef(connection.id), input.secret, {
          requireEncryptedStorage: true,
        });
      }
      await deps.mutate((draft) => {
        const registry = (draft.settings.integrations.registry ??= { connections: [] });
        const index = registry.connections.findIndex((item) => item.id === connection.id);
        if (index >= 0) registry.connections[index] = connection;
        else registry.connections.push(connection);
      });
      deps.broadcastState();
      return { ok: true };
    },

    async deleteRegistry(connectionId: string, windowId: string | undefined) {
      const profileId = deps.getWindowProfileId(windowId) || "default";
      const existing = (deps.getState().settings.integrations.registry?.connections ?? []).find(
        (connection) => connection.id === connectionId,
      );
      if (!existing) return { ok: true };
      if ((existing.profileId || "default") !== profileId) throw new Error("This registry belongs to another profile.");
      await deps.mutate((draft) => {
        const registry = draft.settings.integrations.registry;
        if (registry) registry.connections = registry.connections.filter((item) => item.id !== connectionId);
      });
      await deps.credentialStore.deleteSecret(registrySecretRef(connectionId));
      deps.broadcastState();
      return { ok: true };
    },

    /** Reads the registry the way the gateway will: with the stored sign-in, from the host. */
    async testRegistry(request: { connectionId: string; probePath?: string }, windowId: string | undefined) {
      const profileId = deps.getWindowProfileId(windowId) || "default";
      const connection = registriesOfProfile(profileId).find((item) => item.id === request.connectionId);
      if (!connection) throw new Error("Unknown registry.");
      const secret =
        connection.authKind === "none" ? "" : deps.credentialStore.getSecret(registrySecretRef(connection.id));
      if (connection.authKind !== "none" && !secret) throw new Error("No credential is stored for this registry.");
      const headers: Record<string, string> = { "user-agent": "strIDEterm-registry-test" };
      if (connection.authKind === "basic") {
        headers.authorization = `Basic ${Buffer.from(`${connection.username}:${secret}`).toString("base64")}`;
      } else if (connection.authKind === "bearer") headers.authorization = `Bearer ${secret}`;
      const probe = (request.probePath || "").replace(/^\/+/u, "");
      const target = `${connection.url}/${probe}`;
      try {
        const response = await (deps.fetchImpl ?? fetch)(target, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel().catch(() => undefined);
        const ok = response.status < 400;
        return {
          ok,
          status: response.status,
          message: ok
            ? `The registry answered ${response.status}.`
            : response.status === 401 || response.status === 403
              ? `The registry refused the stored sign-in (${response.status}).`
              : `The registry answered ${response.status}.`,
        };
      } catch (error) {
        return { ok: false, status: 0, message: `The registry could not be reached: ${(error as Error).message}` };
      }
    },

    async shutdown() {
      await service.shutdown();
      auditStore.close();
    },
  };
}

export type RuntimeSandbox = ReturnType<typeof createRuntimeSandbox>;
