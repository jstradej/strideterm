import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { execFileText, parseJsonLines, quotePosixArg } from "./process-utils.js";
import { getLogger } from "./logger.js";
import type {
  DockerState,
  DockerContainer,
  DockerLabels,
  DockerContext,
  DockerImage,
  DockerVolume,
  DockerNetwork,
  DockerBackend as DockerBackendState,
  DockerBackendId,
} from "../shared/types/state.js";

const log = getLogger("docker");

// Internal backend with connection details (extends the public DockerBackend shape).
interface DockerBackend extends DockerBackendState {
  file: string;
  argsPrefix: string[];
}

interface LaunchArgs {
  file: string;
  args: string[];
}

function createUnavailableState(message = "Docker is unavailable."): DockerState {
  return {
    available: false,
    backends: [],
    contexts: [],
    containers: [],
    images: [],
    volumes: [],
    networks: [],
    lazydocker: {},
    error: message,
    lastUpdatedAt: null,
  };
}

export function parseLabels(raw: string): DockerLabels {
  const map: Record<string, string> = {};
  for (const pair of (raw || "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return {
    composeProject: map["com.docker.compose.project"],
    composeService: map["com.docker.compose.service"],
    composeWorkingDir: map["com.docker.compose.project.working_dir"],
    composeConfigFiles: map["com.docker.compose.project.config_files"],
    raw: map,
  };
}

export function deriveHealth(status: string): DockerContainer["health"] {
  if (/\(healthy\)/.test(status)) return "healthy";
  if (/\(unhealthy\)/.test(status)) return "unhealthy";
  if (/\(health: starting\)/.test(status)) return "starting";
  return "none";
}

function runDockerWithBackend(backend: DockerBackend, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (backend.type === "host") {
    return execFileText(backend.file, args);
  }
  const command = ["docker", ...args.map(quotePosixArg)].join(" ");
  return execFileText(backend.file, [...backend.argsPrefix, command]);
}

/**
 * Sanitize a user-supplied path that will appear inside a `docker run` argv
 * vector. We aren't shell-quoting (docker spawns the helper container
 * directly), but we still want to reject path traversal and obviously
 * malicious input. Allowed: forward-slash POSIX paths with [a-zA-Z0-9._-+ /].
 *
 * Returns the normalized path (always starts with `/`, no trailing slash
 * unless it's the root, no `..` segments).
 */
export function sanitizeVolumePath(input: string): string {
  if (!input || input === "/") return "/";
  // Normalize backslashes that might creep in from Windows clients.
  const raw = input.replace(/\\/g, "/").trim();
  if (!/^[\w\-./ +]+$/.test(raw)) {
    throw new Error("Invalid path: only letters, digits, /._- and spaces are allowed");
  }
  const parts = raw.split("/").filter((s) => s && s !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("Path traversal ('..') is not allowed");
  }
  const out = "/" + parts.join("/");
  return out === "//" ? "/" : out;
}

/**
 * Build a sanitized message for an error caught from a docker invocation.
 * Prefers stderr (docker's actual diagnostic) over the generic JS message.
 */
function dockerErrorMessage(err: unknown): string {
  if (!err) return "Unknown docker error";
  const e = err as { stderr?: string; message?: string; code?: number | string };
  // execFileText surfaces stderr separately on non-zero exit
  if (e.stderr && e.stderr.trim()) {
    // Strip noisy lines like "+ docker stop foo" if shell is echoing
    return e.stderr.trim().slice(0, 600);
  }
  if (e.message) return e.message;
  return String(err);
}

/**
 * Standard wrapper for every docker action: logs entry, success, and
 * failure with the operation context so triage is one log line away.
 * Rethrows so the IPC layer can propagate the error to the renderer.
 */
async function runActionLogged<T>(opName: string, ctx: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  log.debug(`docker ${opName} start`, ctx);
  try {
    const result = await fn();
    log.debug(`docker ${opName} ok`, { ...ctx, ms: Date.now() - started });
    return result;
  } catch (err) {
    const msg = dockerErrorMessage(err);
    log.warn(`docker ${opName} failed`, { ...ctx, err: msg, ms: Date.now() - started });
    // Normalize to an Error with the friendly message so the IPC layer
    // serializes a usable string to the renderer (instead of "[object Object]").
    if (err instanceof Error) {
      err.message = msg;
      throw err;
    }
    throw new Error(msg, { cause: err });
  }
}

/**
 * Result of a `docker <thing> prune` invocation. `reclaimed` is the raw
 * human-readable size as printed by docker ("1.234GB"). `deletedNames` lists
 * each identifier docker reported as removed; the UI shows them in the
 * post-prune toast/dialog. `raw` is the full stdout for diagnostics.
 */
export interface PruneResult {
  kind: "image" | "volume" | "network" | "builder";
  deletedNames: string[];
  reclaimed: string;
  raw: string;
}

/**
 * Parse the trailing footer of `docker <thing> prune` output. The format is
 * intentionally loose because it varies by docker version and resource kind
 * (some don't print a "reclaimed" line — e.g. network prune has no size).
 *
 * Body lines look like:
 *   Deleted Images:
 *   untagged: redis:7
 *   deleted: sha256:abcd…
 *   Deleted Volumes:
 *   myvolume
 *   Deleted Networks:
 *   my-bridge
 *   Total reclaimed space: 1.234GB
 *
 * We keep the deleted-names list as everything that isn't a header / footer.
 */
export function parsePruneOutput(stdout: string, kind: PruneResult["kind"]): PruneResult {
  const lines = (stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let reclaimed = "";
  const names: string[] = [];
  for (const line of lines) {
    const m = line.match(/^Total reclaimed space:\s*(.+)$/i);
    if (m) {
      reclaimed = m[1];
      continue;
    }
    if (/^Deleted (Images|Volumes|Networks|build cache objects):/i.test(line)) continue;
    if (line.toLowerCase().startsWith("untagged:")) {
      names.push(line.slice("untagged:".length).trim());
      continue;
    }
    if (line.toLowerCase().startsWith("deleted:")) {
      // `deleted: sha256:abc…` — shorten the digest for display
      const ref = line.slice("deleted:".length).trim();
      names.push(ref.startsWith("sha256:") ? ref.slice(7, 19) : ref);
      continue;
    }
    // Plain entries (volume names, network names, build cache IDs)
    names.push(line);
  }
  return { kind, deletedNames: names, reclaimed, raw: stdout };
}

export class DockerManager extends EventEmitter {
  private snapshot: DockerState;
  private backends: DockerBackend[];
  // Lazydocker backends keyed by backendId.
  private lazydockerBackends: Map<DockerBackendId, DockerBackend>;
  // 5a: in-flight guard — concurrent refresh() callers share one Promise.
  private refreshInFlight: Promise<DockerState> | null = null;
  // 5b: backend/lazydocker detection cache (mutable, cleared on invalidate).
  static readonly BACKEND_DETECTION_TTL_MS = 5 * 60 * 1000;
  private backendDetectionCache: {
    ts: number;
    backends: DockerBackend[];
    lazydockerBackends: Map<DockerBackendId, DockerBackend>;
  } | null = null;

  constructor() {
    super();
    this.snapshot = createUnavailableState();
    this.backends = [];
    this.lazydockerBackends = new Map();
  }

  /** Discard the backend/lazydocker detection cache. Next refresh() re-probes. */
  invalidateBackendDetectionCache(): void {
    this.backendDetectionCache = null;
  }

  getSnapshot(): DockerState {
    return this.snapshot;
  }

  // -----------------------------------------------------------------------
  // Backend detection
  // -----------------------------------------------------------------------

  async detectAllBackends(): Promise<DockerBackend[]> {
    const results = await Promise.allSettled([
      execFileText("docker", ["version", "--format", "{{json .}}"]).then((): DockerBackend => ({
        id: "host",
        type: "host",
        label: "Host",
        available: "ok",
        file: "docker",
        argsPrefix: [],
      })),
      execFileText("wsl.exe", ["-e", "sh", "-lc", "docker version --format '{{json .}}'"]).then((): DockerBackend => ({
        id: "wsl",
        type: "wsl",
        label: "WSL",
        available: "ok",
        file: "wsl.exe",
        argsPrefix: ["-e", "sh", "-lc"],
      })),
    ]);

    return results
      .filter((r): r is PromiseFulfilledResult<DockerBackend> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  async dedupeBackendsByServerId(backends: DockerBackend[]): Promise<DockerBackend[]> {
    if (backends.length < 2) return backends;

    const ids = await Promise.all(
      backends.map(async (b) => {
        try {
          const { stdout } = await this.runDockerForBackend(b, ["info", "--format", "{{.ID}}"]);
          return stdout.trim();
        } catch (err) {
          // Probe failure is expected if daemon is down — keep at debug.
          log.debug("dedupeBackends: server ID probe failed", {
            backendId: b.id,
            err: dockerErrorMessage(err),
          });
          return null;
        }
      }),
    );

    const seen = new Set<string>();
    return backends.filter((b, i) => {
      const sid = ids[i];
      if (!sid) return true; // keep if we couldn't determine
      if (seen.has(sid)) {
        log.debug("dedupeBackends: dropping duplicate backend", { backendId: b.id, serverId: sid });
        return false;
      }
      seen.add(sid);
      return true;
    });
  }

  // Legacy single-backend getter – picks host, falls back to wsl.
  private getPrimaryBackend(): DockerBackend | null {
    return this.backends.find((b) => b.type === "host") ?? this.backends.find((b) => b.type === "wsl") ?? null;
  }

  private getBackendById(id: DockerBackendId): DockerBackend | null {
    return this.backends.find((b) => b.id === id) ?? null;
  }

  // -----------------------------------------------------------------------
  // Docker command runners
  // -----------------------------------------------------------------------

  /** Run docker with an explicit backend (overrideable for tests). */
  protected runDockerForBackend(backend: DockerBackend, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return runDockerWithBackend(backend, args);
  }

  // -----------------------------------------------------------------------
  // Lazydocker detection
  // -----------------------------------------------------------------------

  async detectLazydocker(): Promise<void> {
    for (const backend of this.backends) {
      try {
        if (backend.type === "host") {
          await execFileText("lazydocker", ["--version"]);
          this.lazydockerBackends.set(backend.id, {
            ...backend,
            id: backend.id,
            file: "lazydocker",
            argsPrefix: [],
          });
        } else {
          await execFileText("wsl.exe", [
            "-e",
            "sh",
            "-lc",
            "command -v lazydocker >/dev/null 2>&1 && lazydocker --version",
          ]);
          this.lazydockerBackends.set(backend.id, {
            ...backend,
            id: backend.id,
            file: "wsl.exe",
            argsPrefix: ["-e", "sh", "-lc"],
          });
        }
      } catch (err) {
        // lazydocker not found — expected for most users, keep at debug.
        log.debug("lazydocker probe failed", { backendId: backend.id, err: dockerErrorMessage(err) });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Refresh (multi-backend × multi-context)
  // -----------------------------------------------------------------------

  async refresh(): Promise<DockerState> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const p = this.#doRefreshImpl().finally(() => {
      this.refreshInFlight = null;
    });
    this.refreshInFlight = p;
    return p;
  }

  async #doRefreshImpl(): Promise<DockerState> {
    // Test/E2E hook: when STRIDETERM_DOCKER_MOCK_FILE points to a JSON file we
    // skip CLI detection entirely and return a canned snapshot. This lets the
    // Electron E2E exercise the Docker UI on CI runners that don't have docker
    // installed. The mock file is the renderer-shaped `DockerState`; we trust
    // its contents since it lives next to our test fixtures and is opted into
    // by an env var that the user must explicitly set. Action handlers
    // (start/stop/exec/...) still go through docker CLI — the mock only
    // affects the snapshot.
    const mockFile = process.env.STRIDETERM_DOCKER_MOCK_FILE;
    if (mockFile) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- env-var-opt-in test hook
        const raw = readFileSync(mockFile, "utf8");
        this.snapshot = JSON.parse(raw) as DockerState;
        this.snapshot.lastUpdatedAt = new Date().toISOString();
        this.emit("updated", this.snapshot);
        return this.snapshot;
      } catch (err) {
        log.warn("docker mock file load failed", { mockFile, err: dockerErrorMessage(err) });
        this.snapshot = createUnavailableState(`Mock file load failed: ${dockerErrorMessage(err)}`);
        this.emit("updated", this.snapshot);
        return this.snapshot;
      }
    }

    try {
      // 5b: cache backend/lazydocker detection — re-probe only when cache is
      // absent or expired. Container/image data always fetched fresh.
      const now = Date.now();
      const cacheValid =
        this.backendDetectionCache !== null &&
        now - this.backendDetectionCache.ts < DockerManager.BACKEND_DETECTION_TTL_MS;
      if (cacheValid) {
        this.backends = this.backendDetectionCache!.backends;
        this.lazydockerBackends = this.backendDetectionCache!.lazydockerBackends;
      } else {
        const detected = await this.detectAllBackends();
        this.backends = await this.dedupeBackendsByServerId(detected);
        await this.detectLazydocker();
        this.backendDetectionCache = { ts: now, backends: this.backends, lazydockerBackends: this.lazydockerBackends };
      }

      if (this.backends.length === 0) {
        this.snapshot = createUnavailableState("Docker CLI was not found on Windows PATH or inside WSL.");
        this.emit("updated", this.snapshot);
        return this.snapshot;
      }

      // Fetch contexts + containers for every backend concurrently.
      // Use Promise.allSettled so one failing backend doesn't abort the rest.
      const backendResults = await Promise.allSettled(
        this.backends.map((backend) => this.#doFetchBackendData(backend)),
      );

      const allContexts: DockerContext[] = [];
      const allContainers: DockerContainer[] = [];
      const allImages: DockerImage[] = [];
      const allVolumes: DockerVolume[] = [];
      const allNetworks: DockerNetwork[] = [];
      const lazydocker: DockerState["lazydocker"] = {};

      const publicBackends: DockerState["backends"] = this.backends.map((b) => ({
        id: b.id,
        type: b.type,
        label: b.label,
        available: "ok" as const,
      }));

      for (let i = 0; i < this.backends.length; i++) {
        const backend = this.backends[i];
        const result = backendResults[i];

        const ldBackend = this.lazydockerBackends.get(backend.id);
        lazydocker[backend.id] = {
          available: Boolean(ldBackend),
          error: ldBackend ? "" : "Lazydocker executable was not found in the active Docker environment.",
        };

        if (result.status === "rejected") {
          // Backend failed – mark error but continue.
          publicBackends[i] = { ...publicBackends[i], available: "error", error: String(result.reason) };
          continue;
        }

        const { contexts, containers, images, volumes, networks } = result.value;
        allContexts.push(...contexts);
        allContainers.push(...containers);
        allImages.push(...images);
        allVolumes.push(...volumes);
        allNetworks.push(...networks);
      }

      this.snapshot = {
        available: true,
        backends: publicBackends,
        contexts: allContexts,
        containers: allContainers,
        images: allImages,
        volumes: allVolumes,
        networks: allNetworks,
        lazydocker,
        error: "",
        lastUpdatedAt: new Date().toISOString(),
      };
    } catch (error) {
      const msg = dockerErrorMessage(error);
      // Refresh failure is most commonly "docker not installed yet" on first
      // launch — debug level. If it persists after backends were detected,
      // surface at warn so it shows up in support bundles.
      const level: "debug" | "warn" = this.backends.length > 0 ? "warn" : "debug";
      log[level]("docker refresh failed", { err: msg, hadBackends: this.backends.length > 0 });
      this.snapshot = createUnavailableState(msg);
    }

    this.emit("updated", this.snapshot);
    return this.snapshot;
  }

  async #doFetchBackendData(backend: DockerBackend): Promise<{
    contexts: DockerContext[];
    containers: DockerContainer[];
    images: DockerImage[];
    volumes: DockerVolume[];
    networks: DockerNetwork[];
  }> {
    const { stdout: ctxRaw } = await runDockerWithBackend(backend, ["context", "ls", "--format", "{{json .}}"]);

    const rawContexts = parseJsonLines(ctxRaw) as Array<{
      Name: string;
      DockerEndpoint: string;
      Current: boolean;
    }>;

    const contexts: DockerContext[] = rawContexts.map((c) => ({
      Name: c.Name,
      DockerEndpoint: c.DockerEndpoint,
      Current: Boolean(c.Current),
      backendId: backend.id,
      available: "pending" as const,
    }));

    // Fetch containers + images + volumes + networks per context concurrently.
    // We bundle four calls per context so one slow context doesn't serialize
    // the rest. images/volumes/networks tolerate failure (some contexts —
    // e.g. a paused colima — refuse those subcommands).
    const softFetch = (
      sub: "images" | "volumes" | "networks",
      ctxName: string,
      args: string[],
    ): Promise<{ stdout: string; stderr: string }> =>
      runDockerWithBackend(backend, args).catch((err) => {
        // Falls back to empty list but log so support can diagnose why
        // a section is empty when the user expected entries.
        log.debug(`backend ${sub} fetch failed`, {
          backendId: backend.id,
          contextName: ctxName,
          err: dockerErrorMessage(err),
        });
        return { stdout: "", stderr: "" };
      });
    const contextResults = await Promise.allSettled(
      rawContexts.map((c) =>
        Promise.all([
          runDockerWithBackend(backend, ["--context", c.Name, "ps", "-a", "--no-trunc", "--format", "{{json .}}"]),
          softFetch("images", c.Name, ["--context", c.Name, "images", "--format", "{{json .}}"]),
          softFetch("volumes", c.Name, ["--context", c.Name, "volume", "ls", "--format", "{{json .}}"]),
          softFetch("networks", c.Name, ["--context", c.Name, "network", "ls", "--format", "{{json .}}"]),
        ]),
      ),
    );

    const allContainers: DockerContainer[] = [];
    const allImages: DockerImage[] = [];
    const allVolumes: DockerVolume[] = [];
    const allNetworks: DockerNetwork[] = [];
    for (let i = 0; i < rawContexts.length; i++) {
      const ctx = rawContexts[i];
      const res = contextResults[i];
      if (res.status === "rejected") {
        contexts[i].available = "error";
        contexts[i].error = String(res.reason);
        continue;
      }
      contexts[i].available = "ok";
      const [psRes, imgRes, volRes, netRes] = res.value;
      const raw = parseJsonLines(psRes.stdout) as DockerContainer[];
      const enriched = raw.map((c) => ({
        ...c,
        Labels: c.Labels ?? "",
        parsedLabels: parseLabels(String(c.Labels ?? "")),
        health: deriveHealth(String(c.Status ?? "")),
        backendId: backend.id,
        contextName: ctx.Name,
      }));
      contexts[i].containerCount = enriched.length;
      allContainers.push(...enriched);

      const rawImages = parseJsonLines(imgRes.stdout) as Array<Partial<DockerImage> & { ID?: string }>;
      for (const img of rawImages) {
        allImages.push({
          ID: String(img.ID ?? ""),
          Repository: String(img.Repository ?? "<none>"),
          Tag: String(img.Tag ?? "<none>"),
          CreatedSince: String(img.CreatedSince ?? ""),
          Size: String(img.Size ?? ""),
          backendId: backend.id,
          contextName: ctx.Name,
        });
      }

      const rawVolumes = parseJsonLines(volRes.stdout) as Array<Partial<DockerVolume> & { Name?: string }>;
      for (const vol of rawVolumes) {
        allVolumes.push({
          Name: String(vol.Name ?? ""),
          Driver: String(vol.Driver ?? "local"),
          Mountpoint: vol.Mountpoint ? String(vol.Mountpoint) : undefined,
          Scope: vol.Scope ? String(vol.Scope) : undefined,
          backendId: backend.id,
          contextName: ctx.Name,
        });
      }

      const rawNetworks = parseJsonLines(netRes.stdout) as Array<Partial<DockerNetwork> & { ID?: string }>;
      for (const net of rawNetworks) {
        allNetworks.push({
          ID: String(net.ID ?? ""),
          Name: String(net.Name ?? ""),
          Driver: String(net.Driver ?? "bridge"),
          Scope: net.Scope ? String(net.Scope) : undefined,
          CreatedAt: net.CreatedAt ? String(net.CreatedAt) : undefined,
          backendId: backend.id,
          contextName: ctx.Name,
        });
      }
    }

    return {
      contexts,
      containers: allContainers,
      images: allImages,
      volumes: allVolumes,
      networks: allNetworks,
    };
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async performAction(
    action: string,
    containerId: string,
    backendId?: DockerBackendId,
    contextName?: string,
  ): Promise<DockerState> {
    const actionToArgs: Record<string, string[]> = {
      start: ["start"],
      stop: ["stop"],
      restart: ["restart"],
      remove: ["rm", "-f"],
    };

    const baseArgs = actionToArgs[action];
    if (!baseArgs) {
      throw new Error(`Unsupported Docker action: ${action}`);
    }

    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) {
      throw new Error("Docker backend is not available.");
    }

    const args = contextName ? ["--context", contextName, ...baseArgs, containerId] : [...baseArgs, containerId];

    return runActionLogged(
      `container.${action}`,
      { containerId, backendId: backend.id, contextName: contextName ?? null },
      async () => {
        await this.runDockerForBackend(backend, args);
        return this.refresh();
      },
    );
  }

  findContainer(containerId: string): DockerContainer | null {
    return this.snapshot.containers.find((c) => c.ID === containerId) ?? null;
  }

  async inspectContainer(containerId: string, backendId?: DockerBackendId, contextName?: string): Promise<string> {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) throw new Error("Docker backend is not available.");
    const args = contextName ? ["--context", contextName, "inspect", containerId] : ["inspect", containerId];
    return runActionLogged(
      "container.inspect",
      { containerId, backendId: backend.id, contextName: contextName ?? null },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  async topContainer(containerId: string, backendId?: DockerBackendId, contextName?: string): Promise<string> {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) throw new Error("Docker backend is not available.");
    const args = contextName ? ["--context", contextName, "top", containerId] : ["top", containerId];
    return runActionLogged(
      "container.top",
      { containerId, backendId: backend.id, contextName: contextName ?? null },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  async inspectImage(imageId: string, backendId?: DockerBackendId, contextName?: string): Promise<string> {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) throw new Error("Docker backend is not available.");
    const args = contextName ? ["--context", contextName, "image", "inspect", imageId] : ["image", "inspect", imageId];
    return runActionLogged(
      "image.inspect",
      { imageId, backendId: backend.id, contextName: contextName ?? null },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  async inspectVolume(volumeName: string, backendId?: DockerBackendId, contextName?: string): Promise<string> {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) throw new Error("Docker backend is not available.");
    const args = contextName
      ? ["--context", contextName, "volume", "inspect", volumeName]
      : ["volume", "inspect", volumeName];
    return runActionLogged(
      "volume.inspect",
      { volumeName, backendId: backend.id, contextName: contextName ?? null },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  async inspectNetwork(networkId: string, backendId?: DockerBackendId, contextName?: string): Promise<string> {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) throw new Error("Docker backend is not available.");
    const args = contextName
      ? ["--context", contextName, "network", "inspect", networkId]
      : ["network", "inspect", networkId];
    return runActionLogged(
      "network.inspect",
      { networkId, backendId: backend.id, contextName: contextName ?? null },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  async removeImage(imageId: string, backendId: DockerBackendId, contextName: string, force = false): Promise<void> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const args = force
      ? ["--context", contextName, "image", "rm", "-f", imageId]
      : ["--context", contextName, "image", "rm", imageId];
    await runActionLogged("image.remove", { imageId, backendId, contextName, force }, async () => {
      await this.runDockerForBackend(backend, args);
    });
    await this.refresh();
  }

  async removeVolume(
    volumeName: string,
    backendId: DockerBackendId,
    contextName: string,
    force = false,
  ): Promise<void> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const args = force
      ? ["--context", contextName, "volume", "rm", "-f", volumeName]
      : ["--context", contextName, "volume", "rm", volumeName];
    await runActionLogged("volume.remove", { volumeName, backendId, contextName, force }, async () => {
      await this.runDockerForBackend(backend, args);
    });
    await this.refresh();
  }

  async removeNetwork(networkId: string, backendId: DockerBackendId, contextName: string): Promise<void> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    await runActionLogged("network.remove", { networkId, backendId, contextName }, async () => {
      await this.runDockerForBackend(backend, ["--context", contextName, "network", "rm", networkId]);
    });
    await this.refresh();
  }

  async pullImage(reference: string, backendId: DockerBackendId, contextName: string): Promise<void> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    await runActionLogged("image.pull", { reference, backendId, contextName }, async () => {
      await this.runDockerForBackend(backend, ["--context", contextName, "pull", reference]);
    });
    await this.refresh();
  }

  // ---------------------------------------------------------------------------
  // Prune helpers
  //
  // Each prune wraps the corresponding `docker <thing> prune --force` command
  // and parses the trailing "Total reclaimed space: …" line. The deleted-items
  // list is whatever docker prints between the header and that footer; useful
  // for the confirmation/result dialog so the user sees exactly what was freed.
  //
  // `--force` (-f) here only skips the interactive "Are you sure?" prompt — the
  // confirmation happens in the UI before we invoke this. We never pass `--all`
  // by default to image prune; the caller decides whether to include in-use-by-
  // stopped-containers images.
  // ---------------------------------------------------------------------------

  async pruneImages(
    backendId: DockerBackendId,
    contextName: string,
    options?: { all?: boolean },
  ): Promise<PruneResult> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const args = ["--context", contextName, "image", "prune", "--force"];
    if (options?.all) args.push("--all");
    const r = await runActionLogged("image.prune", { backendId, contextName, all: !!options?.all }, async () =>
      this.runDockerForBackend(backend, args),
    );
    await this.refresh();
    return parsePruneOutput(r.stdout, "image");
  }

  async pruneVolumes(backendId: DockerBackendId, contextName: string): Promise<PruneResult> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const args = ["--context", contextName, "volume", "prune", "--force"];
    const r = await runActionLogged("volume.prune", { backendId, contextName }, async () =>
      this.runDockerForBackend(backend, args),
    );
    await this.refresh();
    return parsePruneOutput(r.stdout, "volume");
  }

  async pruneNetworks(backendId: DockerBackendId, contextName: string): Promise<PruneResult> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const args = ["--context", contextName, "network", "prune", "--force"];
    const r = await runActionLogged("network.prune", { backendId, contextName }, async () =>
      this.runDockerForBackend(backend, args),
    );
    await this.refresh();
    return parsePruneOutput(r.stdout, "network");
  }

  async pruneBuilder(
    backendId: DockerBackendId,
    contextName: string,
    options?: { all?: boolean },
  ): Promise<PruneResult> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const args = ["--context", contextName, "builder", "prune", "--force"];
    if (options?.all) args.push("--all");
    const r = await runActionLogged("builder.prune", { backendId, contextName, all: !!options?.all }, async () =>
      this.runDockerForBackend(backend, args),
    );
    await this.refresh();
    return parsePruneOutput(r.stdout, "builder");
  }

  /**
   * Browse files inside a volume by spawning a short-lived helper container
   * that mounts the volume read-only and runs `find`/`ls`/`cat`. Image used
   * is `busybox` (~5 MB, fast pull). The volume is mounted at `/_vol` inside
   * the helper. Returned data is whatever the helper prints to stdout.
   *
   * `subPath` is an absolute-ish path inside the volume, validated to prevent
   * argument injection (no shell quoting needed because we pass argv directly
   * to docker, which forwards each arg verbatim into the container).
   */
  async volumeListPath(
    volumeName: string,
    backendId: DockerBackendId,
    contextName: string,
    subPath: string,
  ): Promise<string> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const safePath = sanitizeVolumePath(subPath);
    // `find -mindepth 1 -maxdepth 1 -printf "..."` works on most coreutils,
    // but busybox find doesn't support `-printf`. We use stat-via-ls instead,
    // which busybox supports.
    const inside = `/_vol${safePath === "/" ? "" : safePath}`;
    // Single-quote the path so spaces don't word-split (sanitizeVolumePath
    // allows ' ' but explicitly rejects "'" so we can't break out).
    const quotedInside = `'${inside}'`;
    // `-A` shows hidden files but skips `. ..`. `-l` long format with size.
    // `-1` would lose size; we keep `-la` and parse on the renderer side.
    const args = [
      "--context",
      contextName,
      "run",
      "--rm",
      "-v",
      `${volumeName}:/_vol:ro`,
      "busybox",
      "sh",
      "-c",
      `ls -la --color=never ${quotedInside} 2>&1 | head -n 500`,
    ];
    return runActionLogged(
      "volume.list",
      { volumeName, backendId, contextName, subPath: safePath },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  /**
   * Read a single text file out of a volume (capped to 64 KiB to keep IPC
   * payloads sane and to avoid streaming binary garbage into xterm).
   */
  async volumeReadFile(
    volumeName: string,
    backendId: DockerBackendId,
    contextName: string,
    subPath: string,
  ): Promise<string> {
    const backend = this.getBackendById(backendId);
    if (!backend) throw new Error(`Unknown backend: ${backendId}`);
    const safePath = sanitizeVolumePath(subPath);
    if (safePath === "/") throw new Error("Cannot read root as a file.");
    const inside = `/_vol${safePath}`;
    // Single-quote the path so spaces don't word-split (sanitizeVolumePath
    // allows ' ' but explicitly rejects "'" so we can't break out).
    const q = `'${inside}'`;
    // `head -c 65536` caps payload. We add a sentinel suffix so the renderer
    // can tell whether the output was truncated.
    const args = [
      "--context",
      contextName,
      "run",
      "--rm",
      "-v",
      `${volumeName}:/_vol:ro`,
      "busybox",
      "sh",
      "-c",
      `if [ -d ${q} ]; then echo "<DIR>"; exit 0; fi; ` +
        `size=$(stat -c %s ${q} 2>/dev/null || echo 0); ` +
        `head -c 65536 ${q}; ` +
        `if [ "$size" -gt 65536 ]; then echo; echo "--- truncated after 64 KiB (file size: $size bytes) ---"; fi`,
    ];
    return runActionLogged(
      "volume.read",
      { volumeName, backendId, contextName, subPath: safePath },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  /**
   * `docker system df --format "{{json .}}"`. Older docker versions emit one
   * JSON line per type (Images / Containers / Local Volumes / Build Cache).
   * Returns the raw stdout — UI parses it; failure leaves caller to handle.
   */
  async systemDf(backendId?: DockerBackendId, contextName?: string): Promise<string> {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) throw new Error("Docker backend is not available.");
    const args = contextName
      ? ["--context", contextName, "system", "df", "--format", "{{json .}}"]
      : ["system", "df", "--format", "{{json .}}"];
    return runActionLogged(
      "system.df",
      { backendId: backend.id, contextName: contextName ?? null },
      async () => (await this.runDockerForBackend(backend, args)).stdout,
    );
  }

  async statsContainer(
    containerId: string,
    backendId?: DockerBackendId,
    contextName?: string,
  ): Promise<{
    cpuPerc: string;
    memUsage: string;
    memPerc: string;
    netIO: string;
    blockIO: string;
    pids: string;
  } | null> {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) throw new Error("Docker backend is not available.");
    const args = contextName
      ? ["--context", contextName, "stats", "--no-stream", "--format", "{{json .}}", containerId]
      : ["stats", "--no-stream", "--format", "{{json .}}", containerId];
    const { stdout } = await runActionLogged(
      "container.stats",
      { containerId, backendId: backend.id, contextName: contextName ?? null },
      async () => this.runDockerForBackend(backend, args),
    );
    const lines = parseJsonLines(stdout) as Array<{
      CPUPerc?: string;
      MemUsage?: string;
      MemPerc?: string;
      NetIO?: string;
      BlockIO?: string;
      PIDs?: string;
    }>;
    if (lines.length === 0) return null;
    const s = lines[0];
    return {
      cpuPerc: s.CPUPerc ?? "",
      memUsage: s.MemUsage ?? "",
      memPerc: s.MemPerc ?? "",
      netIO: s.NetIO ?? "",
      blockIO: s.BlockIO ?? "",
      pids: s.PIDs ?? "",
    };
  }

  getBackendForLogs(
    backendId: DockerBackendId,
  ): { id: DockerBackendId; type: "host" | "wsl"; file: string; argsPrefix: string[] } | null {
    return this.getBackendById(backendId) ?? null;
  }

  // -----------------------------------------------------------------------
  // Launch helpers
  // -----------------------------------------------------------------------

  private buildLaunchArgs(backend: DockerBackend, args: string[]): LaunchArgs {
    if (backend.type === "host") {
      return { file: backend.file, args };
    }
    const command = ["docker", ...args.map(quotePosixArg)].join(" ");
    return { file: backend.file, args: [...backend.argsPrefix, command] };
  }

  createShellLaunch(containerId: string, backendId?: DockerBackendId, contextName?: string): LaunchArgs | null {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) return null;
    const shellCommand = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";
    const dockerArgs = contextName
      ? ["--context", contextName, "exec", "-it", containerId, "sh", "-lc", shellCommand]
      : ["exec", "-it", containerId, "sh", "-lc", shellCommand];
    return this.buildLaunchArgs(backend, dockerArgs);
  }

  createLogsLaunch(containerId: string, backendId?: DockerBackendId, contextName?: string): LaunchArgs | null {
    const backend = backendId ? this.getBackendById(backendId) : this.getPrimaryBackend();
    if (!backend) return null;
    const dockerArgs = contextName
      ? ["--context", contextName, "logs", "-f", containerId]
      : ["logs", "-f", containerId];
    return this.buildLaunchArgs(backend, dockerArgs);
  }

  createLazydockerLaunch(backendId?: DockerBackendId): LaunchArgs | null {
    const ldBackend = backendId
      ? this.lazydockerBackends.get(backendId)
      : (this.lazydockerBackends.values().next().value ?? null);

    if (!ldBackend) return null;

    if (ldBackend.type === "host") {
      return { file: ldBackend.file, args: [] };
    }
    return { file: ldBackend.file, args: [...ldBackend.argsPrefix, "lazydocker"] };
  }

}
