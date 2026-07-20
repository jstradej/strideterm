/// <reference types="node" />
import path from "node:path";
import { execFileText } from "./process-utils.js";
import { createAzureApi } from "./azure-devops-api.js";
import type {
  AzurePipelineSummary,
  AzureBuildRef,
  AzurePipelineRun,
  AzurePipelineRunSeed,
  AzurePipelineParameterDef,
  AzurePipelineRefs,
  AzurePipelineCommit,
  AzureRunDetail,
} from "../shared/types/azure-pipelines.js";
import { BaseProviderManager } from "./shared/base-manager.js";
import type { CredentialStore } from "./shared/credential-store.js";
import { classifyAzureRequest, parseAzureUrl } from "./azure-audit-log-store.js";
import { buildPullRequestSummary, findWorkspaceForPullRequest } from "./azure-devops-pr-summary.js";
import {
  buildReviewActivityEvent,
  diffSignatureKeys,
  filterNewComments,
  parseAzureVoteSignature,
  seedNotifiedTimestamp,
  truncateBody,
} from "./shared/review-activity.js";
import {
  AZURE_REVIEW_ICON,
  AZURE_REVIEW_COLOR,
  getDefaultReviewRoot,
  clone,
  identityMatches,
  sanitizePathSegment,
  normalizeReviewRoot,
  createPullRequestKey,
  stripRefsPrefix,
  firstNonEmpty,
  normalizeRemoteUrl,
  buildRepositoryRemoteUrl,
  sanitizeGitEnvironment,
  shortPathKey,
  formatReviewWorkspaceError,
  buildCheckSummary,
  createConnectionSnapshot,
  normalizeConnectionInput,
} from "./azure-devops-utils.js";

// ─── Local type aliases ──────────────────────────────────────────────────────

interface AzureConnection {
  id: string;
  label?: string;
  orgUrl: string;
  login: string;
  tokenRef: string;
  enabled?: boolean;
  projectFilters?: string[];
  repositoryFilters?: string[];
  pollSeconds?: number;
  reviewRoot?: string;
  [key: string]: unknown;
}

interface AzureConnectionInput {
  id?: string;
  orgUrl?: string;
  login?: string;
  pat?: string;
  tokenRef?: string;
  enabled?: boolean;
  projectFilters?: string[];
  repositoryFilters?: string[];
  pollSeconds?: number;
  reviewRoot?: string;
  [key: string]: unknown;
}

interface AzureProject {
  id: string;
  name: string;
  description?: string;
  state?: string;
  [key: string]: unknown;
}

interface AzurePrSummary {
  prKey: string;
  connectionId: string;
  orgUrl?: string;
  role?: string;
  provider?: string;
  project?: { id: string; name: string };
  repository?: { id: string; name: string; remoteUrl?: string };
  pullRequest?: {
    id: string | number;
    title?: string;
    status?: string;
    mergeStatus?: string;
    sourceRefName?: string;
    targetRefName?: string;
    sourceCommitId?: string;
    closedDate?: string;
    webUrl?: string;
  };
  author?: { displayName?: string; uniqueName?: string };
  myReviewerId?: string;
  threads?: AzureThread[];
  changedFiles?: unknown[];
  localChangedFiles?: { changeType: string; path: string }[];
  checks?: {
    items?: AzureCheckItem[];
    failedCount?: number;
    pendingCount?: number;
    passedCount?: number;
    optionalFailedCount?: number;
    requiredFailedCount?: number;
  };
  hasAttention?: boolean;
  attentionReason?: string;
  newCommentsCount?: number;
  unresolvedThreadCount?: number;
  lastRemoteActivityAt?: string | null;
  lastSeenActivityAt?: string | null;
  lastActivityAt?: string | null;
  reviewWorkspaceId?: string;
  existingWorkspaceId?: string;
  [key: string]: unknown;
}

interface AzureThread {
  id?: number | string;
  status?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  publishedDate?: string;
  lastUpdatedDate?: string;
  comments?: AzureComment[];
  [key: string]: unknown;
}

interface AzureComment {
  id?: number | string;
  content?: string;
  parentCommentId?: number;
  commentType?: string | number;
  author?: { id?: string; displayName?: string; uniqueName?: string; mailAddress?: string };
  publishedDate?: string;
  lastUpdatedDate?: string;
  threadId?: number | string;
  threadStatus?: string;
  [key: string]: unknown;
}

interface AzureCheckItem {
  id?: string;
  kind?: string;
  evaluationId?: string | null;
  name?: string;
  state?: string;
  buildId?: string | number | null;
  errorMessage?: string;
  [key: string]: unknown;
}

interface TrackedPullRequest {
  key?: string;
  connectionId?: string;
  pullRequestId?: string | number;
  repositoryId?: string;
  projectName?: string;
  repositoryName?: string;
  reviewWorkspaceId?: string;
  lastRemoteActivityAt?: string | null;
  lastVoteSignature?: string | null;
  lastMergeStatus?: string | null;
  lastSourceCommitId?: string | null;
  lastSeenActivityAt?: string | null;
  lastNotifiedActivityAt?: string | null;
  [key: string]: unknown;
}

interface AzureReviewStore {
  getState(): {
    connections?: Record<
      string,
      { status?: string; lastError?: string; lastSyncAt?: string | null; lastSuccessAt?: string | null }
    >;
    trackedPullRequests?: Record<string, TrackedPullRequest>;
  };
  getTrackedPullRequest(key: string): TrackedPullRequest | null;
  upsertTrackedPullRequest(key: string, patch: Partial<TrackedPullRequest>): Promise<void>;
  upsertConnectionState(
    connectionId: string,
    patch: { status: string; lastError?: string; lastSyncAt?: string; lastSuccessAt?: string },
  ): Promise<void>;
}

interface AzureReviewBridgeStore {
  syncPullRequest?(summary: AzurePrSummary): Promise<void>;
  markPullRequestSeen?(prKey: string, lastSeenActivityAt: string): Promise<void>;
}

interface AzureAuditLogStore {
  logEntry(entry: Record<string, unknown>): void;
}

interface ReviewCheckout {
  mode?: string;
  rootPath: string;
  cacheRepoPath?: string;
}

interface ReviewWorkspace {
  id: string;
  name?: string;
  kind?: string;
  profileId?: string;
  cwd?: string;
  panels?: unknown[];
  review?: {
    provider?: string;
    prKey?: string;
    connectionId?: string;
    project?: { id?: string; name?: string };
    repository?: { id?: string; name?: string; remoteUrl?: string };
    pullRequest?: {
      sourceRefName?: string;
      targetRefName?: string;
      id?: string | number;
      title?: string;
      status?: string;
    };
    checkout?: ReviewCheckout;
    parentWorkspaceId?: string;
    role?: string;
    writable?: boolean;
    orgUrl?: string;
  };
  quickfix?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AzureManagerOptions {
  credentialStore: CredentialStore;
  reviewStore: AzureReviewStore;
  reviewBridgeStore?: AzureReviewBridgeStore | null;
  auditLogStore?: AzureAuditLogStore | null;
  fetchImpl?: typeof globalThis.fetch;
  execFileTextImpl?: typeof execFileText;
  now?: () => number;
}

interface AuditRaw {
  method?: string;
  url?: string;
  statusCode?: number;
  success?: boolean;
  errorMessage?: string;
  durationMs?: number;
}

// Typed return of createAzureApi (inferred from the factory)
type AzureApi = ReturnType<typeof createAzureApi>;

export class AzureDevOpsManager extends BaseProviderManager {
  declare reviewStore: AzureReviewStore;
  declare reviewBridgeStore: AzureReviewBridgeStore | null;
  declare auditLogStore: AzureAuditLogStore | null;

  /** Cached pipeline parameter schemas, keyed by connection:project:pipeline:branch. */
  private paramSchemaCache = new Map<string, { at: number; defs: AzurePipelineParameterDef[] }>();
  // A pipeline's YAML parameters change rarely (only on a definition edit), so a
  // long TTL is fine; the cache is in-memory and cleared on restart anyway.
  private static readonly PARAM_SCHEMA_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

  get azureApi(): AzureApi {
    return this.api as AzureApi;
  }

  findAzureConnection(connectionId: string): AzureConnection | null {
    return this.findConnection(connectionId) as AzureConnection | null;
  }

  resolveAzureConnectionAndToken(connectionId: string): { connection: AzureConnection; token: string } {
    const result = this.resolveConnectionAndToken(connectionId);
    return { connection: result.connection as AzureConnection, token: result.token };
  }

  constructor(
    {
      credentialStore,
      reviewStore,
      reviewBridgeStore = null,
      auditLogStore = null,
      fetchImpl = globalThis.fetch,
      execFileTextImpl = execFileText,
      now = () => Date.now(),
    }: AzureManagerOptions = {} as AzureManagerOptions,
  ) {
    super({
      credentialStore,
      reviewStore,
      reviewBridgeStore,
      auditLogStore,
      fetchImpl,
      execFileTextImpl,
      now,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createApi: createAzureApi as any,
    });
    this.providerLabel = "azure-devops";
    this.defaultGitLogin = "";
    this.connectionNotFoundMessage = "Azure DevOps connection was not found.";
    this.syncErrorFallbackMessage = "Azure sync failed.";
    this.reviewIcon = AZURE_REVIEW_ICON;
    this.reviewColor = AZURE_REVIEW_COLOR;
    this.parentWorkspaceKind = "azure";
    this.providerDisplayName = "Azure DevOps";
    this.getDefaultReviewRoot = getDefaultReviewRoot;
  }

  /**
   * Log an Azure DevOps API call to the audit store.
   * Enriches raw request data with current audit context and URL classification.
   */
  override _logAudit(raw: AuditRaw): void {
    if (!this.auditLogStore) return;
    const classification = classifyAzureRequest(raw.method, raw.url);
    const urlInfo = parseAzureUrl(raw.url);
    this.auditLogStore.logEntry({
      ...classification,
      timestamp: new Date().toISOString(),
      connectionId: this._auditConnectionId,
      organization: urlInfo.organization,
      project: urlInfo.project,
      method: raw.method || "GET",
      url: raw.url || "",
      statusCode: raw.statusCode,
      success: raw.success !== false,
      errorMessage: raw.errorMessage || null,
      durationMs: raw.durationMs ?? null,
      userInitiated: this._auditUserInitiated,
    });
  }

  async verifyConnection(
    connectionInput: AzureConnectionInput,
  ): Promise<{ ok: boolean; organization: string; projectCount: number; projects: AzureProject[] }> {
    this.setAuditContext({ connectionId: connectionInput.id || "", userInitiated: true });
    const connection = normalizeConnectionInput(connectionInput);
    const token = String(connectionInput.pat || "").trim();
    if (!connection.orgUrl || !connection.login || !token) {
      throw new Error("Organization URL, login, and PAT are required.");
    }

    const projects = await this.azureApi.listProjects(connection, token);
    return {
      ok: true,
      organization: connection.orgUrl,
      projectCount: projects.length,
      projects: (projects as AzureProject[]).map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description || "",
        state: project.state || "",
      })),
    };
  }

  // --- Pipelines tab (Build definitions + Pipelines run API) ---

  /** List pipelines (build definitions) with their latest run, honoring projectFilters. */
  async listPipelines({ connectionId }: { connectionId: string }): Promise<AzurePipelineSummary[]> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });

    const toBuildRef = (raw: unknown): AzureBuildRef | undefined => {
      const b = raw as {
        id?: number | string;
        buildNumber?: string;
        status?: string;
        result?: string;
        sourceBranch?: string;
        queueTime?: string;
        startTime?: string;
        finishTime?: string;
        requestedFor?: { displayName?: string };
        reason?: string;
        sourceVersion?: string;
        _links?: { web?: { href?: string } };
      } | null;
      if (!b || b.id == null) return undefined;
      return {
        id: Number(b.id),
        buildNumber: b.buildNumber || String(b.id),
        status: b.status || "",
        result: b.result || undefined,
        sourceBranch: b.sourceBranch || "",
        queueTime: b.queueTime,
        startTime: b.startTime,
        finishTime: b.finishTime,
        requestedFor: b.requestedFor?.displayName || undefined,
        reason: b.reason || undefined,
        sourceVersion: b.sourceVersion || undefined,
        webUrl: b._links?.web?.href || "",
      };
    };

    const projects = (await this.azureApi.listProjects(connection, token)) as AzureProject[];
    const filteredProjects = connection.projectFilters?.length
      ? projects.filter(
          (project) =>
            connection.projectFilters!.includes(project.name) || connection.projectFilters!.includes(project.id),
        )
      : projects;

    const pipelines: AzurePipelineSummary[] = [];
    for (const project of filteredProjects) {
      const definitions = (await this.azureApi.listBuildDefinitionsWithLatest(
        connection,
        token,
        project.name,
      )) as Array<{
        id?: number | string;
        name?: string;
        path?: string;
        queueStatus?: string;
        url?: string;
        _links?: { web?: { href?: string } };
        project?: { id?: string; name?: string };
        latestBuild?: unknown;
      }>;
      for (const def of definitions) {
        if (def.id == null) continue;
        pipelines.push({
          connectionId,
          project: { id: def.project?.id || project.id, name: def.project?.name || project.name },
          id: Number(def.id),
          name: def.name || `#${def.id}`,
          folder: def.path || "",
          queueStatus: def.queueStatus || "enabled",
          webUrl: def._links?.web?.href || def.url || "",
          lastRun: toBuildRef(def.latestBuild),
        });
      }
    }
    return pipelines;
  }

  /**
   * Recent runs for a single pipeline (for the expand view). Sourced from the
   * Build API so each run carries who/branch/commit/timing — `state` is filled
   * from the build `status` to keep the status-icon logic unchanged.
   */
  async listPipelineRuns({
    connectionId,
    projectName,
    pipelineId,
  }: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
  }): Promise<AzurePipelineRun[]> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });
    const builds = (await this.azureApi.listBuildsByDefinition(connection, token, projectName, pipelineId)) as Array<{
      id?: number | string;
      buildNumber?: string;
      status?: string;
      result?: string;
      queueTime?: string;
      startTime?: string;
      finishTime?: string;
      sourceBranch?: string;
      sourceVersion?: string;
      requestedFor?: { displayName?: string };
      _links?: { web?: { href?: string } };
    }>;
    return builds
      .filter((b) => b.id != null)
      .map((b) => ({
        id: Number(b.id),
        name: b.buildNumber || `#${b.id}`,
        state: b.status || "",
        result: b.result || undefined,
        createdDate: b.startTime || b.queueTime,
        finishedDate: b.finishTime,
        requestedFor: b.requestedFor?.displayName || undefined,
        sourceBranch: b.sourceBranch || undefined,
        sourceVersion: b.sourceVersion || undefined,
        startTime: b.startTime,
        finishTime: b.finishTime,
        webUrl: b._links?.web?.href || "",
      }));
  }

  /**
   * On-demand detail for one run: its stages and surfaced errors, derived from a
   * single build-timeline fetch. Best-effort — returns empties if the timeline
   * is unavailable. buildId == run id.
   */
  async getPipelineRunDetail({
    connectionId,
    projectName,
    buildId,
  }: {
    connectionId: string;
    projectName: string;
    buildId: number | string;
  }): Promise<AzureRunDetail> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });
    let records: Array<{
      id?: string;
      parentId?: string | null;
      name?: string;
      type?: string;
      state?: string;
      result?: string;
      order?: number;
      issues?: Array<{ type?: string; message?: string }>;
    }> = [];
    try {
      const timeline = (await this.azureApi.fetchBuildTimeline(connection, token, projectName, buildId)) as {
        records?: typeof records;
      };
      records = timeline?.records || [];
    } catch {
      return { stages: [], errors: [] };
    }

    const byId = new Map(records.map((r) => [String(r.id), r]));
    // Walk the parent chain to a stage→job→task breadcrumb (skip structural noise).
    const breadcrumb = (rec: (typeof records)[number]): string => {
      const parts: string[] = [];
      let cur: (typeof records)[number] | undefined = rec;
      let guard = 0;
      while (cur && guard++ < 12) {
        if (cur.name && cur.type !== "Checkpoint" && cur.type !== "Phase") parts.unshift(cur.name);
        cur = cur.parentId ? byId.get(String(cur.parentId)) : undefined;
      }
      return parts.join(" • ");
    };

    const stages = records
      .filter((r) => r.type === "Stage")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((r) => ({ name: r.name || "Stage", state: r.state || "", result: r.result || undefined }));

    const errors: AzureRunDetail["errors"] = [];
    for (const rec of records) {
      for (const issue of rec.issues || []) {
        if (issue.type === "error" && issue.message) {
          errors.push({ message: issue.message, context: breadcrumb(rec) });
          if (errors.length >= 100) break;
        }
      }
      if (errors.length >= 100) break;
    }

    return { stages, errors };
  }

  /** Seed the re-run dialog from a specific past run's branch, parameters and variables. */
  async getPipelineRunSeed({
    connectionId,
    projectName,
    pipelineId,
    runId,
  }: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    runId: number | string;
  }): Promise<AzurePipelineRunSeed> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });
    const run = (await this.azureApi.getPipelineRun(connection, token, projectName, pipelineId, runId)) as {
      templateParameters?: Record<string, unknown>;
      variables?: Record<string, { value?: string; isSecret?: boolean }>;
      resources?: { repositories?: { self?: { refName?: string } } };
    };
    const parameters: Record<string, string> = {};
    for (const [key, value] of Object.entries(run.templateParameters || {})) {
      parameters[key] = value == null ? "" : String(value);
    }
    const variables = Object.entries(run.variables || {}).map(([name, v]) => ({
      name,
      // Secrets are not returned by Azure — blank them but flag so the UI can hint.
      value: v?.isSecret ? "" : String(v?.value ?? ""),
      isSecret: Boolean(v?.isSecret),
    }));
    return {
      branch: run.resources?.repositories?.self?.refName || "",
      parameters,
      variables,
    };
  }

  /**
   * Runtime parameter schema for a pipeline (name/type/default/allowed values),
   * used to render typed controls in the re-run dialog. Cached per
   * connection:project:pipeline:branch with a short TTL so opening the dialog
   * repeatedly doesn't re-hit Azure; a pipeline's YAML rarely changes mid-edit.
   * Best-effort: returns [] (rather than throwing) when the schema can't be read.
   */
  async getPipelineRunParameterSchema({
    connectionId,
    projectName,
    pipelineId,
    branch,
  }: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    branch?: string;
  }): Promise<AzurePipelineParameterDef[]> {
    const branchLabel = branch || "(default)";
    const cacheKey = `${connectionId}:${projectName}:${pipelineId}:${branch || ""}`;
    const cached = this.paramSchemaCache.get(cacheKey);
    if (cached && this.now() - cached.at < AzureDevOpsManager.PARAM_SCHEMA_TTL_MS) {
      this.log.info("pipeline params: cache hit", {
        pipelineId,
        branch: branchLabel,
        params: cached.defs.length,
        ageSec: Math.round((this.now() - cached.at) / 1000),
      });
      return cached.defs;
    }

    this.log.info("pipeline params: fetching schema from Azure", {
      connectionId,
      projectName,
      pipelineId,
      branch: branchLabel,
      reason: cached ? "expired" : "miss",
    });
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });

    let defs: AzurePipelineParameterDef[];
    try {
      const raw = (await this.azureApi.getPipelineRunParameters(
        connection,
        token,
        projectName,
        pipelineId,
        branch,
      )) as {
        dataProviders?: Record<string, { templateParameters?: unknown[]; parameters?: unknown[] } | null>;
      };
      const providers = raw?.dataProviders || {};
      const provider = providers["ms.vss-build-web.pipeline-run-parameters-data-provider"];
      const list = provider?.templateParameters ?? provider?.parameters ?? [];

      // Raw payload so we can see exactly which keys Azure uses for type/values.
      this.log.debug("pipeline params: raw provider payload", {
        pipelineId,
        branch: branchLabel,
        raw: JSON.stringify(Array.isArray(list) ? list : provider).slice(0, 2000),
      });

      // Diagnostic: if the expected provider is missing, surface what *was* returned
      // so a wrong provider id / context is visible in the log instead of silent [].
      if (!provider) {
        this.log.warn("pipeline params: data provider missing in response", {
          pipelineId,
          branch: branchLabel,
          providerKeys: Object.keys(providers),
        });
      }

      defs = (Array.isArray(list) ? list : [])
        .map((entry): AzurePipelineParameterDef | null => {
          const p = (entry ?? {}) as Record<string, unknown>;
          const name = String(p.name ?? "");
          if (!name) return null;
          const rawValues = Array.isArray(p.values) ? p.values : Array.isArray(p.enum) ? p.enum : undefined;
          const values = rawValues?.map((v) => String(v)).filter((v) => v.length > 0);
          const def = p.default ?? p.defaultValue;
          const defaultStr = def == null ? undefined : String(def);
          // Azure's data provider encodes the parameter type as a numeric code
          // (e.g. "3" = boolean), not the YAML type name. We only need to single
          // out booleans (→ checkbox): a param with no choice-values whose default
          // reads as true/false. Choice params keep their values (→ dropdown);
          // everything else stays text.
          const type =
            !(values && values.length) && /^(true|false)$/i.test(defaultStr ?? "")
              ? "boolean"
              : String(p.type ?? "string");
          return {
            name,
            displayName: String(p.displayName || name),
            type,
            default: defaultStr,
            values: values && values.length ? values : undefined,
          };
        })
        .filter((d): d is AzurePipelineParameterDef => d !== null);
    } catch (err) {
      // Best-effort — the re-run dialog falls back to free-text inputs. Don't cache
      // the failure so a transient error clears on the next open.
      this.log.warn("pipeline params: schema fetch failed; falling back to free-text", {
        pipelineId,
        branch: branchLabel,
        err: (err as Error)?.message || String(err),
      });
      return [];
    }

    this.paramSchemaCache.set(cacheKey, { at: this.now(), defs });
    this.log.info("pipeline params: schema fetched + cached", {
      pipelineId,
      branch: branchLabel,
      params: defs.length,
      // Full parsed shape so we can see why a param renders as text vs combobox/checkbox.
      defs: defs.map((d) => ({ name: d.name, type: d.type, default: d.default, values: d.values })),
      ttlSec: Math.round(AzureDevOpsManager.PARAM_SCHEMA_TTL_MS / 1000),
    });
    return defs;
  }

  /**
   * Branch + tag refs of a pipeline's repository, for the re-run dialog's branch
   * picker. Best-effort: returns empty lists (the field stays free-text) when the
   * definition can't be read or the repo isn't Azure Repos Git (e.g. GitHub),
   * which the git refs API can't enumerate.
   */
  async listPipelineRefs({
    connectionId,
    projectName,
    pipelineId,
  }: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
  }): Promise<AzurePipelineRefs> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });

    let repo: { id?: string; type?: string } | undefined;
    try {
      const def = (await this.azureApi.getBuildDefinition(connection, token, projectName, pipelineId)) as {
        repository?: { id?: string; type?: string };
      };
      repo = def?.repository;
    } catch (err) {
      this.log.warn("pipeline refs: definition fetch failed", {
        pipelineId,
        err: (err as Error)?.message || String(err),
      });
      return { branches: [], tags: [], repositoryId: "" };
    }
    const repoId = repo?.id || "";
    const repoType = repo?.type || "";

    // The git refs API only enumerates Azure Repos Git ("TfsGit"). GitHub/external
    // repos can't be listed here — leave the branch field as free-text.
    if (!repoId || repoType !== "TfsGit") {
      this.log.info("pipeline refs: repo not Azure Git, skipping picker", { pipelineId, repoType });
      return { branches: [], tags: [], repositoryId: "" };
    }

    try {
      const [heads, tags] = await Promise.all([
        this.azureApi.listRepositoryRefs(connection, token, projectName, repoId, "heads/"),
        this.azureApi.listRepositoryRefs(connection, token, projectName, repoId, "tags/"),
      ]);
      const names = (refs: unknown[]): string[] =>
        (refs as Array<{ name?: string }>).map((r) => r?.name || "").filter((n) => n.length > 0);
      const result = { branches: names(heads), tags: names(tags), repositoryId: repoId };
      this.log.info("pipeline refs: fetched", {
        pipelineId,
        repoId,
        branches: result.branches.length,
        tags: result.tags.length,
      });
      return result;
    } catch (err) {
      this.log.warn("pipeline refs: refs fetch failed", {
        pipelineId,
        err: (err as Error)?.message || String(err),
      });
      return { branches: [], tags: [], repositoryId: "" };
    }
  }

  /**
   * Recent commits on a repo (Commits tab of the re-run branch picker). Takes
   * the repositoryId from {@link listPipelineRefs}. Best-effort: returns [] when
   * the repo id is missing or the request fails.
   */
  async listPipelineCommits({
    connectionId,
    projectName,
    repositoryId,
    top = 30,
  }: {
    connectionId: string;
    projectName: string;
    repositoryId: string;
    top?: number;
  }): Promise<AzurePipelineCommit[]> {
    if (!repositoryId) return [];
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });
    try {
      const raw = (await this.azureApi.listRepositoryCommits(
        connection,
        token,
        projectName,
        repositoryId,
        top,
      )) as Array<{ commitId?: string; comment?: string; author?: { name?: string; date?: string } }>;
      const commits = raw
        .map((c): AzurePipelineCommit | null => {
          const id = String(c.commitId || "");
          if (!id) return null;
          return {
            id,
            shortId: id.slice(0, 8),
            comment: String(c.comment || "").split("\n")[0],
            author: String(c.author?.name || ""),
            date: c.author?.date,
          };
        })
        .filter((c): c is AzurePipelineCommit => c !== null);
      this.log.info("pipeline commits: fetched", { repositoryId, commits: commits.length });
      return commits;
    } catch (err) {
      this.log.warn("pipeline commits: fetch failed", {
        repositoryId,
        err: (err as Error)?.message || String(err),
      });
      return [];
    }
  }

  /** Lightweight status poll of a single run (for completion watching). */
  async getPipelineRunStatus({
    connectionId,
    projectName,
    pipelineId,
    runId,
  }: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    runId: number | string;
  }): Promise<{ id: number; state: string; result?: string; webUrl: string }> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: false });
    const run = (await this.azureApi.getPipelineRun(connection, token, projectName, pipelineId, runId)) as {
      id?: number | string;
      state?: string;
      result?: string;
      _links?: { web?: { href?: string } };
    };
    return {
      id: Number(run.id),
      state: run.state || "",
      result: run.result || undefined,
      webUrl: run._links?.web?.href || "",
    };
  }

  /** Cancel an in-progress build/run (buildId == run id). Throws on 401/403 — surfaced to the UI. */
  async cancelBuild({
    connectionId,
    projectName,
    buildId,
  }: {
    connectionId: string;
    projectName: string;
    buildId: number | string;
  }): Promise<{ id: number; status: string }> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });
    const build = (await this.azureApi.cancelBuild(connection, token, projectName, buildId)) as {
      id?: number | string;
      status?: string;
    };
    return { id: Number(build.id ?? buildId), status: build.status || "cancelling" };
  }

  /** Concatenate a build's step/job logs into one raw text document for download. */
  async getBuildLogText({
    connectionId,
    projectName,
    buildId,
  }: {
    connectionId: string;
    projectName: string;
    buildId: number | string;
  }): Promise<string> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });

    // Map logId → { name, type, order } from the timeline so sections are labelled.
    const labelById = new Map<number, { name: string; type: string; order: number }>();
    try {
      const timeline = (await this.azureApi.fetchBuildTimeline(connection, token, projectName, buildId)) as {
        records?: Array<{ name?: string; type?: string; order?: number; log?: { id?: number } }>;
      };
      for (const rec of timeline?.records || []) {
        if (rec.log?.id != null) {
          labelById.set(Number(rec.log.id), { name: rec.name || "", type: rec.type || "", order: rec.order ?? 0 });
        }
      }
    } catch {
      // Timeline is best-effort labelling — fall back to log ids.
    }

    const logs = (await this.azureApi.listBuildLogs(connection, token, projectName, buildId)) as Array<{
      id?: number | string;
    }>;
    const ids = logs
      .map((l) => Number(l.id))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => (labelById.get(a)?.order ?? a) - (labelById.get(b)?.order ?? b));

    const parts: string[] = [];
    for (const id of ids) {
      const label = labelById.get(id);
      const header = label?.name ? `===== ${label.type || "Log"}: ${label.name} =====` : `===== Log ${id} =====`;
      let text: string;
      try {
        text = await this.azureApi.getBuildLogText(connection, token, projectName, buildId, id);
      } catch (err) {
        text = `(failed to fetch log ${id}: ${(err as Error).message})`;
      }
      parts.push(`${header}\n${text.replace(/\s+$/, "")}\n`);
    }
    return parts.length ? parts.join("\n") : "(no logs available for this run)";
  }

  /** Queue a new run. Throws on 401/403 (PAT lacks Build read & execute) — surfaced to the UI. */
  async runPipeline({
    connectionId,
    projectName,
    pipelineId,
    branch,
    parameters = {},
    variables = [],
  }: {
    connectionId: string;
    projectName: string;
    pipelineId: number | string;
    branch?: string;
    parameters?: Record<string, string>;
    variables?: Array<{ name: string; value: string; isSecret?: boolean }>;
  }): Promise<{ id: number; state: string; result?: string; webUrl: string }> {
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    this.setAuditContext({ connectionId, userInitiated: true });

    const body: {
      resources?: { repositories: { self: { refName?: string; version?: string } } };
      templateParameters?: Record<string, string>;
      variables?: Record<string, { value: string }>;
    } = {};
    if (branch) {
      const ref = branch.trim();
      // The picker drops a full 40-char commit id here when a commit is chosen;
      // Azure wants that as `version`, whereas branches/tags go in `refName`.
      const self = /^[0-9a-f]{40}$/i.test(ref) ? { version: ref } : { refName: ref };
      body.resources = { repositories: { self } };
    }
    if (parameters && Object.keys(parameters).length) {
      body.templateParameters = parameters;
    }
    // Only send variables the user actually filled in — blank values (including
    // seeded secret placeholders left empty) are omitted so the pipeline keeps
    // its own default instead of being overwritten with "".
    const filledVars = variables.filter((v) => v.name && v.value !== "");
    if (filledVars.length) {
      body.variables = Object.fromEntries(filledVars.map((v) => [v.name, { value: v.value }]));
    }

    const run = (await this.azureApi.runPipeline(connection, token, projectName, pipelineId, body)) as {
      id?: number | string;
      state?: string;
      result?: string;
      _links?: { web?: { href?: string } };
    };
    return {
      id: Number(run.id),
      state: run.state || "",
      result: run.result || undefined,
      webUrl: run._links?.web?.href || "",
    };
  }

  async sync({
    connections = [] as AzureConnection[],
    workspaces = [] as ReviewWorkspace[],
    gitSnapshots = {} as Record<string, unknown>,
    activeProfileId = "default",
  } = {}) {
    return this.syncCore(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { connections: connections as any, workspaces, gitSnapshots, activeProfileId },
      {
        createConnectionSnapshot: (connection, persistedState) =>
          createConnectionSnapshot(connection as unknown as AzureConnection, persistedState),
        fetchConnectionPrs: (connection, token, ctx) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this._fetchAzureConnectionPrs(connection as unknown as AzureConnection, token, ctx as any),
        isPrResolved: (existing) => (existing as AzurePrSummary | undefined)?.pullRequest?.status !== "active",
        resolveStalePr: (ws, existing, conn, token) =>
          this._resolveStaleAzurePr(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ws as any,
            existing as AzurePrSummary | undefined,
            conn as unknown as AzureConnection,
            token,
          ),
      },
    );
  }

  /**
   * Azure-specific per-connection PR walk: project → repository → PR, fetching
   * each PR's threads to compute vote/comment state. This is the one part of
   * sync() that's genuinely provider-specific (GitHub's equivalent runs 2
   * search queries with dedup instead) — everything else lives in
   * BaseProviderManager.syncCore.
   */
  async _fetchAzureConnectionPrs(
    connection: AzureConnection,
    token: string,
    ctx: {
      workspaces: ReviewWorkspace[];
      gitSnapshots: Record<string, unknown>;
      activeProfileId: string;
      seedingConnection: boolean;
      visibleSummaries: AzurePrSummary[];
      trackedPullRequests: Record<string, TrackedPullRequest>;
      detailMap: Record<string, AzurePrSummary>;
      newActivityEvents: unknown[];
    },
  ): Promise<void> {
    const {
      workspaces,
      gitSnapshots,
      activeProfileId,
      seedingConnection,
      visibleSummaries,
      trackedPullRequests,
      detailMap,
      newActivityEvents,
    } = ctx;

    const projects = (await this.azureApi.listProjects(connection, token)) as AzureProject[];
    const filteredProjects = connection.projectFilters?.length
      ? projects.filter(
          (project) =>
            connection.projectFilters!.includes(project.name) || connection.projectFilters!.includes(project.id),
        )
      : projects;

    for (const project of filteredProjects) {
      const pullRequests = (await this.azureApi.listPullRequestsByProject(connection, token, project.name)) as Array<{
        pullRequestId: string | number;
        repository: { id: string; name: string };
        [key: string]: unknown;
      }>;
      for (const pr of pullRequests) {
        if (connection.repositoryFilters?.length) {
          const matchesRepository =
            connection.repositoryFilters.includes(pr.repository?.id) ||
            connection.repositoryFilters.includes(pr.repository?.name);
          if (!matchesRepository) {
            continue;
          }
        }

        const threads = (await this.azureApi.listThreads(
          connection,
          token,
          project.name,
          pr.repository.id,
          pr.pullRequestId,
        )) as Array<Record<string, unknown>>;
        const prKey = createPullRequestKey(connection.id, pr.repository.id, pr.pullRequestId);
        const tracked = this.reviewStore.getTrackedPullRequest(prKey) || {};
        const { summary, internals } = buildPullRequestSummary({
          connection,
          pr: pr as Record<string, unknown>,
          projectName: project.name,
          threads,
          tracked,
          workspaces: workspaces as Array<{ id: string; profileId?: string; [key: string]: unknown }>,
          gitSnapshots,
          activeProfileId,
          now: this.now,
        });
        const typedSummary = summary as AzurePrSummary;
        const typedInternals = internals as Record<string, unknown>;
        visibleSummaries.push(typedSummary);

        const { events, lastNotifiedActivityAt } = this._detectAzureReviewActivityDeltas({
          connection,
          tracked,
          summary: typedSummary,
          internals: typedInternals,
          seedingConnection,
        });
        newActivityEvents.push(...events);

        if (this.reviewBridgeStore?.syncPullRequest) {
          try {
            await this.reviewBridgeStore.syncPullRequest(typedSummary);
          } catch (error) {
            this.log.warn("review bridge sync failed", { prKey, err: (error as Error).message || String(error) });
          }
        }
        trackedPullRequests[prKey] = {
          ...(tracked || {}),
          key: prKey,
          connectionId: connection.id,
          pullRequestId: pr.pullRequestId,
          repositoryId: pr.repository.id,
          projectName: project.name,
          repositoryName: pr.repository.name,
          reviewWorkspaceId: typedSummary.reviewWorkspaceId || tracked.reviewWorkspaceId || "",
          lastRemoteActivityAt: typedSummary.lastRemoteActivityAt,
          lastVoteSignature: typedInternals.voteSignature as string | null,
          lastMergeStatus: typedSummary.pullRequest?.mergeStatus,
          lastSourceCommitId: typedSummary.pullRequest?.sourceCommitId,
          lastSeenActivityAt: tracked.lastSeenActivityAt || null,
          lastNotifiedActivityAt: lastNotifiedActivityAt as string | null,
        };
        detailMap[prKey] = {
          ...(detailMap[prKey] || {}),
          ...typedSummary,
          threads: typedSummary.threads,
        };
      }
    }
  }

  /**
   * Fetch a single stale/inactive PR by id and return either its updated
   * state or (on a confirmed 404/410) a terminal "completed" summary. Returns
   * null on any other failure so BaseProviderManager.syncCore leaves the
   * existing detailMap entry untouched and retries on the next poll instead
   * of mislabeling a still-active PR.
   */
  async _resolveStaleAzurePr(
    ws: ReviewWorkspace,
    existing: AzurePrSummary | undefined,
    conn: AzureConnection,
    token: string,
  ): Promise<AzurePrSummary | null> {
    const key = ws.review!.prKey!;
    try {
      const pr = (await this.azureApi.getPullRequestById(
        conn,
        token,
        ws.review!.project?.name || "",
        ws.review!.repository?.id || "",
        ws.review!.pullRequest?.id || "",
      )) as { status?: string; closedDate?: string | null };
      return {
        ...(existing || {}),
        connectionId: ws.review!.connectionId || "",
        project: ws.review!.project as AzurePrSummary["project"],
        repository: ws.review!.repository as AzurePrSummary["repository"],
        prKey: key,
        pullRequest: {
          ...((existing?.pullRequest || ws.review!.pullRequest || {}) as AzurePrSummary["pullRequest"]),
          id: existing?.pullRequest?.id ?? "",
          status: pr.status || "completed",
          closedDate: pr.closedDate ?? undefined,
        },
      };
    } catch (error) {
      // Azure's requestJson embeds the HTTP status in the thrown message, e.g.
      // "Azure DevOps request failed (404): ...". Only a 404/410 means the PR
      // is genuinely gone — any other failure (network blip, 500, timeout,
      // unparseable status) is transient, so leave detailMap[key] untouched
      // and let the next poll cycle retry the check instead of permanently
      // mislabeling a still-active PR as completed.
      const message = (error as Error).message || String(error);
      const statusMatch = message.match(/request failed \((\d+)\)/);
      const statusCode = statusMatch ? Number(statusMatch[1]) : undefined;
      if (statusCode !== 404 && statusCode !== 410) {
        this.log.warn("stale PR check failed, will retry next poll", { prKey: key, statusCode, err: message });
        return null;
      }
      this.log.warn("stale PR confirmed gone, marking completed", { prKey: key, statusCode, err: message });
      return {
        ...(existing || {}),
        connectionId: ws.review!.connectionId || "",
        project: ws.review!.project as AzurePrSummary["project"],
        repository: ws.review!.repository as AzurePrSummary["repository"],
        prKey: key,
        pullRequest: {
          ...((existing?.pullRequest || ws.review!.pullRequest || {}) as AzurePrSummary["pullRequest"]),
          id: existing?.pullRequest?.id ?? "",
          status: "completed",
        },
      };
    }
  }

  /**
   * Compare a PR summary against its tracked state and emit review-activity
   * events for changes caused by people other than the current user.
   *
   * Returns `{ events, lastNotifiedActivityAt }`. The caller persists the new
   * marker in the tracked store so the next poll starts from here.
   *
   * On the connection's first sync (seedingConnection=true) we silently seed
   * every PR's marker to avoid a flood of "new" events at app startup.
   */
  _detectAzureReviewActivityDeltas({
    connection,
    tracked,
    summary: summaryIn,
    internals,
    seedingConnection,
  }: {
    connection: AzureConnection;
    tracked: TrackedPullRequest;
    summary: AzurePrSummary;
    internals: Record<string, unknown>;
    seedingConnection: boolean;
  }): { events: unknown[]; lastNotifiedActivityAt: string | null } {
    // Cast to the ReviewSummaryRef shape expected by buildReviewActivityEvent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = summaryIn as any;
    const nowIso = new Date(this.now()).toISOString();
    const events: unknown[] = [];

    if (seedingConnection) {
      return {
        events,
        lastNotifiedActivityAt: seedNotifiedTimestamp(summary, nowIso),
      };
    }

    const prevNotifiedAt = tracked.lastNotifiedActivityAt || "";

    // Brand-new PR that wasn't in the tracked store before this poll.
    // Emit a `pr-new` event when the current user is the requested reviewer.
    if (!prevNotifiedAt) {
      if (summary.role === "reviewer") {
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-new",
            at: summary.lastRemoteActivityAt || nowIso,
            title: `Review requested: ${summary.repository.name} #${summary.pullRequest.id}`,
            body: truncateBody(`${summary.author.displayName}: ${summary.pullRequest.title}`),
            actor: { login: summary.author.uniqueName, displayName: summary.author.displayName },
          }),
        );
      }
      return {
        events,
        lastNotifiedActivityAt: seedNotifiedTimestamp(summary, nowIso),
      };
    }

    // 1) New comments from other people.
    const newComments = filterNewComments({
      comments: internals.commentsByOthers as AzureComment[],
      sinceIsoString: prevNotifiedAt,
      isSelf: (author) =>
        identityMatches(
          connection.login,
          author as { uniqueName?: string; mailAddress?: string; displayName?: string; id?: string },
        ),
      getTimestamp: (comment) => comment.lastUpdatedDate || comment.publishedDate,
      getAuthor: (comment) => comment.author,
    });
    if (newComments.length > 0) {
      const latest = newComments[newComments.length - 1];
      const actor = {
        login: latest.author?.uniqueName || "",
        displayName: latest.author?.displayName || latest.author?.uniqueName || "Someone",
      };
      const title =
        newComments.length > 1
          ? `${newComments.length} new comments on ${summary.repository.name} #${summary.pullRequest.id}`
          : `New comment on ${summary.repository.name} #${summary.pullRequest.id}`;
      events.push(
        buildReviewActivityEvent({
          provider: "azure-devops",
          summary,
          kind: "pr-new-comment",
          at: latest.lastUpdatedDate || latest.publishedDate || nowIso,
          title,
          body: truncateBody(`${actor.displayName}: ${latest.content || ""}`),
          actor,
        }),
      );
    }

    // 2) Vote change by a reviewer other than the current user.
    if (tracked.lastVoteSignature && tracked.lastVoteSignature !== (internals.voteSignature as string | undefined)) {
      const prevMap = parseAzureVoteSignature(tracked.lastVoteSignature);
      const currMap = parseAzureVoteSignature(internals.voteSignature as string | undefined);
      const changedIds = diffSignatureKeys(prevMap, currMap, internals.myReviewerId as string | undefined);
      const reviewerMap = internals.reviewerMap as Map<
        string,
        {
          id: string;
          displayName: string;
          uniqueName: string;
          vote: number;
          isRequired: boolean;
          hasDeclined: boolean;
          isContainer: boolean;
        }
      >;
      const changedReviewers = changedIds
        .map((id) => reviewerMap.get(id))
        .filter((reviewer) => reviewer && !identityMatches(connection.login, reviewer));
      if (changedReviewers.length > 0) {
        const reviewer = changedReviewers[0]!;
        const voteLabel =
          reviewer.vote >= 10
            ? "approved"
            : reviewer.vote === 5
              ? "approved with suggestions"
              : reviewer.vote === -5
                ? "is waiting for the author"
                : reviewer.vote <= -10
                  ? "rejected the changes"
                  : "reset their vote";
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-vote-changed",
            at: nowIso,
            title: `Review updated on ${summary.repository.name} #${summary.pullRequest.id}`,
            body: truncateBody(`${reviewer.displayName} ${voteLabel}.`),
            actor: { login: reviewer.uniqueName, displayName: reviewer.displayName },
            urgency: reviewer.vote <= -10 ? "urgent" : "normal",
          }),
        );
      }
    }

    // 3) Source branch updated — only notify when the pusher is someone else.
    if (
      tracked.lastSourceCommitId &&
      tracked.lastSourceCommitId !== (internals.sourceCommitId as string | undefined) &&
      internals.sourceCommitId
    ) {
      type GitIdentity = {
        name?: string;
        email?: string;
        mailAddress?: string;
        uniqueName?: string;
        displayName?: string;
      };
      const pusher = (internals.sourceCommitter || internals.sourceCommitAuthor || null) as GitIdentity | null;
      // Azure git-commit identity uses `{ name, email }` while user identity
      // uses `{ uniqueName, mailAddress, displayName }` — normalize before
      // comparing so a push by the current user is correctly self-filtered.
      const pusherIdentity = pusher
        ? {
            ...pusher,
            mailAddress: pusher.email || pusher.mailAddress || "",
            uniqueName: pusher.email || pusher.uniqueName || "",
            displayName: pusher.name || pusher.displayName || "",
          }
        : null;
      if (!identityMatches(connection.login, pusherIdentity)) {
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-source-updated",
            at: (internals.latestCommitAt as string | undefined) || nowIso,
            title: `${summary.repository.name} #${summary.pullRequest.id} has new commits`,
            body: truncateBody(pusher?.name ? `${pusher.name} pushed updates.` : "New commits were pushed."),
            actor: pusher ? { login: pusher.email || "", displayName: pusher.name || "" } : null,
          }),
        );
      }
    }

    // 4) Merge status turned bad (conflicts, policy rejection) — urgent for the author.
    if (
      summary.role === "author" &&
      tracked.lastMergeStatus &&
      tracked.lastMergeStatus !== (internals.mergeStatus as string | undefined)
    ) {
      const normalized = String(internals.mergeStatus || "").toLowerCase();
      const isBad =
        normalized.includes("conflict") ||
        normalized.includes("fail") ||
        normalized.includes("reject") ||
        normalized === "rejectedbypolicy";
      if (isBad) {
        events.push(
          buildReviewActivityEvent({
            provider: "azure-devops",
            summary,
            kind: "pr-merge-status-changed",
            at: nowIso,
            title: `${summary.repository.name} #${summary.pullRequest.id} needs attention`,
            body: truncateBody(`Merge status: ${internals.mergeStatus}`),
            urgency: "urgent",
          }),
        );
      }
    }

    return {
      events,
      lastNotifiedActivityAt: events.length > 0 ? nowIso : prevNotifiedAt,
    };
  }

  async ensurePullRequestDetail(
    prKey: string,
    { workspaces = [] as ReviewWorkspace[], force = false } = {},
  ): Promise<AzurePrSummary> {
    const current = (this.snapshot.pullRequests[prKey] || this.findSummary(prKey)) as AzurePrSummary | null;
    if (!current) {
      throw new Error("Pull request is not available in the current Azure snapshot.");
    }
    if (!force && Array.isArray(current.changedFiles) && current.checks?.items) {
      return current;
    }

    this.setAuditContext({ connectionId: current.connectionId || "", userInitiated: true });
    const connection = this.findConnection(current.connectionId) as AzureConnection | null;
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }

    const [changes, pullRequestStatuses, policyEvaluations] = await Promise.all([
      this.azureApi
        .listIterationChanges(connection, token, current.project!.name, current.repository!.id, current.pullRequest!.id)
        .catch(() => []),
      this.azureApi
        .listPullRequestStatuses(
          connection,
          token,
          current.project!.name,
          current.repository!.id,
          current.pullRequest!.id,
        )
        .catch(() => []),
      this.azureApi
        .listPolicyEvaluations(connection, token, current.project!.name, current.project!.id, current.pullRequest!.id)
        .catch(() => []),
    ]);
    const workspace: ReviewWorkspace | undefined =
      (findWorkspaceForPullRequest(workspaces as Array<{ id: string; [key: string]: unknown }>, prKey) as
        ReviewWorkspace | undefined) ||
      (current.existingWorkspaceId
        ? (workspaces as ReviewWorkspace[]).find((entry) => entry.id === current.existingWorkspaceId)
        : undefined);
    const localChanges = workspace?.cwd
      ? await this.listLocalChangedFiles(workspace.cwd, current.pullRequest!.targetRefName || "").catch(() => [])
      : [];

    const enrichedThreads = workspace?.cwd
      ? await this.readThreadCodeSnippets(
          workspace.cwd,
          current.threads || [],
          current.pullRequest!.targetRefName || "",
        ).catch(() => current.threads || [])
      : current.threads || [];

    // Fetch build details for timestamps (for all checks with buildId)
    type PolicyEval = { context?: { buildId?: string | number | null } };
    const buildIds = [
      ...new Set((policyEvaluations as PolicyEval[]).map((e) => e?.context?.buildId).filter(Boolean)),
    ] as Array<string | number>;
    const buildDetails: Record<string, unknown> = {};
    if (buildIds.length) {
      const details = await Promise.all(
        buildIds.map((id) =>
          this.azureApi.fetchBuildDetail(connection, token, current.project!.name, id).catch(() => null),
        ),
      );
      for (const detail of details as Array<{ id?: string | number } | null>) {
        if (detail?.id) buildDetails[String(detail.id)] = detail;
      }
    }

    const checksResult = buildCheckSummary({
      policyEvaluations: policyEvaluations as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: runtime policy evaluation shape is open-ended ADO API JSON
      statuses: pullRequestStatuses as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: runtime status shape is open-ended ADO API JSON
      buildDetails: buildDetails as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: runtime build detail shape is open-ended ADO API JSON
    });

    // Fetch build timeline errors for failed checks that have a buildId
    type CheckItem = {
      id?: string;
      state?: string;
      buildId?: string | number | null;
      errorMessage?: string;
      [key: string]: unknown;
    };
    const failedWithBuild = ((checksResult.items as CheckItem[]) || []).filter(
      (item) => item.state === "failed" && item.buildId && !item.errorMessage,
    );
    if (failedWithBuild.length) {
      const errorResults = await Promise.all(
        failedWithBuild.map((item) =>
          this.azureApi
            .fetchBuildErrors(connection, token, current.project!.name, item.buildId)
            .then((msg) => ({ id: item.id, errorMessage: msg as string })),
        ),
      );
      const errorMap = new Map(errorResults.filter((e) => e.errorMessage).map((e) => [e.id, e.errorMessage]));
      if (errorMap.size) {
        checksResult.items = (checksResult.items as CheckItem[]).map((item) =>
          errorMap.has(item.id) ? { ...item, errorMessage: errorMap.get(item.id) } : item,
        );
      }
    }

    const next: AzurePrSummary = {
      ...current,
      changedFiles: changes,
      localChangedFiles: localChanges,
      threads: enrichedThreads as AzureThread[],
      checks: checksResult as AzurePrSummary["checks"],
      existingWorkspaceId: workspace?.id || current.existingWorkspaceId || "",
      reviewWorkspaceId:
        (workspace as ReviewWorkspace)?.review?.provider === "azure-devops"
          ? (workspace as ReviewWorkspace).id
          : current.reviewWorkspaceId || "",
    };

    this.setSnapshot({
      ...this.snapshot,
      pullRequests: {
        ...this.snapshot.pullRequests,
        [prKey]: next as unknown as (typeof this.snapshot.pullRequests)[string],
      },
    });
    if (this.reviewBridgeStore?.syncPullRequest) {
      try {
        await this.reviewBridgeStore.syncPullRequest(next);
      } catch (error) {
        this.log.warn("review bridge detail sync failed", { prKey, err: (error as Error).message || String(error) });
      }
    }
    return next;
  }

  async rerunCheck(prKey: string, checkItem: AzureCheckItem): Promise<AzurePrSummary> {
    const current = this.snapshot.pullRequests?.[prKey] as AzurePrSummary | undefined;
    if (!current) throw new Error(`PR ${prKey} not found in snapshot`);
    const connection = this.findConnection(current.connectionId) as AzureConnection | null;
    if (!connection) throw new Error(`Connection not found for PR ${prKey}`);
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error(`No credentials found for connection "${connection.label || connection.id}"`);
    this.setAuditContext({ connectionId: connection.id, userInitiated: true });

    if (checkItem.kind === "policy" && checkItem.evaluationId) {
      this.log.info("re-evaluating policy", { evaluationId: checkItem.evaluationId, prKey });
      await this.azureApi.reEvaluatePolicy(
        connection,
        token,
        current.project!.name,
        current.project!.id,
        checkItem.evaluationId,
      );
    } else {
      throw new Error(
        `Cannot re-run check "${checkItem.name || checkItem.id}": kind=${checkItem.kind}, evaluationId=${checkItem.evaluationId || "missing"}`,
      );
    }

    // Refresh checks after re-run
    return this.ensurePullRequestDetail(prKey, { force: true });
  }

  async readThreadCodeSnippets(cwd: string, threads: AzureThread[] = [], targetRefName = ""): Promise<AzureThread[]> {
    if (!cwd || !threads.length) return threads;
    const targetBranch = stripRefsPrefix(targetRefName);
    const filesNeeded = new Map<string, AzureThread[]>();
    for (const thread of threads) {
      if (thread.filePath && thread.lineStart) {
        const key = thread.filePath;
        if (!filesNeeded.has(key)) {
          filesNeeded.set(key, []);
        }
        filesNeeded.get(key)!.push(thread);
      }
    }
    if (!filesNeeded.size) return threads;

    const snippetMap = new Map<string, string>();
    for (const [filePath] of filesNeeded) {
      try {
        const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
        const result = await this.execFileText(
          "git",
          ["diff", `origin/${targetBranch}...HEAD`, "--unified=4", "--", normalizedPath],
          { cwd, env: sanitizeGitEnvironment() },
        );
        if (result.stdout) {
          snippetMap.set(filePath, result.stdout);
        }
      } catch {
        // file may not exist in diff
      }
    }

    return threads.map((thread) => {
      if (!thread.filePath || !thread.lineStart) return thread;
      const fullDiff = snippetMap.get(thread.filePath);
      if (!fullDiff) return thread;

      // Extract the relevant hunk around the comment lines
      const lines = fullDiff.split(/\r?\n/);
      const contextLines: string[] = [];
      let inRelevantHunk = false;
      let currentNewLine = 0;
      const targetStart = Math.max(1, thread.lineStart - 2);
      const targetEnd = (thread.lineEnd || thread.lineStart) + 2;

      for (const line of lines) {
        // eslint-disable-next-line security/detect-unsafe-regex -- git diff hunk header; bounded by \d+ quantifiers, no exponential backtracking path
        const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
        if (hunkMatch) {
          currentNewLine = Number.parseInt(hunkMatch[1], 10);
          inRelevantHunk = currentNewLine <= targetEnd + 10;
          if (inRelevantHunk) contextLines.push(line);
          continue;
        }
        if (!inRelevantHunk) continue;

        if (line.startsWith("-")) {
          if (currentNewLine >= targetStart && currentNewLine <= targetEnd + 5) {
            contextLines.push(line);
          }
        } else {
          if (line.startsWith("+")) {
            if (currentNewLine >= targetStart && currentNewLine <= targetEnd) {
              contextLines.push(`${String(currentNewLine).padStart(4)} ${line}`);
            }
            currentNewLine++;
          } else {
            if (currentNewLine >= targetStart && currentNewLine <= targetEnd) {
              contextLines.push(`${String(currentNewLine).padStart(4)} ${line}`);
            }
            currentNewLine++;
          }
        }
        if (currentNewLine > targetEnd + 5) {
          inRelevantHunk = false;
        }
      }

      return {
        ...thread,
        codeSnippet: contextLines.length > 0 ? contextLines.join("\n") : "",
      };
    });
  }

  async ensureCacheRepo({
    connection,
    token,
    repository,
    reviewRoot,
  }: {
    connection: AzureConnection;
    token: string;
    repository: { id?: string; name: string; remoteUrl?: string };
    reviewRoot: string;
  }): Promise<string> {
    return this.ensureCacheRepoAt({
      connectionId: connection.id,
      repoIdentifier: repository.id || repository.name,
      repoLabel: repository.name,
      remoteUrl: repository.remoteUrl!,
      reviewRoot: normalizeReviewRoot(reviewRoot),
      token,
      login: connection.login,
    });
  }

  async prepareManagedReviewCheckout({
    summary,
    connection,
    token,
    reviewRoot,
  }: {
    summary: AzurePrSummary;
    connection: AzureConnection;
    token: string;
    reviewRoot: string;
  }): Promise<{ mode: string; rootPath: string; cacheRepoPath: string; sourceBranch: string; targetBranch: string }> {
    try {
      const remoteUrl = firstNonEmpty(
        summary.repository?.remoteUrl,
        buildRepositoryRemoteUrl(
          connection,
          summary.project?.name || "",
          summary.repository?.name || summary.repository?.id || "",
        ),
      );
      if (!remoteUrl) {
        throw new Error("Pull request repository clone URL is missing.");
      }

      const sourceBranch = stripRefsPrefix(summary.pullRequest!.sourceRefName || "");
      if (!sourceBranch) {
        throw new Error("Pull request source branch is missing.");
      }

      const targetBranch = stripRefsPrefix(summary.pullRequest!.targetRefName || "");
      if (!targetBranch) {
        throw new Error("Pull request target branch is missing.");
      }

      const repository: { id?: string; name: string; remoteUrl?: string } = {
        ...summary.repository,
        name: summary.repository?.name || summary.repository?.id || "",
        remoteUrl,
      };
      const cacheRepoPath = await this.ensureCacheRepo({ connection, token, repository, reviewRoot });
      const worktreePath = path.join(
        normalizeReviewRoot(reviewRoot),
        "reviews",
        shortPathKey(connection.id, "connection"),
        `pr-${summary.pullRequest!.id}`,
      );
      const localBranch = `pr-${summary.pullRequest!.id}-${sanitizePathSegment(sourceBranch)}`;

      await this.ensureManagedWorktree({
        cacheRepoPath,
        worktreePath,
        localBranch,
        sourceBranch,
        // Azure fetches the PR's raw source/target ref names as-is (Azure's
        // API can return refs in shapes other than refs/heads/*).
        fetchRefspecs: [
          `+${summary.pullRequest!.sourceRefName}:refs/remotes/origin/${sourceBranch}`,
          `+${summary.pullRequest!.targetRefName}:refs/remotes/origin/${targetBranch}`,
        ],
        login: connection.login,
        token,
      });

      return {
        mode: "managed-worktree",
        rootPath: worktreePath,
        cacheRepoPath,
        sourceBranch,
        targetBranch,
      };
    } catch (error) {
      const friendlyMessage = formatReviewWorkspaceError(error, reviewRoot);
      if (friendlyMessage) {
        throw new Error(friendlyMessage, { cause: error });
      }
      throw error;
    }
  }

  buildReviewMetadata(
    summary: AzurePrSummary,
    checkout: ReviewCheckout,
    extra: { parentWorkspaceId?: string; writable?: boolean } = {},
  ) {
    return {
      provider: "azure-devops",
      prKey: summary.prKey,
      connectionId: summary.connectionId,
      orgUrl: summary.orgUrl,
      parentWorkspaceId: extra.parentWorkspaceId || "",
      project: clone(summary.project),
      repository: clone(summary.repository),
      pullRequest: clone(summary.pullRequest),
      role: summary.role,
      writable: extra.writable === true,
      checkout: {
        mode: checkout.mode,
        rootPath: checkout.rootPath,
        cacheRepoPath: checkout.cacheRepoPath || "",
      },
    };
  }

  buildManagedReviewPaths(
    summary: AzurePrSummary | null | undefined,
    { profileId = "default", workspaces = [] as ReviewWorkspace[] } = {},
  ) {
    const connection = this.findConnection(summary?.connectionId || "") as AzureConnection | null;
    if (!connection || !summary?.pullRequest?.id) {
      return null;
    }

    const parentAzureWorkspace =
      (workspaces || []).find(
        (workspace) => workspace.kind === "azure" && (workspace.profileId || "default") === (profileId || "default"),
      ) || null;
    const reviewRoot = parentAzureWorkspace?.cwd || connection.reviewRoot || getDefaultReviewRoot();

    return {
      parentWorkspaceId: parentAzureWorkspace?.id || "",
      reviewRoot: normalizeReviewRoot(reviewRoot),
      cacheRepoPath: path.join(
        normalizeReviewRoot(reviewRoot),
        "repos",
        shortPathKey(connection.id, "connection"),
        shortPathKey(summary.repository?.id || summary.repository?.name, "repository"),
      ),
      rootPath: path.join(
        normalizeReviewRoot(reviewRoot),
        "reviews",
        shortPathKey(connection.id, "connection"),
        `pr-${summary.pullRequest.id}`,
      ),
    };
  }

  async openReviewWorkspace({
    state,
    prKey,
    workspaceId = "",
    callerProfileId = "",
  }: {
    state: { workspaces: ReviewWorkspace[]; windowSlots?: Array<{ profileId?: string }>; tabTemplates?: unknown[] };
    prKey: string;
    workspaceId?: string;
    /** Profile of the window that initiated the action — used as defensive
     * fallback when the connection has no profileId (legacy/pre-migration). */
    callerProfileId?: string;
  }) {
    return this.openReviewWorkspaceCore(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { state: state as any, prKey, workspaceId, callerProfileId },
      {
        ensurePullRequestDetail: (key, opts) => this.ensurePullRequestDetail(key, opts),
        prepareManagedReviewCheckout: (opts) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.prepareManagedReviewCheckout(opts as any),
        buildReviewMetadata: (summary, checkout, extra) =>
          this.buildReviewMetadata(summary as AzurePrSummary, checkout as ReviewCheckout, extra),
        formatPrLabel: (summary) => `${summary.repository?.name} PR #${summary.pullRequest?.id}`,
        findWorkspaceForPullRequest: (workspaces, key) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          findWorkspaceForPullRequest(workspaces as any, key),
      },
    );
  }

  async addPullRequestComment({
    prKey,
    content,
    threadId = null as string | number | null,
    parentCommentId = 0,
  }: {
    prKey: string;
    content: string;
    threadId?: string | number | null;
    parentCommentId?: number;
  }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findAzureConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    const payload = threadId
      ? {
          content,
          parentCommentId,
          commentType: 1,
        }
      : {
          comments: [
            {
              parentCommentId: 0,
              content,
              commentType: 1,
            },
          ],
          status: "active",
        };
    const url = threadId
      ? this.azureApi.buildCreateCommentUrl(
          connection,
          summary.project!.name,
          summary.repository!.id,
          summary.pullRequest!.id,
          threadId,
        )
      : this.azureApi.buildCreateThreadUrl(
          connection,
          summary.project!.name,
          summary.repository!.id,
          summary.pullRequest!.id,
        );
    await this.azureApi.requestJson(url, {
      login: connection.login,
      token,
      method: "POST",
      body: payload,
    });
  }

  async updateThreadStatus({
    prKey,
    threadId,
    status,
  }: {
    prKey: string;
    threadId: string | number;
    status: string;
  }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findAzureConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    await this.azureApi.requestJson(
      this.azureApi.buildUpdateThreadUrl(
        connection,
        summary.project!.name,
        summary.repository!.id,
        summary.pullRequest!.id,
        threadId,
      ),
      {
        login: connection.login,
        token,
        method: "PATCH",
        body: { status },
      },
    );
  }

  async setPullRequestVote({ prKey, vote }: { prKey: string; vote: number }): Promise<void> {
    const summary = await this.ensurePullRequestDetail(prKey);
    this.setAuditContext({ connectionId: summary.connectionId || "", userInitiated: true });
    const connection = this.findAzureConnection(summary.connectionId);
    if (!connection) {
      throw new Error("Azure DevOps connection was not found.");
    }
    if (!summary.myReviewerId) {
      throw new Error("Current user is not an active reviewer on this pull request.");
    }
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) {
      throw new Error("PAT is missing.");
    }
    await this.azureApi.requestJson(
      this.azureApi.buildReviewerUrl(
        connection,
        summary.project!.name,
        summary.repository!.id,
        summary.pullRequest!.id,
        summary.myReviewerId,
      ),
      {
        login: connection.login,
        token,
        method: "PUT",
        body: {
          id: summary.myReviewerId,
          vote,
        },
      },
    );
  }

  findConnectionForRemote(remoteUrl: string): AzureConnection | null {
    const normalized = normalizeRemoteUrl(remoteUrl);
    if (!normalized) return null;
    for (const connection of this.snapshot.connections as AzureConnection[]) {
      if (!connection.enabled) continue;
      const orgNorm = normalizeRemoteUrl(connection.orgUrl);
      if (orgNorm && normalized.startsWith(orgNorm)) {
        return connection;
      }
    }
    return null;
  }

  async resolveRepository(
    connectionId: string,
    remoteUrl: string,
  ): Promise<{
    connection: AzureConnection;
    token: string;
    projectName: string;
    repository: { id: string; name: string; remoteUrl?: string };
  }> {
    const connection = this.findAzureConnection(connectionId);
    if (!connection) throw new Error("Azure DevOps connection not found.");
    const token = this.credentialStore.getSecret(connection.tokenRef);
    if (!token) throw new Error("PAT is missing.");

    const normalized = normalizeRemoteUrl(remoteUrl);
    const projects = (await this.azureApi.listProjects(connection, token)) as Array<{ id: string; name: string }>;
    const filteredProjects = connection.projectFilters?.length
      ? projects.filter((p) => connection.projectFilters!.includes(p.name) || connection.projectFilters!.includes(p.id))
      : projects;

    for (const project of filteredProjects) {
      const repos = (await this.azureApi.listRepositories(connection, token, project.name)) as Array<{
        id: string;
        name: string;
        remoteUrl?: string;
      }>;
      for (const repo of repos) {
        if (normalizeRemoteUrl(repo.remoteUrl || "") === normalized) {
          return { connection, token, projectName: project.name, repository: repo };
        }
      }
    }
    throw new Error("Could not find a matching Azure DevOps repository for this workspace.");
  }

  async listRemoteBranches(connectionId: string, remoteUrl: string): Promise<string[]> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token, projectName, repository } = await this.resolveRepository(connectionId, remoteUrl);
    const refs = (await this.azureApi.listRepositoryRefs(
      connection,
      token,
      projectName,
      repository.id,
      "heads",
    )) as Array<{ name?: string }>;
    return refs.map((ref) => stripRefsPrefix(ref.name || ""));
  }

  async createPullRequestForWorkspace({
    remoteUrl,
    sourceBranch,
    targetBranch,
    title,
    description,
    isDraft = false,
    connectionId = "",
    workspaceProfileId = "",
  }: {
    remoteUrl: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description?: string;
    isDraft?: boolean;
    connectionId?: string;
    /** Owner profile of the originating workspace — the connection must live in the same profile. */
    workspaceProfileId?: string;
  }): Promise<{ pullRequestId: unknown; url: string; title: unknown }> {
    const connection =
      (connectionId && this.findAzureConnection(connectionId)) || this.findConnectionForRemote(remoteUrl);
    if (!connection) throw new Error("No Azure DevOps connection found for this repository.");
    // The PR is owned by the workspace's profile; publishing through another
    // profile's connection would use bindings the caller's profile doesn't
    // own. Refuse with a pointer to the right profile.
    const connectionProfileId = (connection as { profileId?: string }).profileId || "default";
    if (workspaceProfileId && connectionProfileId !== workspaceProfileId) {
      throw new Error(
        `Cross-profile refused: connection ${connection.id} belongs to profile ${connectionProfileId}, ` +
          `but this workspace is in profile ${workspaceProfileId}. Create the PR from a workspace in ` +
          `profile ${connectionProfileId}, or add a connection to profile ${workspaceProfileId}.`,
      );
    }
    this.setAuditContext({ connectionId: connection.id, userInitiated: true });
    const { token, projectName, repository } = await this.resolveRepository(connection.id, remoteUrl);
    const result = (await this.azureApi.createPullRequest(connection, token, projectName, repository.id, {
      title,
      description,
      sourceBranch,
      targetBranch,
      isDraft,
    })) as { pullRequestId?: unknown; _links?: { web?: { href?: string } }; title?: unknown };
    return {
      pullRequestId: result.pullRequestId,
      url: result._links?.web?.href || "",
      title: result.title,
    };
  }

  // ---------------------------------------------------------------------------
  // Quick Fix — forward flow: pick repo/branch → checkout → workspace → PR
  // ---------------------------------------------------------------------------

  buildPrKey(connectionId: string, repositoryId: string, pullRequestId: string | number): string {
    return createPullRequestKey(connectionId, repositoryId, pullRequestId);
  }

  async listQuickFixProjects(connectionId: string): Promise<Array<{ id: string; name: string }>> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    const projects = (await this.azureApi.listProjects(connection, token)) as Array<{ id: string; name: string }>;
    const filtered = connection.projectFilters?.length
      ? projects.filter((p) => connection.projectFilters!.includes(p.name) || connection.projectFilters!.includes(p.id))
      : projects;
    return filtered.map((p) => ({ id: p.id, name: p.name }));
  }

  async listQuickFixRepositories(
    connectionId: string,
    projectName: string,
  ): Promise<Array<{ id: string; name: string; remoteUrl?: string }>> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    const repos = (await this.azureApi.listRepositories(connection, token, projectName)) as Array<{
      id: string;
      name: string;
      remoteUrl?: string;
    }>;
    const filtered = connection.repositoryFilters?.length
      ? repos.filter(
          (r) => connection.repositoryFilters!.includes(r.id) || connection.repositoryFilters!.includes(r.name),
        )
      : repos;
    return filtered.map((r) => ({ id: r.id, name: r.name, remoteUrl: r.remoteUrl }));
  }

  async listQuickFixBranches(connectionId: string, projectName: string, repositoryId: string): Promise<string[]> {
    this.setAuditContext({ connectionId, userInitiated: true });
    const { connection, token } = this.resolveAzureConnectionAndToken(connectionId);
    const refs = (await this.azureApi.listRepositoryRefs(
      connection,
      token,
      projectName,
      repositoryId,
      "heads",
    )) as Array<{ name?: string }>;
    return refs.map((ref) => stripRefsPrefix(ref.name || ""));
  }

  async openQuickFixWorkspace({
    state,
    connectionId,
    projectName,
    repositoryId,
    repositoryName,
    remoteUrl,
    baseBranch,
    newBranchName,
    callerProfileId = "",
  }: {
    state: { workspaces: ReviewWorkspace[]; windowSlots?: Array<{ profileId?: string }>; tabTemplates?: unknown[] };
    connectionId: string;
    projectName: string;
    repositoryId: string;
    repositoryName: string;
    remoteUrl: string;
    baseBranch: string;
    newBranchName: string;
    /** Profile of the window that initiated the action. Refusing on
     * mismatch keeps a remote/mobile client on profile B from spawning
     * a profile-A quickfix workspace on disk. */
    callerProfileId?: string;
  }): Promise<{ workspace: ReviewWorkspace; parentWorkspaceId: string }> {
    const repository = { id: repositoryId, name: repositoryName, remoteUrl };

    const result = await this.openQuickFixWorkspaceCore(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { state: state as any, connectionId, baseBranch, newBranchName, callerProfileId },
      {
        prepareQuickFixCheckout: ({ connection, token, reviewRoot }) =>
          this.prepareQuickFixCheckout({
            connection,
            token,
            reviewRoot,
            baseBranch,
            newBranchName,
            repoPathSegment: repositoryName,
            login: (connection as AzureConnection).login,
            ensureCacheRepo: () =>
              this.ensureCacheRepo({ connection: connection as AzureConnection, token, repository, reviewRoot }),
          }),
        buildQuickFixMetadata: ({ connection, checkout, parentWorkspaceId }) => ({
          review: {
            provider: "azure-devops",
            prKey: "",
            connectionId,
            orgUrl: (connection as AzureConnection).orgUrl || "",
            parentWorkspaceId,
            project: undefined,
            repository: { id: repositoryId, name: repositoryName, remoteUrl },
            pullRequest: undefined,
            role: "author",
            checkout: {
              mode: "managed-worktree",
              rootPath: checkout.rootPath,
              cacheRepoPath: checkout.cacheRepoPath || "",
            },
          },
          quickfix: {
            connectionId,
            projectName,
            repositoryId,
            repositoryName,
            remoteUrl,
            baseBranch,
            parentWorkspaceId,
          },
        }),
      },
    );
    return result as unknown as { workspace: ReviewWorkspace; parentWorkspaceId: string };
  }
}

export {
  AZURE_REVIEW_COLOR,
  AZURE_REVIEW_ICON,
  getDefaultReviewRoot,
  createPullRequestKey,
  normalizeConnectionInput,
  normalizeRemoteUrl,
  normalizeReviewRoot,
  shortPathKey,
  stripRefsPrefix,
} from "./azure-devops-utils.js";
