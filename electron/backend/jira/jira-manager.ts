/* eslint-disable @typescript-eslint/no-explicit-any -- Jira Cloud/DC payload shapes are versioned and normalized at this boundary. */
import type { CredentialStore } from "../shared/credential-store.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createSecureContext } from "node:tls";
import { readFile } from "node:fs/promises";
// Jira requests go through npm undici's own fetch/FormData, never the global
// ones: the PFX dispatcher is an undici Agent, and Electron's bundled fetch
// (a different undici major) rejects it and stringifies a foreign FormData.
import { Agent, fetch as undiciFetch, FormData } from "undici";
import { getLogger } from "../logger.js";
import { JIRA_SIGN_IN_CODES } from "../../shared/jira-error-codes.js";
import { errorCauseCode, JiraRequestError, type JiraRequestErrorCode } from "./jira-request-error.js";
import { logJiraFailure, logJiraRecovered } from "./jira-failure-log.js";
import { describePfxFailure, toJiraRequestError, type JiraRequestStage } from "./jira-transport-errors.js";

export { JiraRequestError, type JiraRequestErrorCode };

const log = getLogger("jira");
const MAX_ERROR_BODY_BYTES = 4096;
const JIRA_COMMENTS_PAGE = 100;
/** A thread longer than this is cut to its newest comments. */
export const JIRA_COMMENTS_MAX = 1000;

/** Time a write must still have when it leaves; with less, it is not sent rather than likely to end `unknown`. */
const JIRA_WRITE_MIN_WINDOW_MS = 5_000;

const callBudget = new AsyncLocalStorage<{ deadlineAt: number; open: boolean }>();

/**
 * Runs `work` with every Jira request it makes bounded by ONE deadline instead of 25 s each, for a caller that cannot
 * wait longer (a remote request is cancelled by the mobile relay at 30 s). A request that would start after the
 * deadline is refused before it is sent (`notSent`), so a write never leaves once the caller can no longer hear its
 * answer. Work that outlives `work` (a timer it scheduled) is not bound by it.
 */
export async function withinJiraCallBudget<T>(budgetMs: number, work: () => Promise<T>): Promise<T> {
  const budget = { deadlineAt: Date.now() + budgetMs, open: true };
  try {
    return await callBudget.run(budget, work);
  } finally {
    budget.open = false;
  }
}
const refusalLoggedAt = new Map<string, number>();

function normalizeJiraApiBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/$/, "");
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function safeRefreshErrorMessage(code: JiraRequestErrorCode): string {
  switch (code) {
    case "permission-denied":
      return "Jira denied access while refreshing this data.";
    case "auth-expired":
      return "Jira sign-in is required to refresh this data.";
    case "rate-limited":
      return "Jira is rate limiting refresh requests.";
    case "network":
      return "Jira could not be reached while refreshing this data.";
    case "not-found":
      return "Jira no longer provides this data.";
    case "unsupported":
      return "This Jira endpoint is not supported by the server.";
    case "configuration-incomplete":
      return "The Jira connection needs configuration.";
    default:
      return "Jira could not refresh this data.";
  }
}

function jqlStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function normalizeJiraProjectKeys(value: readonly string[] | undefined, maxKeys = 50): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxKeys) throw new Error(`Select no more than ${maxKeys} Jira projects.`);
  const keys = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("A Jira project key is invalid.");
    const key = item.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(key)) throw new Error("A Jira project key is invalid.");
    keys.add(key);
  }
  return [...keys].sort();
}

export function jiraProjectScopeClause(projectKeys: readonly string[] | undefined): string | undefined {
  const keys = normalizeJiraProjectKeys(projectKeys, 100);
  return keys.length ? `project IN (${keys.map(jqlStringLiteral).join(", ")})` : undefined;
}

export function appendJiraJqlClause(jql: string, clause: string): string {
  const query = jql.trim();
  const split = splitJiraOrderBy(query);
  const combined = split.where ? `(${split.where}) AND ${clause}` : clause;
  const result = split.orderBy ? `${combined} ${split.orderBy}` : combined;
  if (result.length > 2000) throw new Error("JQL is too long (maximum 2000 characters).");
  return result;
}

export function applyJiraProjectScope(jql: string, projectKeys: readonly string[] | undefined): string {
  const clause = jiraProjectScopeClause(projectKeys);
  if (!clause) return jql.trim();
  const split = splitJiraOrderBy(jql.trim());
  if (split.where === clause || isCanonicalScopedWhere(split.where, clause)) return jql.trim();
  return appendJiraJqlClause(jql, clause);
}

function isCanonicalScopedWhere(where: string, clause: string): boolean {
  const suffix = ` AND ${clause}`;
  if (!where.endsWith(suffix)) return false;
  const group = where.slice(0, -suffix.length).trim();
  if (!group.startsWith("(") || !group.endsWith(")")) return false;
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let index = 0; index < group.length; index++) {
    const character = group[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth === 0 && index !== group.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && quote === undefined;
}

function splitJiraOrderBy(jql: string): { where: string; orderBy: string } {
  let quote: '"' | "'" | undefined;
  let depth = 0;
  for (let index = 0; index < jql.length; index++) {
    const character = jql[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth++;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && (index === 0 || /\s/.test(jql[index - 1] || ""))) {
      const match = /^ORDER\s+BY\b/i.exec(jql.slice(index));
      if (match)
        return {
          where: jql.slice(0, index).trim(),
          orderBy: jql.slice(index).trim(),
        };
    }
  }
  return { where: jql, orderBy: "" };
}
import { createHash } from "node:crypto";
import { jiraDescriptionMarkdown } from "./jira-description.js";
import { sharedJiraReadScheduler } from "./jira-read-scheduler.js";
import type { createJiraCache } from "./jira-cache.js";

export type JiraCache = ReturnType<typeof createJiraCache>;
export interface JiraCacheMetadata {
  source: "cache" | "network";
  fetchedAt: number;
  stale: boolean;
  refreshError?: { code: JiraRequestErrorCode; message: string; retryAfterMs?: number };
}
export interface JiraReadOptions {
  cacheOnly?: boolean;
  forceRefresh?: boolean;
  refreshInBackground?: boolean;
  projectKeys?: readonly string[];
}

export interface JiraRecentSearch {
  jql: string;
  label?: string;
  usedAt: number;
}

export interface RecentJiraIssue {
  ref: JiraIssueRef;
  summary: string;
  status: string;
  statusCategory?: "new" | "indeterminate" | "done";
  issueType?: string;
  viewedAt: number;
}

export type JiraWriteReconcileResult = "applied" | "not-applied" | "unknown";
export type JiraWriteReconcileActor = { kind: "cloud"; accountId: string } | { kind: "data-center"; name: string };
export type JiraWriteReconcileInput = { fingerprint: string; actor?: JiraWriteReconcileActor; submittedAt: number };

export interface JiraConnection {
  id: string;
  profileId: string;
  label: string;
  issueKeyPrefixes?: string[];
  defaultJql?: string;
  projectKeys?: string[];
  pollSeconds?: number;
  enabled: boolean;
  deployment: "cloud" | "data-center";
  webUrl: string;
  apiBaseUrl: string;
  cloudId?: string;
  auth: {
    kind: "cloud-api-token" | "dc-pat" | "dc-apim";
    secretRef?: string;
    passphraseRef?: string;
    email?: string;
  };
  subscriptionHeaderName?: string;
  clientCertificatePath?: string;
  accountPurpose: "personal" | "technical";
  verifiedIdentity?: JiraUserRef;
  ownIdentity?: JiraUserRef;
  status?: "connected" | "needs-login" | "unavailable";
  health?: { state: JiraRequestErrorCode | "verified"; checkedAt: string; retryAfterMs?: number };
}

export type JiraConnectionHealthObserver = (event: {
  connection: JiraConnection;
  code?: JiraRequestErrorCode;
}) => Promise<void> | void;

export type JiraUserRef =
  | { kind: "cloud"; accountId: string; displayName: string }
  | { kind: "data-center"; key?: string; name: string; displayName: string };

export interface JiraIssueRef {
  provider: "jira";
  connectionId: string;
  issueId: string;
  issueKey: string;
}
export interface JiraIssue {
  ref: JiraIssueRef;
  summary: string;
  status: string;
  statusId?: string;
  statusCategory?: "new" | "indeterminate" | "done";
  issueType: string;
  projectKey: string;
  updated: string;
  assignee?: string;
  assigneeRef?: JiraUserRef;
  cache?: JiraCacheMetadata;
  priority?: string;
  reporter?: string;
  created?: string;
  resolution?: string;
  labels?: string[];
  components?: string[];
  versions?: string[];
  issueLinks?: Array<{
    type: string;
    direction: "inward" | "outward";
    issueKey: string;
    summary?: string;
    status?: string;
  }>;
  url: string;
  /** Present only on lazy issue detail responses; never included in inbox/search summaries. */
  description?: string;
  /** Safe semantic Markdown for detail rendering; plain description remains the preview/search value. */
  descriptionMarkdown?: string;
  /** Jira's own rendering of the description; untrusted HTML for the renderer to sanitize, never for agents. */
  descriptionHtml?: string;
  attachments?: JiraAttachment[];
}
export interface JiraAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}
export interface JiraSavedFilter {
  id: string;
  name: string;
  jql: string;
}
export interface JiraComment {
  id: string;
  author: string;
  created: string;
  updated?: string;
  body: string;
  bodyHtml?: string;
}
export interface JiraTransition {
  id: string;
  name: string;
  to: string;
  requiredFields: Array<{
    id: string;
    name: string;
    type: string;
    required: boolean;
    supported: boolean;
    allowedValues?: Array<{ value: string; label: string }>;
  }>;
}
export interface JiraBoard {
  id: number;
  name: string;
  type: "scrum" | "kanban";
  location?: { projectKey?: string; projectName?: string };
}

export interface JiraBoardQuickFilter {
  id: number;
  name: string;
  description?: string;
  jql: string;
  position: number;
}

const CLOUD_GATEWAY_ORIGIN = "https://api.atlassian.com";
const CLOUD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidCloudId(value: unknown): value is string {
  return typeof value === "string" && CLOUD_ID_PATTERN.test(value);
}

function cloudGatewayPath(cloudId: string): string {
  if (!isValidCloudId(cloudId)) throw new Error("Cloud Jira connection has an invalid cloudId.");
  return `/ex/jira/${cloudId}`;
}

/** The origin of a Jira Cloud site; credentials are only ever sent to it or to the gateway path of its cloudId. */
export function cloudSiteOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Jira site URL must be a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("Jira site URL must use HTTPS.");
  if (url.username || url.password) throw new Error("Jira site URL must not contain credentials.");
  return url.origin;
}

function safeUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(`${label} must not contain credentials, query, or fragment.`);
  return url;
}

export const JIRA_DONE_WITHIN_DAYS = [7, 14, 30, 90] as const;

function validHistoryLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 20) : 10;
}

/** Like Jira's Kanban sub-filter: the plain board view hides completed issues that have not changed recently. */
function jiraDoneWithinJql(mode: "issues" | "backlog" | "sprints", days: number | undefined): string | undefined {
  if (mode !== "issues" || days === undefined) return undefined;
  if (!(JIRA_DONE_WITHIN_DAYS as readonly number[]).includes(days))
    throw new Error("Invalid Jira completed-issue window.");
  return `(statusCategory != Done OR updated >= -${days}d)`;
}

export class JiraManager {
  private readonly requestScheduler = sharedJiraReadScheduler;
  private readonly cacheScopes = new Map<string, Set<string>>();
  private readonly cacheInflight = new Map<string, Promise<unknown>>();
  private readonly cacheEpochs = new Map<string, number>();
  private readonly scopeMemo = new Map<string, { configKey: string; scope: string }>();
  private readonly statusNameMemo = new Map<string, { expiresAt: number; names: Map<string, string> }>();
  private globalCacheEpoch = 0;
  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly fetchImpl: typeof fetch = undiciFetch as unknown as typeof fetch,
    private readonly persistentCache?: JiraCache,
  ) {}

  private healthObserver?: JiraConnectionHealthObserver;
  private readonly healthByConnection = new Map<string, "ok" | JiraRequestErrorCode>();

  /**
   * Told once per TRANSITION whether a connection's sign-in works (`code` undefined) or has stopped working
   * (`auth-expired`, `credential-missing`), whichever read or write noticed it. A `permission-denied` is per
   * resource and never changes connection health.
   */
  setHealthObserver(observer: JiraConnectionHealthObserver | undefined): void {
    this.healthObserver = observer;
  }

  private noteHealth(connection: JiraConnection, code?: JiraRequestErrorCode): void {
    const next = code === undefined ? "ok" : JIRA_SIGN_IN_CODES.has(code) ? code : undefined;
    if (!next || this.healthByConnection.get(connection.id) === next) return;
    this.healthByConnection.set(connection.id, next);
    try {
      void Promise.resolve(this.healthObserver?.({ connection, ...(next === "ok" ? {} : { code: next }) })).catch(
        (error: unknown) =>
          log.warn("jira connection health could not be recorded", {
            connectionId: connection.id,
            code: next,
            err: error instanceof Error ? error.name : "error",
          }),
      );
    } catch {
      /* An observer must never change what a request returns. */
    }
  }

  private noteSuccess(connection: JiraConnection): void {
    logJiraRecovered(connection.id, "http");
    this.noteHealth(connection);
  }

  /** The single exit for a failed request: a typed error with its cause, one transition-logged line, one health note. */
  private failRequest(
    connection: JiraConnection,
    error: unknown,
    stage: JiraRequestStage,
    url: URL | undefined,
    genericMessage?: string,
  ): JiraRequestError {
    const failure = toJiraRequestError(error, stage, genericMessage);
    this.noteHealth(connection, failure.code);
    const fields = {
      host: url?.host,
      stage,
      status: failure.statusCode,
      errCode: errorCauseCode(failure.cause),
      notSent: failure.notSent,
    };
    const environmental =
      !["permission-denied", "not-found", "unsupported", "unknown"].includes(failure.code) ||
      (failure.statusCode !== undefined && failure.statusCode >= 500);
    if (environmental) logJiraFailure({ connectionId: connection.id, scope: "http", code: failure.code }, fields);
    else log.debug("jira request refused", { connectionId: connection.id, code: failure.code, ...fields });
    return failure;
  }

  /** Reads a JSON body, turning an HTML or empty 200 (an SSO or proxy page) into a clear `unsupported` failure. */
  private async readJson(response: Response): Promise<any> {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (cause) {
      const contentType = (response.headers.get("content-type") || "none").replace(/[^\x20-\x7e]/g, "").slice(0, 80);
      logJiraFailure(
        { connectionId: "-", scope: `non-json:${response.status}`, code: "unsupported" },
        { status: response.status, contentType, bytes: text.length },
      );
      throw new JiraRequestError(
        "unsupported",
        "Jira answered with a web page instead of data. A sign-in page or proxy in front of Jira is probably intercepting API calls; check the Jira URL and that nothing needs a browser sign-in.",
        undefined,
        response.status,
        { cause },
      );
    }
  }

  getRecentSearches(connection: JiraConnection, limit = 10): JiraRecentSearch[] {
    return this.readHistory<JiraRecentSearch[]>(connection, "recent-searches:v1", [])
      .slice(0, validHistoryLimit(limit))
      .map((item) => ({ ...item }));
  }

  rememberSearch(connection: JiraConnection, input: { jql: string; label?: string }): void {
    const jql = input.jql.trim();
    const label = input.label?.trim().slice(0, 200);
    if (!jql || jql.length > 2000) return;
    const now = Date.now();
    const history = this.readHistory<JiraRecentSearch[]>(connection, "recent-searches:v1", []);
    const next = [
      { jql, ...(label ? { label } : {}), usedAt: now },
      ...history.filter((item) => item.jql !== jql),
    ].slice(0, 20);
    this.writeHistory(connection, "recent-searches:v1", next);
  }

  getRecentIssues(connection: JiraConnection, limit = 10): RecentJiraIssue[] {
    return this.readHistory<RecentJiraIssue[]>(connection, "recent-issues:v1", [])
      .slice(0, validHistoryLimit(limit))
      .map((item) => ({ ...item, ref: { ...item.ref } }));
  }

  rememberViewedIssue(connection: JiraConnection, ref: JiraIssueRef): void {
    if (
      ref.provider !== "jira" ||
      ref.connectionId !== connection.id ||
      !ref.issueId ||
      typeof ref.issueId !== "string"
    )
      return;
    const issue = this.safeReadAny<JiraIssue>(
      this.persistentCacheScope(connection),
      `issue-detail:v3:${ref.issueId}`,
    )?.value;
    if (!issue) return;
    const summary: RecentJiraIssue = {
      ref: issue.ref,
      summary: issue.summary.slice(0, 32_000),
      status: issue.status.slice(0, 256),
      ...(issue.statusCategory ? { statusCategory: issue.statusCategory } : {}),
      ...(issue.issueType ? { issueType: issue.issueType.slice(0, 256) } : {}),
      viewedAt: Date.now(),
    };
    const history = this.readHistory<RecentJiraIssue[]>(connection, "recent-issues:v1", []);
    const next = [summary, ...history.filter((item) => item.ref.issueId !== ref.issueId)].slice(0, 20);
    this.writeHistory(connection, "recent-issues:v1", next);
  }

  async verify(connection: JiraConnection): Promise<{ identity: JiraUserRef; serverTitle: string; cloudId?: string }> {
    let resolvedCloudId: string | undefined;
    let response: Response;
    if (connection.auth.kind === "cloud-api-token") {
      const host = new URL(cloudSiteOrigin(connection.webUrl)).host;
      const rejected = new JiraRequestError(
        "auth-expired",
        `Jira rejected the email or API token. Check the email, that the token has not expired or been revoked, and that the account can access ${host}.`,
        undefined,
        401,
      );
      const forbidden = new JiraRequestError(
        "permission-denied",
        `This account is not allowed to read its own profile on ${host}. Check its Jira permissions and, for a scoped API token, that it includes the read:jira-user scope.`,
        undefined,
        403,
      );
      const attempt = async (candidate: JiraConnection): Promise<Response> => {
        try {
          return await this.request(candidate, "/myself");
        } catch (error) {
          if (error instanceof JiraRequestError && error.statusCode === 403) throw forbidden;
          if (error instanceof JiraRequestError && error.statusCode === 401) throw rejected;
          throw error;
        }
      };
      try {
        response = await attempt(connection);
      } catch (error) {
        if (error !== rejected || connection.cloudId) throw error;
        const cloudId = await this.resolveCloudId(connection.webUrl, rejected);
        response = await attempt({ ...connection, cloudId });
        resolvedCloudId = cloudId;
      }
    } else {
      response = await this.request(connection, "/myself");
    }
    const raw = (await this.readJson(response)) as Record<string, unknown>;
    const identity: JiraUserRef =
      connection.deployment === "cloud"
        ? {
            kind: "cloud",
            accountId: String(raw.accountId || ""),
            displayName: String(raw.displayName || raw.name || "Jira user"),
          }
        : {
            kind: "data-center",
            ...(raw.key ? { key: String(raw.key) } : {}),
            name: String(raw.name || raw.key || ""),
            displayName: String(raw.displayName || raw.name || "Jira user"),
          };
    if (!("accountId" in identity ? identity.accountId : identity.name))
      throw new Error("Jira did not return a usable current-user identity.");
    return {
      identity,
      serverTitle: connection.deployment === "cloud" ? "Jira Cloud" : "Jira Data Center",
      ...(resolvedCloudId ? { cloudId: resolvedCloudId } : {}),
    };
  }

  /**
   * A scoped API token is refused by the site host and only works through the Atlassian gateway, which is addressed
   * by cloudId. The lookup is unauthenticated on purpose: nothing secret is sent before the id is validated.
   */
  private async resolveCloudId(webUrl: string, rejected: JiraRequestError): Promise<string> {
    const url = new URL("/_edge/tenant_info", cloudSiteOrigin(webUrl));
    const unresolved = (reason: string) =>
      new JiraRequestError(
        rejected.code,
        `${rejected.message} If the token is scoped, Atlassian also needs the site's cloud id, which could not be read from ${url.host} (${reason}). Check the site URL.`,
        undefined,
        401,
      );
    let body: unknown;
    try {
      const response = await this.fetchReadResponse(
        url,
        new Headers({ Accept: "application/json" }),
        Date.now() + 10_000,
        64 * 1024,
        "The Jira site answered with an unexpectedly large response.",
      );
      if (!response.ok) throw unresolved(`HTTP ${response.status}`);
      body = JSON.parse(await response.text());
    } catch (error) {
      if (error instanceof JiraRequestError && error.message.endsWith("Check the site URL.")) throw error;
      throw unresolved(error instanceof SyntaxError ? "unexpected answer" : "request failed");
    }
    const cloudId = (body as { cloudId?: unknown } | null)?.cloudId;
    if (!isValidCloudId(cloudId)) throw unresolved("invalid cloud id");
    return cloudId;
  }

  async verifyUserIdentity(connection: JiraConnection, userId: string): Promise<JiraUserRef> {
    if (!userId.trim() || userId.length > 255) throw new Error("Jira user identifier is invalid.");
    const param = connection.deployment === "cloud" ? "accountId" : "username";
    const response = await this.request(connection, `/user?${param}=${encodeURIComponent(userId.trim())}`);
    const raw = (await this.readJson(response)) as Record<string, unknown>;
    if (connection.deployment === "cloud") {
      const accountId = String(raw.accountId || "");
      if (!accountId) throw new Error("Jira did not find that account id.");
      return { kind: "cloud", accountId, displayName: String(raw.displayName || raw.name || accountId) };
    }
    const name = String(raw.name || raw.key || "");
    if (!name) throw new Error("Jira did not find that user.");
    return {
      kind: "data-center",
      ...(raw.key ? { key: String(raw.key) } : {}),
      name,
      displayName: String(raw.displayName || name),
    };
  }

  async searchUsers(connection: JiraConnection, query: string, limit = 25): Promise<JiraUserRef[]> {
    const normalized = query.trim();
    if (normalized.length < 1 || normalized.length > 100)
      throw new Error("Jira user search must contain 1–100 characters.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid Jira user search page size.");
    const param = connection.deployment === "cloud" ? "query" : "username";
    const response = await this.request(
      connection,
      `/user/search?${param}=${encodeURIComponent(normalized)}&maxResults=${limit}`,
    );
    const rows = (await this.readJson(response)) as Array<Record<string, any>>;
    const users: JiraUserRef[] = [];
    for (const row of (Array.isArray(rows) ? rows : []).slice(0, limit)) {
      const displayName = String(row.displayName || row.name || row.accountId || "").slice(0, 256);
      if (connection.deployment === "cloud") {
        const accountId = String(row.accountId || "").slice(0, 255);
        if (accountId) users.push({ kind: "cloud", accountId, displayName: displayName || accountId });
        continue;
      }
      const name = String(row.name || row.key || "").slice(0, 255);
      if (name)
        users.push({
          kind: "data-center",
          ...(row.key ? { key: String(row.key).slice(0, 255) } : {}),
          name,
          displayName: displayName || name,
        });
    }
    return users;
  }

  async projects(connection: JiraConnection): Promise<Array<{ id: string; key: string; name: string }>> {
    const result = await this.cachedRead(
      connection,
      "projects:v1:limit500",
      {},
      async () => {
        const path =
          connection.deployment === "cloud" ? "/project/search?startAt=0&maxResults=500" : "/project?maxResults=500";
        const response = await this.request(
          connection,
          path,
          undefined,
          2 * 1024 * 1024,
          "Jira project catalog exceeds 2 MiB.",
        );
        const body = (await this.readJson(response)) as unknown;
        const rows = Array.isArray(body)
          ? body
          : body && typeof body === "object" && Array.isArray((body as { values?: unknown }).values)
            ? (body as { values: unknown[] }).values
            : [];
        const projects = rows.slice(0, 500).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const project = value as Record<string, unknown>;
          const id = String(project.id || "").slice(0, 128);
          const key = String(project.key || "")
            .trim()
            .toUpperCase();
          const name = String(project.name || "").slice(0, 500);
          if (!id || !/^[A-Z][A-Z0-9_]{0,19}$/.test(key) || !name) return [];
          return [{ id, key, name }];
        });
        return { projects };
      },
      5 * 60_000,
    );
    if (!result) throw new JiraRequestError("network", "Jira project catalog did not return a result.");
    return result.projects;
  }

  async favoriteFilters(connection: JiraConnection): Promise<Array<{ id: string; name: string }>> {
    const response = await this.request(connection, "/filter/favourite?maxResults=20");
    const items = (await this.readJson(response)) as Array<Record<string, unknown>>;
    return items.slice(0, 20).flatMap((item) => {
      const id = String(item.id || "");
      return /^\d{1,20}$/.test(id) ? [{ id, name: String(item.name || id).slice(0, 100) }] : [];
    });
  }
  async savedFilter(connection: JiraConnection, filterId: string): Promise<JiraSavedFilter> {
    if (!/^\d{1,20}$/.test(filterId)) throw new Error("Jira filter ID is invalid.");
    const response = await this.request(connection, `/filter/${filterId}`);
    const item = (await this.readJson(response)) as Record<string, unknown>;
    if (String(item.id) !== filterId || typeof item.jql !== "string" || item.jql.length > 2000)
      throw new Error("Jira saved filter is unavailable or has invalid JQL.");
    return { id: filterId, name: String(item.name || filterId).slice(0, 100), jql: item.jql };
  }

  async search(connection: JiraConnection, query: string, limit = 50): Promise<JiraIssue[]> {
    return (await this.searchPage(connection, query, limit)).issues;
  }

  async searchPage(
    connection: JiraConnection,
    query: string,
    limit?: number,
    cursor?: string,
  ): Promise<{
    issues: JiraIssue[];
    hasMore: boolean;
    nextCursor?: string;
    truncated: boolean;
    cache: JiraCacheMetadata;
  }>;
  async searchPage(
    connection: JiraConnection,
    query: string,
    limit: number | undefined,
    cursor: string | undefined,
    options: JiraReadOptions,
  ): Promise<{
    issues: JiraIssue[];
    hasMore: boolean;
    nextCursor?: string;
    truncated: boolean;
    cache: JiraCacheMetadata;
  } | null>;
  async searchPage(
    connection: JiraConnection,
    query: string,
    limit = 50,
    cursor?: string,
    options: JiraReadOptions = {},
  ): Promise<{
    issues: JiraIssue[];
    hasMore: boolean;
    nextCursor?: string;
    truncated: boolean;
    cache: JiraCacheMetadata;
  } | null> {
    const { jql, maxResults } = this.prepareSearch(connection, query, limit, options);
    const key = `search-page:v1:${JSON.stringify({ jql, maxResults, cursor: cursor || "" })}`;
    return this.cachedRead(
      connection,
      key,
      options,
      () => this.fetchSearchPage(connection, jql, maxResults, cursor),
      30_000,
    );
  }

  // Alert polling only reads id, key and `updated`: ask for nothing else and keep it out of the cache.
  async pollSearchPage(
    connection: JiraConnection,
    query: string,
    limit: number,
    cursor?: string,
  ): Promise<{ issues: JiraIssue[]; hasMore: boolean; nextCursor?: string }> {
    const { jql, maxResults } = this.prepareSearch(connection, query, limit, {});
    const { issues, hasMore, nextCursor } = await this.fetchSearchPage(connection, jql, maxResults, cursor, "updated");
    return { issues, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  }

  private prepareSearch(
    connection: JiraConnection,
    query: string,
    limit: number,
    options: JiraReadOptions,
  ): { jql: string; maxResults: number } {
    const effectiveProjectKeys = normalizeJiraProjectKeys(
      options.projectKeys === undefined ? connection.projectKeys : options.projectKeys,
      options.projectKeys === undefined ? 100 : 50,
    );
    const jql = applyJiraProjectScope(query.trim() || "ORDER BY updated DESC", effectiveProjectKeys);
    if (jql.length > 2000) throw new Error("JQL is too long (maximum 2000 characters).");
    return { jql, maxResults: Math.max(1, Math.min(100, Math.trunc(limit))) };
  }

  private async fetchSearchPage(
    connection: JiraConnection,
    jql: string,
    maxResults: number,
    cursor?: string,
    fields = "summary,status,issuetype,project,updated,created,assignee,priority",
  ): Promise<{ issues: JiraIssue[]; hasMore: boolean; nextCursor?: string; truncated: boolean }> {
    const cloud = connection.deployment === "cloud";
    const endpoint = cloud ? "/search/jql" : "/search";
    const url = new URL(endpoint.replace(/^\//, ""), this.apiRoot(connection));
    url.searchParams.set("jql", jql);
    url.searchParams.set("maxResults", String(maxResults));
    url.searchParams.set("fields", fields);
    if (cursor) {
      if (cursor.length > 2048) throw new Error("Jira search cursor is invalid.");
      if (cloud) url.searchParams.set("nextPageToken", cursor);
      else {
        if (!/^\d{1,12}$/.test(cursor)) throw new Error("Jira search cursor is invalid.");
        url.searchParams.set("startAt", cursor);
      }
    }
    const response = await this.fetchAuthenticated(connection, url);
    const body = (await this.readJson(response)) as {
      issues?: Array<Record<string, any>>;
      total?: number;
      startAt?: number;
      nextPageToken?: string;
      isLast?: boolean;
    };
    const issues = (body.issues || []).slice(0, maxResults).map((issue) => this.normalizeIssue(connection, issue));
    const nextStart = (Number(body.startAt) || (cursor ? Number(cursor) : 0)) + issues.length;
    const hasMore = cloud
      ? Boolean(body.nextPageToken) && body.isLast !== true
      : Number.isFinite(body.total) && nextStart < Number(body.total);
    const nextCursor = hasMore ? (cloud ? String(body.nextPageToken) : String(nextStart)) : undefined;
    return { issues, hasMore, ...(nextCursor ? { nextCursor } : {}), truncated: hasMore };
  }

  async issue(connection: JiraConnection, issueIdOrKey: string): Promise<JiraIssue & { cache: JiraCacheMetadata }>;
  async issue(
    connection: JiraConnection,
    issueIdOrKey: string,
    options: JiraReadOptions,
  ): Promise<(JiraIssue & { cache: JiraCacheMetadata }) | null>;
  async issue(
    connection: JiraConnection,
    issueIdOrKey: string,
    options: JiraReadOptions = {},
  ): Promise<(JiraIssue & { cache: JiraCacheMetadata }) | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueIdOrKey)) throw new Error("Invalid Jira issue id or key.");
    // v2 invalidates normalized payloads produced before Jira wiki panel/code macro handling.
    const cacheKey = `issue-detail:v3:${issueIdOrKey}`;
    return this.cachedRead(connection, cacheKey, options, () => this.fetchIssue(connection, issueIdOrKey), 60_000);
  }

  private async fetchIssue(connection: JiraConnection, issueIdOrKey: string): Promise<JiraIssue> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueIdOrKey)) throw new Error("Invalid Jira issue id or key.");
    const fields =
      "summary,status,issuetype,project,updated,created,assignee,reporter,priority,resolution,labels,components,fixVersions,description,attachment,issuelinks";
    const response = await this.request(
      connection,
      `/issue/${encodeURIComponent(issueIdOrKey)}?fields=${fields}&expand=renderedFields`,
    );
    const raw = (await this.readJson(response)) as Record<string, any>;
    const issue = this.normalizeIssue(connection, raw);
    const description = safeJiraText(raw.fields?.description);
    if (description) {
      issue.description = description;
    }
    const markdown = jiraDescriptionMarkdown(raw.fields?.description);
    if (markdown) issue.descriptionMarkdown = markdown;
    const descriptionHtml = boundedRenderedHtml(raw.renderedFields?.description);
    if (descriptionHtml) issue.descriptionHtml = descriptionHtml;
    const attachments = normalizeAttachments(raw.fields?.attachment);
    if (attachments.length) issue.attachments = attachments;
    return issue;
  }

  /** Fresh, uncached state used only to reconcile an ambiguous transition result. */
  async freshIssueState(connection: JiraConnection, issueId: string): Promise<{ status: string; updated: string }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error("Invalid Jira issue id.");
    const response = await this.request(connection, `/issue/${encodeURIComponent(issueId)}?fields=status,updated`);
    const body = (await this.readJson(response)) as { fields?: { status?: { name?: unknown }; updated?: unknown } };
    return {
      status: String(body.fields?.status?.name || "Unknown"),
      updated: String(body.fields?.updated || ""),
    };
  }

  async comments(connection: JiraConnection, issueId: string): Promise<JiraComment[]> {
    return (await this.commentsWithTotal(connection, issueId)).comments;
  }

  /**
   * Up to `JIRA_COMMENTS_MAX` comments, oldest first. A longer thread keeps its newest comments: `total` is what
   * Jira holds and `truncated` says the older ones (or an unreadable tail) are missing.
   */
  async commentsWithTotal(
    connection: JiraConnection,
    issueId: string,
  ): Promise<{ comments: JiraComment[]; total: number; truncated: boolean }> {
    const deadlineAt = Date.now() + 25_000;
    const base = `/issue/${encodeURIComponent(issueId)}/comment`;
    const fetchPage = async (startAt: number) => {
      const response = await this.request(
        connection,
        `${base}?startAt=${startAt}&maxResults=${JIRA_COMMENTS_PAGE}&expand=renderedBody`,
        this.remainingBudget(deadlineAt),
      );
      const body = (await this.readJson(response)) as {
        comments?: Array<Record<string, any>>;
        total?: number;
        startAt?: number;
      };
      const rows = Array.isArray(body.comments) ? body.comments.slice(0, JIRA_COMMENTS_PAGE) : [];
      return { rows, total: Number.isFinite(body.total) ? Number(body.total) : undefined };
    };
    let first = await fetchPage(0);
    const total = Math.max(first.total ?? first.rows.length, first.rows.length);
    const offset = Math.max(0, total - JIRA_COMMENTS_MAX);
    if (offset > 0) first = await fetchPage(offset);
    const rows = [...first.rows];
    let next = offset + first.rows.length;
    while (first.rows.length && next < total && rows.length < JIRA_COMMENTS_MAX) {
      first = await fetchPage(next);
      rows.push(...first.rows);
      next += first.rows.length;
    }
    return {
      comments: rows.map((comment) => ({
        id: String(comment.id),
        author: String(comment.author?.displayName || "Jira user"),
        created: String(comment.created || ""),
        ...(comment.updated ? { updated: String(comment.updated) } : {}),
        body: safeJiraText(comment.body) || "",
        ...(boundedRenderedHtml(comment.renderedBody) ? { bodyHtml: boundedRenderedHtml(comment.renderedBody) } : {}),
      })),
      total,
      truncated: offset > 0 || offset + rows.length < total,
    };
  }

  /**
   * Reconcile a comment write without returning comment text to the caller.
   * `not-applied` is returned only after a complete bounded walk; capped or
   * malformed pagination stays `unknown`.
   */
  async reconcileCommentWrite(
    connection: JiraConnection,
    issueId: string,
    input: JiraWriteReconcileInput,
  ): Promise<JiraWriteReconcileResult> {
    const pages = await this.commentPages(connection, issueId);
    for (const row of pages.rows) {
      const createdAt = Date.parse(String(row.created || ""));
      if (!Number.isFinite(createdAt) || createdAt < input.submittedAt - 5 * 60_000) continue;
      if (input.actor && !sameJiraAuthor(row.author, input.actor)) continue;
      if (hashWriteText(safeJiraText(row.body)) === input.fingerprint) return "applied";
    }
    return pages.complete ? "not-applied" : "unknown";
  }

  /** Reconcile a worklog by exact duration/start/comment hash and effective Jira author. */
  async reconcileWorklogWrite(
    connection: JiraConnection,
    issueId: string,
    input: JiraWriteReconcileInput & { seconds: number; started: string; commentHash: string },
  ): Promise<JiraWriteReconcileResult> {
    const basePath = `/issue/${encodeURIComponent(issueId)}/worklog`;
    const deadlineAt = Date.now() + 25_000;
    const rows: Array<Record<string, any>> = [];
    let startAt = 0;
    let complete = false;
    for (let requestIndex = 0; requestIndex < 5; requestIndex++) {
      const response = await this.request(
        connection,
        `${basePath}?startAt=${startAt}&maxResults=100`,
        this.remainingBudget(deadlineAt),
      );
      const body = (await this.readJson(response)) as {
        worklogs?: Array<Record<string, any>>;
        total?: number;
        startAt?: number;
      };
      if (!Array.isArray(body.worklogs)) break;
      const page = body.worklogs.slice(0, 100);
      rows.push(...page);
      startAt = (Number(body.startAt) || startAt) + page.length;
      if (Number.isFinite(body.total) && startAt >= Number(body.total)) {
        complete = true;
        break;
      }
      if (page.length < 100) {
        complete = true;
        break;
      }
      if (!page.length) {
        complete = true;
        break;
      }
    }
    for (const row of rows) {
      const createdAt = Date.parse(String(row.created || ""));
      if (!Number.isFinite(createdAt) || createdAt < input.submittedAt - 5 * 60_000) continue;
      if (input.actor && !sameJiraAuthor(row.author, input.actor)) continue;
      if (
        Number(row.timeSpentSeconds) === input.seconds &&
        Date.parse(String(row.started || "")) === Date.parse(input.started) &&
        hashWriteText(safeJiraText(row.comment)) === input.commentHash
      )
        return "applied";
    }
    return complete ? "not-applied" : "unknown";
  }

  async linkedWork(
    connection: JiraConnection,
    issueId: string,
  ): Promise<Array<{ id: string; url: string; title: string; relationship?: string }>> {
    const response = await this.request(connection, `/issue/${encodeURIComponent(issueId)}/remotelink`);
    const rows = (await this.readJson(response)) as Array<Record<string, any>>;
    return (Array.isArray(rows) ? rows : []).slice(0, 100).flatMap((row) => {
      const url = String(row.object?.url || "");
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return [];
      } catch {
        return [];
      }
      return [
        {
          id: String(row.id || ""),
          url,
          title: String(row.object?.title || "Linked work"),
          ...(row.relationship ? { relationship: String(row.relationship) } : {}),
        },
      ];
    });
  }

  /** Exact remote-link lookup for safe reconciliation of an ambiguous PR link POST. */
  async hasRemoteLink(connection: JiraConnection, issueId: string, globalId: string): Promise<boolean> {
    if (!globalId || globalId.length > 1000) throw new Error("Remote link id is invalid.");
    const response = await this.request(
      connection,
      `/issue/${encodeURIComponent(issueId)}/remotelink?globalId=${encodeURIComponent(globalId)}`,
    );
    const rows = (await this.readJson(response)) as Array<Record<string, unknown>>;
    return Array.isArray(rows) && rows.some((row) => row.globalId === globalId);
  }

  async attachmentBytes(
    connection: JiraConnection,
    issueId: string,
    attachmentId: string,
    options: { maxBytes?: number; maxDurationMs?: number; imageOnly?: boolean } = {},
  ): Promise<{ fileName: string; mediaType: string; bytes: Uint8Array }> {
    if (!/^\d{1,32}$/.test(attachmentId)) throw new Error("Invalid Jira attachment id.");
    const deadlineAt = Date.now() + Math.min(25_000, Math.max(1, options.maxDurationMs ?? 25_000));
    const maxBytes = Math.min(10 * 1024 * 1024, Math.max(1, options.maxBytes || 10 * 1024 * 1024));
    const issueResponse = await this.request(
      connection,
      `/issue/${encodeURIComponent(issueId)}?fields=attachment`,
      this.remainingBudget(deadlineAt),
    );
    const issue = (await this.readJson(issueResponse)) as { fields?: { attachment?: Array<Record<string, any>> } };
    const attachment = (issue.fields?.attachment || []).find((item) => String(item.id) === attachmentId);
    if (!attachment) throw new Error("Jira attachment was not found on this issue.");
    if (options.imageOnly && !/^image\/[a-z0-9.+-]+$/i.test(String(attachment.mimeType || "")))
      throw new Error("Jira attachment is not an image.");
    let contentResponse: Response;
    if (connection.deployment === "cloud") {
      // Cloud's documented attachment-content endpoint supports redirect=false,
      // so credentials never follow a redirect to another host.
      contentResponse = await this.request(
        connection,
        `/attachment/content/${encodeURIComponent(attachmentId)}?redirect=false`,
        this.remainingBudget(deadlineAt),
        maxBytes,
        "Jira attachment exceeds the configured size limit.",
      );
    } else {
      // DC metadata may point at Jira's browser origin even when API traffic is
      // routed through a different APIM origin. Extract only the exact secure
      // attachment path for this ID, then send it to the configured API gateway
      // with the same auth and mTLS as every other Jira API call.
      const gatewayBase = safeUrl(connection.apiBaseUrl, "Jira API URL");
      const apiRoot = this.apiRoot(connection);
      const webOrigin = safeUrl(connection.webUrl, "Jira web URL").origin;
      const marker = `/secure/attachment/${attachmentId}/`;
      const contentValue = String(attachment.content || "");
      const metadataUrl = contentValue ? new URL(contentValue) : undefined;
      if (metadataUrl && metadataUrl.origin !== apiRoot.origin && metadataUrl.origin !== webOrigin)
        throw new Error("Jira Data Center attachment URL is outside the configured host and context path.");
      const markerIndex = metadataUrl?.pathname.lastIndexOf(marker) ?? -1;
      if (metadataUrl && (markerIndex < 0 || metadataUrl.pathname.indexOf("..") >= 0))
        throw new Error("Jira Data Center attachment URL is outside the configured host and context path.");
      const attachmentPath = metadataUrl
        ? metadataUrl.pathname.slice(markerIndex)
        : `${marker}${encodeURIComponent(String(attachment.filename || `attachment-${attachmentId}`))}`;
      const content = new URL(`${gatewayBase.origin}${gatewayBase.pathname.replace(/\/$/, "")}${attachmentPath}`);
      if (connection.auth.kind !== "dc-apim") {
        const contextPath = gatewayBase.pathname.replace(/\/$/, "");
        const expectedPrefix = `${contextPath}${marker}`;
        const directContent = metadataUrl ?? new URL(`${apiRoot.origin}${contextPath}${attachmentPath}`);
        if (directContent.origin !== apiRoot.origin || !directContent.pathname.startsWith(expectedPrefix))
          throw new Error("Jira Data Center attachment URL is outside the configured host and context path.");
        content.href = directContent.href;
      }
      let release: (() => void) | undefined;
      let dispatcher: Agent | undefined;
      let destroyDispatcher = false;
      let stage: JiraRequestStage = "acquire";
      try {
        release = await this.requestScheduler.acquire(connection.id, deadlineAt);
        stage = "auth";
        const headers = await this.untilDeadline(this.authHeaders(connection), deadlineAt);
        stage = "connect";
        dispatcher = await this.createDispatcher(connection);
        stage = "read";
        contentResponse = await this.checkResponse(
          await this.fetchReadResponse(
            content,
            headers,
            deadlineAt,
            maxBytes,
            "Jira attachment exceeds the configured size limit.",
            dispatcher,
          ),
        );
        this.noteSuccess(connection);
      } catch (error) {
        destroyDispatcher = true;
        throw this.failRequest(
          connection,
          error,
          stage,
          content,
          "Jira attachment request failed or exceeded its time limit.",
        );
      } finally {
        if (destroyDispatcher) await dispatcher?.destroy().catch(() => undefined);
        else await dispatcher?.close().catch(() => dispatcher?.destroy());
        release?.();
      }
    }
    const response = contentResponse;
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) throw new Error("Jira attachment exceeds the configured size limit.");
    if (!response.body) throw new Error("Jira attachment response had no content.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Jira attachment exceeds the configured size limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      fileName: String(attachment.filename || `attachment-${attachmentId}`),
      mediaType: String(attachment.mimeType || "application/octet-stream"),
      bytes,
    };
  }

  async uploadAttachment(
    connection: JiraConnection,
    issueId: string,
    fileName: string,
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error("Invalid Jira issue id or key.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(fileName)) throw new Error("Invalid attachment file name.");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 10 * 1024 * 1024)
      throw new Error("Jira attachment must be between 1 byte and 10 MiB.");
    const mime = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i.test(mediaType)
      ? mediaType
      : "application/octet-stream";
    const form = new FormData();
    const blobBytes = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(blobBytes).set(bytes);
    form.append("file", new Blob([blobBytes], { type: mime }), fileName);
    const url = new URL(`issue/${encodeURIComponent(issueId)}/attachments`, this.apiRoot(connection));
    const root = this.apiRoot(connection);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname))
      throw new JiraRequestError(
        "configuration-incomplete",
        "The Jira attachment upload was refused because it points outside the configured Jira API.",
        undefined,
        undefined,
        { notSent: true },
      );
    const deadlineAt = Date.now() + 30_000;
    let release: (() => void) | undefined;
    let dispatcher: Agent | undefined;
    let destroyDispatcher = false;
    let stage: JiraRequestStage = "acquire";
    try {
      release = await this.requestScheduler.acquire(connection.id, deadlineAt);
      stage = "auth";
      const headers = await this.untilDeadline(this.authHeaders(connection), deadlineAt);
      headers.set("X-Atlassian-Token", "no-check");
      stage = "connect";
      dispatcher = await this.createDispatcher(connection);
      stage = "read";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
      try {
        const response = await this.untilDeadline(
          this.fetchImpl(url, {
            method: "POST",
            headers,
            body: form,
            redirect: "error",
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
          } as unknown as RequestInit),
          deadlineAt,
          () => controller.abort(),
        );
        await this.checkResponse(response);
        await response.body?.cancel().catch(() => undefined);
        this.noteSuccess(connection);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      destroyDispatcher = true;
      throw this.failRequest(
        connection,
        error,
        stage,
        url,
        "Jira attachment upload failed or exceeded its time limit.",
      );
    } finally {
      if (destroyDispatcher) await dispatcher?.destroy().catch(() => undefined);
      else await dispatcher?.close().catch(() => dispatcher?.destroy());
      release?.();
    }
    this.invalidateAfterWrite(connection.id);
  }

  async boards(
    connection: JiraConnection,
    projectKeys?: string[],
    options: { maxDurationMs?: number } = {},
  ): Promise<JiraBoard[]> {
    if (options.maxDurationMs !== undefined && (!Number.isFinite(options.maxDurationMs) || options.maxDurationMs <= 0))
      throw new Error("Invalid Jira board catalog read budget.");
    const totalDurationMs = Math.min(20_000, Math.max(1, options.maxDurationMs ?? 20_000));
    const deadlineAt = Date.now() + totalDurationMs;
    const remainingBudget = () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new JiraRequestError("network", "Jira board catalog exceeded its time limit.");
      return remaining;
    };
    const effectiveProjectKeys = normalizeJiraProjectKeys(
      projectKeys === undefined ? connection.projectKeys : projectKeys,
      projectKeys === undefined ? 100 : 50,
    );
    if (effectiveProjectKeys.length > 1) {
      if (effectiveProjectKeys.length > 8)
        throw new Error("Choose up to 8 projects to find boards, or search within one project.");
      const projectBoards = await Promise.all(
        effectiveProjectKeys.map(async (projectKey) => {
          const boards: JiraBoard[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 5; page++) {
            const result = await this.searchBoards(connection, {
              cursor,
              limit: 100,
              projectKeys: [projectKey],
              maxDurationMs: remainingBudget(),
            });
            boards.push(...result.boards);
            if (!result.hasMore || !result.nextCursor) break;
            cursor = result.nextCursor;
          }
          return boards;
        }),
      );
      const unique = new Map<number, JiraBoard>();
      for (const boards of projectBoards) for (const board of boards) unique.set(board.id, board);
      return [...unique.values()].sort((left, right) => left.id - right.id).slice(0, 500);
    }

    const all: JiraBoard[] = [];
    for (let startAt = 0; startAt < 500; startAt += 50) {
      let page: Awaited<ReturnType<JiraManager["searchBoards"]>>;
      try {
        page = await this.searchBoards(connection, {
          cursor: String(startAt),
          limit: 50,
          projectKeys: effectiveProjectKeys,
          maxDurationMs: remainingBudget(),
        });
      } catch (error) {
        if (error instanceof JiraRequestError && error.code === "permission-denied")
          throw new JiraRequestError(
            "permission-denied",
            "Jira denied access to board data.",
            error.retryAfterMs,
            error.statusCode,
          );
        throw error;
      }
      all.push(...page.boards);
      if (!page.hasMore) break;
    }
    return all;
  }

  async boardMetadata(connection: JiraConnection, boardId: number): Promise<JiraBoard> {
    if (!Number.isSafeInteger(boardId) || boardId < 1) throw new Error("Invalid Jira board id.");
    const result = await this.cachedRead(
      connection,
      `board-metadata:v1:${boardId}`,
      {},
      async () => {
        const response = await this.fetchAuthenticated(
          connection,
          new URL(`board/${boardId}`, this.agileRoot(connection)),
          4_000,
        );
        const value = (await this.readJson(response)) as Record<string, any>;
        const id = Number(value.id);
        const name = String(value.name || "").slice(0, 500);
        if (id !== boardId || !name) throw new JiraRequestError("unknown", "Jira returned invalid board metadata.");
        return {
          board: {
            id,
            name,
            type: value.type === "scrum" ? ("scrum" as const) : ("kanban" as const),
            ...(value.location && typeof value.location === "object"
              ? {
                  location: {
                    ...((value.location as Record<string, unknown>).projectKey !== undefined
                      ? { projectKey: String((value.location as Record<string, unknown>).projectKey) }
                      : {}),
                    ...((value.location as Record<string, unknown>).projectName !== undefined
                      ? { projectName: String((value.location as Record<string, unknown>).projectName) }
                      : {}),
                  },
                }
              : {}),
          },
        };
      },
      5 * 60_000,
    );
    if (!result) throw new JiraRequestError("network", "Jira board metadata did not return a result.");
    return result.board;
  }

  async searchBoards(
    connection: JiraConnection,
    input: { query?: string; cursor?: string; limit?: number; projectKeys?: string[]; maxDurationMs?: number } = {},
  ): Promise<{ boards: JiraBoard[]; hasMore: boolean; nextCursor?: string; truncated: boolean }> {
    const query = String(input.query || "").trim();
    const limit = input.limit ?? 50;
    const startAt = input.cursor === undefined ? 0 : Number(input.cursor);
    if (query.length > 255) throw new Error("Jira board search is too long.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid Jira board page size.");
    if (!Number.isSafeInteger(startAt) || startAt < 0 || startAt > 99_999_999)
      throw new Error("Invalid Jira board cursor.");
    if (input.maxDurationMs !== undefined && (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0))
      throw new Error("Invalid Jira board read budget.");
    const deadlineAt = Date.now() + Math.min(25_000, Math.max(1, input.maxDurationMs ?? 25_000));

    const projectKeys = normalizeJiraProjectKeys(
      input.projectKeys === undefined ? connection.projectKeys : input.projectKeys,
      input.projectKeys === undefined ? 100 : 50,
    );
    if (projectKeys.length > 8)
      throw new Error("Choose up to 8 projects to find boards, or search within one project.");
    if (projectKeys.length > 1 && startAt > 0)
      throw new Error("Narrow board discovery to one project before loading another page.");
    const cacheKey = `board-search:v1:${JSON.stringify([query, startAt, limit, projectKeys])}`;
    const result = await this.cachedRead(
      connection,
      cacheKey,
      {},
      async () => {
        const fetchPage = async (pageStartAt: number, pageLimit: number, projectKey?: string) => {
          const url = new URL("board", this.agileRoot(connection));
          url.searchParams.set("startAt", String(pageStartAt));
          url.searchParams.set("maxResults", String(pageLimit));
          if (query) url.searchParams.set("name", query);
          if (projectKey) url.searchParams.set("projectKeyOrId", projectKey);
          const response = await this.fetchAuthenticated(connection, url, Math.max(1, deadlineAt - Date.now()));
          const body = (await this.readJson(response)) as {
            values?: Array<Record<string, any>>;
            isLast?: boolean;
            total?: number;
          };
          const values = Array.isArray(body.values) ? body.values.slice(0, pageLimit) : [];
          const boards = values.flatMap((item) => {
            const id = Number(item.id);
            if (!Number.isSafeInteger(id) || id < 1) return [];
            return [
              {
                id,
                name: String(item.name || "Board"),
                type: item.type === "scrum" ? ("scrum" as const) : ("kanban" as const),
                ...(item.location
                  ? { location: { projectKey: item.location.projectKey, projectName: item.location.projectName } }
                  : {}),
              },
            ];
          });
          const total = Number(body.total);
          const hasMore =
            values.length > 0 &&
            body.isLast !== true &&
            (Number.isFinite(total) && total >= 0 ? pageStartAt + values.length < total : values.length >= pageLimit);
          return { boards, hasMore };
        };

        if (projectKeys.length > 1) {
          const pages = await Promise.all(projectKeys.map((projectKey) => fetchPage(0, limit, projectKey)));
          const uniqueBoards = new Map<number, JiraBoard>();
          for (const page of pages) for (const board of page.boards) uniqueBoards.set(board.id, board);
          const allBoards = [...uniqueBoards.values()].sort((a, b) => a.id - b.id);
          const boards = allBoards.slice(0, limit);
          const truncated = allBoards.length > limit || pages.some((page) => page.hasMore);
          return { boards, hasMore: false, truncated };
        }

        const page = await fetchPage(startAt, limit, projectKeys[0]);
        const nextCursor = page.hasMore ? String(startAt + page.boards.length) : undefined;
        return { ...page, ...(nextCursor ? { nextCursor } : {}), truncated: page.hasMore };
      },
      5 * 60_000,
    );
    if (!result) throw new JiraRequestError("network", "Jira board search did not return a page.");
    const { cache: _cache, ...page } = result;
    return page;
  }

  async boardQuickFilters(
    connection: JiraConnection,
    boardId: number,
    input: {
      cursor?: string;
      limit?: number;
      cacheOnly?: boolean;
      forceRefresh?: boolean;
      maxDurationMs?: number;
    } = {},
  ): Promise<{
    filters: JiraBoardQuickFilter[];
    hasMore: boolean;
    nextCursor?: string;
    truncated: boolean;
    capability: "available" | "unknown" | "unsupported" | "permission-denied";
    cache?: JiraCacheMetadata;
  } | null> {
    const { cacheOnly, forceRefresh, ...request } = input;
    const key = `board-quick-filters:${JSON.stringify({ boardId, cursor: request.cursor || "", limit: request.limit || 50, schema: 1 })}`;
    return this.cachedRead(
      connection,
      key,
      { cacheOnly, forceRefresh },
      () => this.fetchBoardQuickFilters(connection, boardId, request),
      5 * 60_000,
    );
  }

  private async fetchBoardQuickFilters(
    connection: JiraConnection,
    boardId: number,
    input: { cursor?: string; limit?: number; maxDurationMs?: number } = {},
  ): Promise<{
    filters: JiraBoardQuickFilter[];
    hasMore: boolean;
    nextCursor?: string;
    truncated: boolean;
    capability: "available" | "unknown" | "unsupported" | "permission-denied";
  }> {
    if (!Number.isSafeInteger(boardId) || boardId < 1) throw new Error("Invalid Jira board id.");
    const startAt = input.cursor === undefined ? 0 : Number(input.cursor);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(startAt) || startAt < 0 || startAt > 10_000)
      throw new Error("Invalid quick-filter cursor.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid quick-filter page size.");
    const url = new URL(`board/${boardId}/quickfilter`, this.agileRoot(connection));
    url.searchParams.set("startAt", String(startAt));
    url.searchParams.set("maxResults", String(limit));
    try {
      const response = await this.fetchAuthenticated(connection, url, input.maxDurationMs);
      const body = (await this.readJson(response)) as {
        values?: Array<Record<string, any>>;
        total?: number;
        isLast?: boolean;
      };
      const rows = Array.isArray(body.values) ? body.values.slice(0, limit) : [];
      const filters = rows.flatMap((row, rowIndex) => {
        const id = Number(row.id);
        if (!Number.isSafeInteger(id) || id < 1 || typeof row.jql !== "string" || row.jql.length > 2000) return [];
        return [
          {
            id,
            name: String(row.name || id).slice(0, 256),
            ...(typeof row.description === "string" && row.description
              ? { description: row.description.slice(0, 1000) }
              : {}),
            jql: row.jql,
            position: Number.isFinite(Number(row.position)) ? Number(row.position) : startAt + rowIndex,
          },
        ];
      });
      const hasMore =
        body.isLast !== true &&
        (Number.isFinite(Number(body.total)) ? startAt + rows.length < Number(body.total) : rows.length >= limit);
      return {
        filters,
        hasMore,
        ...(hasMore ? { nextCursor: String(startAt + rows.length) } : {}),
        truncated: hasMore,
        capability: "available",
      };
    } catch (error) {
      if (error instanceof JiraRequestError && ["permission-denied", "not-found", "unsupported"].includes(error.code))
        return {
          filters: [],
          hasMore: false,
          truncated: false,
          capability: error.code === "permission-denied" ? "permission-denied" : "unsupported",
        };
      throw error;
    }
  }

  async boardView(
    connection: JiraConnection,
    boardId: number,
    mode?: "issues" | "backlog" | "sprints",
    cursor?: string,
    sprintId?: number,
    options?: JiraReadOptions & {
      quickFilterIds?: number[];
      assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
      doneWithinDays?: number;
      projectKeys?: string[];
    },
  ): Promise<NonNullable<Awaited<ReturnType<JiraManager["fetchBoardView"]>>> & { cache: JiraCacheMetadata }>;
  async boardView(
    connection: JiraConnection,
    boardId: number,
    mode: "issues" | "backlog" | "sprints" | undefined,
    cursor: string | undefined,
    sprintId: number | undefined,
    options: JiraReadOptions & {
      quickFilterIds?: number[];
      assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
      doneWithinDays?: number;
      projectKeys?: string[];
    },
  ): Promise<(NonNullable<Awaited<ReturnType<JiraManager["fetchBoardView"]>>> & { cache: JiraCacheMetadata }) | null>;
  async boardView(
    connection: JiraConnection,
    boardId: number,
    mode: "issues" | "backlog" | "sprints" = "issues",
    cursor?: string,
    sprintId?: number,
    options: JiraReadOptions & {
      quickFilterIds?: number[];
      assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
      doneWithinDays?: number;
      projectKeys?: string[];
    } = {},
  ): Promise<{
    boardId: number;
    mode: string;
    issues: JiraIssue[];
    filter?: { id: number | string; name: string; jql?: string };
    owner?: { displayName: string; accountId?: string };
    columns?: Array<{ name: string; statuses: Array<{ id: string; name: string }> }>;
    sprints?: Array<{ id: string; name: string; state: string; startDate?: string; endDate?: string }>;
    capability?: string;
    hasMore: boolean;
    nextCursor?: string;
    truncated: boolean;
    sprintsHasMore?: boolean;
    sprintsNextCursor?: string;
    selectedSprintId?: number;
    cache?: JiraCacheMetadata;
    capabilities: {
      configuration: "available" | "unknown" | "unsupported" | "permission-denied";
      quickFilters: "available" | "unknown" | "unsupported" | "permission-denied";
      issues: "available" | "unknown" | "unsupported" | "permission-denied";
      backlog: "available" | "unknown" | "unsupported" | "permission-denied";
      sprints: "available" | "unknown" | "unsupported" | "permission-denied";
    };
  } | null> {
    const { cacheOnly, forceRefresh, refreshInBackground, projectKeys: requestedProjectKeys, ...filters } = options;
    const projectKeys = normalizeJiraProjectKeys(
      requestedProjectKeys === undefined ? connection.projectKeys : requestedProjectKeys,
      requestedProjectKeys === undefined ? 100 : 50,
    );
    // One budget for resolving the quick filters AND fetching the board: a remote caller is cancelled at 30 s.
    const deadlineAt = Date.now() + 25_000;
    const selectedFilters = await this.resolveQuickFilterJql(
      connection,
      boardId,
      filters.quickFilterIds || [],
      Boolean(cacheOnly),
      deadlineAt,
    );
    if (!selectedFilters) return null;
    const validatedJql = [...selectedFilters.jql];
    if (filters.assignee?.kind === "unassigned") validatedJql.push("assignee IS EMPTY");
    else if (filters.assignee?.kind === "user") {
      const assigneeId = filters.assignee.id.trim();
      if (!assigneeId || assigneeId.length > 255 || /[\r\n\0]/.test(assigneeId))
        throw new Error("Invalid Jira assignee id.");
      validatedJql.push(`assignee = ${jqlStringLiteral(assigneeId)}`);
    }
    const doneWithinJql = jiraDoneWithinJql(mode, filters.doneWithinDays);
    if (doneWithinJql) validatedJql.push(doneWithinJql);
    if (validatedJql.join(" AND ").length > 2000)
      throw new Error("The selected Jira quick filters and assignee make the JQL too long.");
    const key = `board:${JSON.stringify({ boardId, mode, cursor: cursor || "", sprintId: sprintId || 0, quickFilterIds: [...(filters.quickFilterIds || [])].sort((a, b) => a - b), quickFilterJql: selectedFilters.jql, assignee: filters.assignee || null, doneWithinDays: doneWithinJql ? filters.doneWithinDays : null, projectKeys, fields: "summary,status,issuetype,project,updated,assignee,priority,created,reporter,labels,components,fixVersions", schema: 3 })}`;
    return this.cachedRead(
      connection,
      key,
      { cacheOnly, forceRefresh, refreshInBackground },
      () =>
        this.fetchBoardView(connection, boardId, mode, cursor, sprintId, {
          ...filters,
          quickFilterJql: selectedFilters.jql,
          projectKeys,
          quickFiltersCapability: selectedFilters.capability,
          deadlineAt,
        }),
      30_000,
    );
  }

  private async resolveQuickFilterJql(
    connection: JiraConnection,
    boardId: number,
    selectedIds: number[],
    cacheOnly = false,
    sharedDeadlineAt = Number.POSITIVE_INFINITY,
  ): Promise<{ jql: string[]; capability: "available" | "unknown" | "unsupported" | "permission-denied" } | undefined> {
    if (!selectedIds.length) return { jql: [], capability: "unknown" };
    const ids = [...new Set(selectedIds)];
    if (ids.length > 50 || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
      throw new Error("Invalid Jira quick-filter selection.");
    const byId = new Map<number, JiraBoardQuickFilter>();
    const deadlineAt = Math.min(sharedDeadlineAt, Date.now() + 10_000);
    let capability: "available" | "unknown" | "unsupported" | "permission-denied" = "unknown";
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.boardQuickFilters(connection, boardId, {
        limit: 100,
        cursor,
        maxDurationMs: Math.max(1, deadlineAt - Date.now()),
        ...(cacheOnly ? { cacheOnly: true } : {}),
      });
      if (!result) {
        if (cacheOnly) return undefined;
        throw new JiraRequestError("unknown", "Jira quick filters were not available in the local cache.");
      }
      capability = result.capability;
      for (const filter of result.filters) byId.set(filter.id, filter);
      if (result.capability !== "available" || !result.hasMore || !result.nextCursor) break;
      cursor = result.nextCursor;
      if (ids.every((id) => byId.has(id))) break;
    }
    const jql = ids.map((id) => {
      const filter = byId.get(id);
      if (!filter) throw new JiraRequestError("not-found", "A selected Jira quick filter is unavailable.");
      return `(${filter.jql})`;
    });
    return { jql, capability };
  }

  private async fetchBoardView(
    connection: JiraConnection,
    boardId: number,
    mode: "issues" | "backlog" | "sprints" = "issues",
    cursor?: string,
    sprintId?: number,
    options: {
      quickFilterIds?: number[];
      assignee?: { kind: "user"; id: string } | { kind: "unassigned" };
      doneWithinDays?: number;
      quickFilterJql?: string[];
      projectKeys?: string[];
      quickFiltersCapability?: "available" | "unknown" | "unsupported" | "permission-denied";
      /** The caller's overall deadline; the request never outlives it. */
      deadlineAt?: number;
    } = {},
  ): Promise<{
    boardId: number;
    mode: string;
    issues: JiraIssue[];
    filter?: { id: number | string; name: string; jql?: string };
    owner?: { displayName: string; accountId?: string };
    columns?: Array<{ name: string; statuses: Array<{ id: string; name: string }> }>;
    sprints?: Array<{ id: string; name: string; state: string; startDate?: string; endDate?: string }>;
    capability?: string;
    hasMore: boolean;
    nextCursor?: string;
    truncated: boolean;
    sprintsHasMore?: boolean;
    sprintsNextCursor?: string;
    selectedSprintId?: number;
    capabilities: {
      configuration: "available" | "unknown" | "unsupported" | "permission-denied";
      quickFilters: "available" | "unknown" | "unsupported" | "permission-denied";
      issues: "available" | "unknown" | "unsupported" | "permission-denied";
      backlog: "available" | "unknown" | "unsupported" | "permission-denied";
      sprints: "available" | "unknown" | "unsupported" | "permission-denied";
    };
  }> {
    const deadlineAt = Math.min(options.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + 25_000);
    if (!Number.isSafeInteger(boardId) || boardId < 1) throw new Error("Invalid Jira board id.");
    const startAt = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(startAt) || startAt < 0 || startAt > 10_000)
      throw new Error("Invalid Jira board cursor.");
    const base = this.agileRoot(connection);
    if (mode !== "sprints" && sprintId !== undefined) throw new Error("A sprint can only be selected in sprint mode.");
    if (sprintId !== undefined && (!Number.isSafeInteger(sprintId) || sprintId < 1))
      throw new Error("Invalid Jira sprint id.");
    const requestPage = async (path: string, pageStartAt = startAt, params?: Record<string, string>) => {
      const url = new URL(path, base);
      url.searchParams.set("maxResults", "100");
      url.searchParams.set("startAt", String(pageStartAt));
      for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
      return this.fetchAuthenticated(connection, url, this.remainingBudget(deadlineAt));
    };
    const filterJql: string[] = [...(options.quickFilterJql || [])];
    const quickFiltersCapability = options.quickFiltersCapability || "unknown";
    if (options.assignee?.kind === "unassigned") filterJql.push("assignee IS EMPTY");
    else if (options.assignee?.kind === "user") {
      const assigneeId = options.assignee.id.trim();
      if (!assigneeId || assigneeId.length > 255 || /[\r\n\0]/.test(assigneeId))
        throw new Error("Invalid Jira assignee id.");
      filterJql.push(`assignee = ${jqlStringLiteral(assigneeId)}`);
    }
    const doneWithinJql = jiraDoneWithinJql(mode, options.doneWithinDays);
    if (doneWithinJql) filterJql.push(doneWithinJql);
    const extraJql = applyJiraProjectScope(
      filterJql.join(" AND "),
      options.projectKeys === undefined ? connection.projectKeys : options.projectKeys,
    );
    const capabilityFromError = (error: unknown): "unsupported" | "permission-denied" | undefined => {
      if (!(error instanceof JiraRequestError)) return undefined;
      if (error.code === "not-found" || error.code === "unsupported") return "unsupported";
      if (error.code === "permission-denied") return "permission-denied";
      return undefined;
    };
    let config: Record<string, any> = {};
    let configurationCapability: "available" | "unknown" | "unsupported" | "permission-denied" = "available";
    try {
      const boardRes = await this.fetchAuthenticated(
        connection,
        new URL(`board/${boardId}/configuration`, base),
        this.remainingBudget(deadlineAt),
      );
      config = (await this.readJson(boardRes)) as Record<string, any>;
    } catch (error) {
      const capability = capabilityFromError(error);
      if (!capability) throw error;
      configurationCapability = capability;
    }
    const columnStatuses: Array<Record<string, any>> = Array.isArray(config.columnConfig?.columns)
      ? config.columnConfig.columns.flatMap((col: any) => col.statuses || [])
      : [];
    const statusNamesPending = columnStatuses.some((status) => !status?.name)
      ? this.statusNames(connection, deadlineAt)
      : Promise.resolve(new Map<string, string>());
    let issueBody: { issues?: Array<Record<string, any>>; total?: number; isLast?: boolean } = {
      issues: [],
      total: 0,
      isLast: true,
    };
    let issueCapability: "available" | "unknown" | "unsupported" | "permission-denied" =
      mode === "issues" ? "available" : "unknown";
    if (mode !== "sprints") {
      try {
        const issueRes = await requestPage(`board/${boardId}/${mode === "backlog" ? "backlog" : "issue"}`, startAt, {
          fields:
            "summary,status,issuetype,project,updated,assignee,priority,created,reporter,labels,components,fixVersions",
          ...(extraJql ? { jql: extraJql } : {}),
        });
        issueBody = (await this.readJson(issueRes)) as {
          issues?: Array<Record<string, any>>;
          total?: number;
          isLast?: boolean;
        };
        issueCapability = "available";
      } catch (error) {
        const capability = capabilityFromError(error);
        if (!capability) throw error;
        issueCapability = capability;
      }
    } else if (sprintId !== undefined) {
      try {
        // Use the board-scoped endpoint so Jira applies the board's own issue membership/filter.
        const issueRes = await requestPage(`board/${boardId}/sprint/${sprintId}/issue`, startAt, {
          fields:
            "summary,status,issuetype,project,updated,assignee,priority,created,reporter,labels,components,fixVersions",
          ...(extraJql ? { jql: extraJql } : {}),
        });
        issueBody = (await this.readJson(issueRes)) as {
          issues?: Array<Record<string, any>>;
          total?: number;
          isLast?: boolean;
        };
        issueCapability = "available";
      } catch (error) {
        const capability = capabilityFromError(error);
        if (!capability) throw error;
        issueCapability = capability;
      }
    }
    const pageIssues = issueBody.issues || [];
    const statusNames = await statusNamesPending;
    const hasMore =
      issueBody.isLast === true
        ? false
        : typeof issueBody.total === "number"
          ? startAt + pageIssues.length < issueBody.total
          : pageIssues.length >= 100;
    const result: {
      boardId: number;
      mode: string;
      issues: JiraIssue[];
      filter?: { id: number | string; name: string; jql?: string };
      owner?: { displayName: string; accountId?: string };
      columns?: Array<{ name: string; statuses: Array<{ id: string; name: string }> }>;
      sprints?: Array<{ id: string; name: string; state: string; startDate?: string; endDate?: string }>;
      capability?: string;
      hasMore: boolean;
      nextCursor?: string;
      truncated: boolean;
      sprintsHasMore?: boolean;
      sprintsNextCursor?: string;
      selectedSprintId?: number;
      capabilities: {
        configuration: "available" | "unknown" | "unsupported" | "permission-denied";
        quickFilters: "available" | "unknown" | "unsupported" | "permission-denied";
        issues: "available" | "unknown" | "unsupported" | "permission-denied";
        backlog: "available" | "unknown" | "unsupported" | "permission-denied";
        sprints: "available" | "unknown" | "unsupported" | "permission-denied";
      };
    } = {
      boardId,
      mode,
      issues: pageIssues.slice(0, 100).map((issue) => this.normalizeIssue(connection, issue)),
      hasMore: mode === "sprints" && sprintId === undefined ? false : hasMore,
      ...(hasMore ? { nextCursor: String(startAt + pageIssues.length) } : {}),
      truncated: hasMore,
      capabilities: {
        configuration: configurationCapability,
        quickFilters: quickFiltersCapability,
        issues: mode === "issues" || (mode === "sprints" && sprintId !== undefined) ? issueCapability : "unknown",
        backlog: mode === "backlog" ? issueCapability : "unknown",
        sprints: mode === "sprints" ? "available" : "unknown",
      },
      ...(Array.isArray(config.columnConfig?.columns)
        ? {
            columns: config.columnConfig.columns.map((col: any) => ({
              name: String(col.name || ""),
              statuses: (col.statuses || []).map((status: any) => ({
                id: String(status.id),
                name: String(status.name || statusNames.get(String(status.id)) || ""),
              })),
            })),
          }
        : {}),
      ...(config.filter && config.filter.id != null
        ? {
            filter: {
              id: typeof config.filter.id === "number" ? config.filter.id : String(config.filter.id),
              name: String(config.filter.name || "Jira filter").slice(0, 256),
              ...(typeof config.filter.jql === "string" ? { jql: config.filter.jql.slice(0, 2000) } : {}),
            },
          }
        : {}),
      ...(config.owner && typeof config.owner.displayName === "string"
        ? {
            owner: {
              displayName: config.owner.displayName.slice(0, 256),
              ...(typeof config.owner.accountId === "string"
                ? { accountId: config.owner.accountId.slice(0, 255) }
                : {}),
            },
          }
        : {}),
    };
    if (mode === "sprints") {
      try {
        const toSprint = (item: any) => ({
          id: String(item.id || ""),
          name: String(item.name || ""),
          state: String(item.state || "unknown"),
          ...(typeof item.startDate === "string" ? { startDate: item.startDate } : {}),
          ...(typeof item.endDate === "string" ? { endDate: item.endDate } : {}),
        });
        const isOpenSprint = (sprint: { state: string }) => sprint.state === "active" || sprint.state === "future";
        const sprintStartAt = sprintId === undefined ? startAt : 0;
        const sprintRes = await requestPage(`board/${boardId}/sprint`, sprintStartAt);
        const sprintBody = (await this.readJson(sprintRes)) as { values?: unknown[]; total?: number; isLast?: boolean };
        const page = (sprintBody.values || []).slice(0, 100).map(toSprint);
        result.sprintsHasMore =
          sprintBody.isLast === true
            ? false
            : typeof sprintBody.total === "number"
              ? sprintStartAt + page.length < sprintBody.total
              : page.length >= 100;
        let consumed = page.length;
        if (sprintStartAt === 0) {
          // Jira lists a board's sprints oldest first, and a board can run several sprints in parallel: every open
          // sprint goes on the first page, ahead of the history, so none is left behind a "load more".
          const openRes = await requestPage(`board/${boardId}/sprint`, 0, { state: "active,future" });
          const openBody = (await this.readJson(openRes)) as { values?: unknown[] };
          const open = (openBody.values || []).slice(0, 100).map(toSprint).filter(isOpenSprint);
          open.sort((a, b) => Number(b.state === "active") - Number(a.state === "active"));
          const openIds = new Set(open.map((sprint) => sprint.id));
          const rest = page.filter((sprint) => !openIds.has(sprint.id));
          const room = Math.max(0, 100 - open.length);
          if (rest.length > room) {
            consumed = page.indexOf(rest[room]!);
            result.sprintsHasMore = true;
          }
          result.sprints = [...open, ...rest.slice(0, room)];
        } else {
          result.sprints = page.filter((sprint) => !isOpenSprint(sprint));
        }
        if (result.sprintsHasMore) result.sprintsNextCursor = String(sprintStartAt + consumed);
        // Jira lists a board's sprints oldest first, so on a board with a long history the selected sprint is often
        // not on the first page; without it the UI cannot name it.
        if (sprintId !== undefined && !result.sprints.some((sprint) => sprint.id === String(sprintId))) {
          try {
            const selectedRes = await this.fetchAuthenticated(
              connection,
              new URL(`sprint/${sprintId}`, base),
              this.remainingBudget(deadlineAt),
            );
            const selected = (await this.readJson(selectedRes)) as Record<string, unknown>;
            if (String(selected.id ?? "") === String(sprintId))
              result.sprints.unshift({
                id: String(selected.id),
                name: String(selected.name || ""),
                state: String(selected.state || "unknown"),
                ...(typeof selected.startDate === "string" ? { startDate: selected.startDate } : {}),
                ...(typeof selected.endDate === "string" ? { endDate: selected.endDate } : {}),
              });
          } catch (error) {
            // The name is a convenience; the board itself has loaded, so a failed lookup only leaves it unnamed.
            if (!(error instanceof JiraRequestError)) throw error;
          }
        }
        if (sprintId !== undefined) result.selectedSprintId = sprintId;
        else {
          result.hasMore = result.sprintsHasMore;
          result.truncated = result.sprintsHasMore;
          if (result.sprintsNextCursor) result.nextCursor = result.sprintsNextCursor;
        }
      } catch (error) {
        if (
          error instanceof JiraRequestError &&
          error.code !== "not-found" &&
          error.code !== "permission-denied" &&
          error.code !== "unsupported"
        )
          throw error;
        result.capability = error instanceof JiraRequestError ? error.code : "sprints-unavailable";
        result.capabilities = {
          ...result.capabilities,
          sprints:
            error instanceof JiraRequestError && error.code === "permission-denied"
              ? "permission-denied"
              : "unsupported",
        };
      }
    }
    return result;
  }

  async transitions(connection: JiraConnection, issueId: string): Promise<JiraTransition[]> {
    const response = await this.request(
      connection,
      `/issue/${encodeURIComponent(issueId)}/transitions?expand=transitions.fields`,
    );
    const body = (await this.readJson(response)) as { transitions?: Array<Record<string, any>> };
    return (body.transitions || []).map((item) => ({
      id: String(item.id),
      name: String(item.name || ""),
      to: String(item.to?.name || ""),
      requiredFields: Object.entries((item.fields || {}) as Record<string, any>).map(([id, field]) => {
        const rawType = String(field.schema?.type || "string");
        const type = ["string", "number", "date", "datetime", "option"].includes(rawType) ? rawType : "unsupported";
        const allowedValues = Array.isArray(field.allowedValues)
          ? field.allowedValues
              .slice(0, 100)
              .map((option: any) => ({
                value: String(option.id ?? option.value ?? option.name ?? ""),
                label: String(option.value ?? option.name ?? option.id ?? ""),
              }))
              .filter((option: { value: string; label: string }) => option.value && option.label)
          : undefined;
        const isSupported =
          type !== "unsupported" &&
          (!String(field.schema?.custom || "").includes("select") || Boolean(allowedValues?.length));
        return {
          id,
          name: String(field.name || id),
          type,
          required: field.required === true,
          supported: isSupported,
          ...(allowedValues ? { allowedValues } : {}),
        };
      }),
    }));
  }

  async transition(
    connection: JiraConnection,
    issueId: string,
    transitionId: string,
    fields: Record<string, unknown> = {},
  ): Promise<void> {
    if (!/^\d+$/.test(transitionId)) throw new Error("Invalid Jira transition id.");
    await this.sendWrite(connection, `/issue/${encodeURIComponent(issueId)}/transitions`, {
      transition: { id: transitionId },
      ...(Object.keys(fields).length ? { fields } : {}),
    });
    this.invalidateAfterWrite(connection.id);
  }

  async addComment(connection: JiraConnection, issueId: string, body: string): Promise<void> {
    const content =
      connection.deployment === "cloud"
        ? {
            body: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
            },
          }
        : { body };
    await this.sendWrite(connection, `/issue/${encodeURIComponent(issueId)}/comment`, content);
    this.invalidateAfterWrite(connection.id);
  }

  async canWorklog(connection: JiraConnection, issueId: string): Promise<boolean> {
    const response = await this.request(
      connection,
      `/mypermissions?permissions=WORK_ON_ISSUES&issueKey=${encodeURIComponent(issueId)}`,
    );
    const body = (await this.readJson(response)) as { permissions?: { WORK_ON_ISSUES?: { havePermission?: boolean } } };
    return body.permissions?.WORK_ON_ISSUES?.havePermission === true;
  }

  async addWorklog(
    connection: JiraConnection,
    issueId: string,
    data: { timeSpentSeconds: number; started: string; comment?: string },
  ): Promise<void> {
    if (!Number.isInteger(data.timeSpentSeconds) || data.timeSpentSeconds <= 0)
      throw new Error("Worklog duration must be positive whole seconds.");
    await this.sendWrite(connection, `/issue/${encodeURIComponent(issueId)}/worklog`, data);
    this.invalidateAfterWrite(connection.id);
  }

  /** The assignee as Jira stores it today: Cloud account id or Data Center user name; "" when unassigned. */
  async currentAssignee(connection: JiraConnection, issueId: string): Promise<{ id: string; displayName: string }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error("Invalid Jira issue id.");
    const response = await this.request(connection, `/issue/${encodeURIComponent(issueId)}?fields=assignee`);
    const body = (await this.readJson(response)) as { fields?: { assignee?: Record<string, unknown> | null } };
    const assignee = body.fields?.assignee;
    if (!assignee) return { id: "", displayName: "" };
    const id = connection.deployment === "cloud" ? assignee.accountId : (assignee.name ?? assignee.key);
    return { id: String(id || ""), displayName: String(assignee.displayName || id || "") };
  }

  async assign(
    connection: JiraConnection,
    issueId: string,
    target: { kind: "user"; id: string } | { kind: "unassigned" },
  ): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error("Invalid Jira issue id.");
    if (target.kind === "user" && (!target.id.trim() || target.id.length > 255))
      throw new Error("Jira user identifier is invalid.");
    const value = target.kind === "user" ? target.id.trim() : null;
    await this.sendWrite(
      connection,
      `/issue/${encodeURIComponent(issueId)}/assignee`,
      connection.deployment === "cloud" ? { accountId: value } : { name: value },
      "PUT",
    );
    this.invalidateAfterWrite(connection.id);
  }

  /** Fresh, uncached attachment list; used only to reconcile an upload whose result is unknown. */
  async issueAttachments(connection: JiraConnection, issueId: string): Promise<JiraAttachment[]> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error("Invalid Jira issue id.");
    const response = await this.request(connection, `/issue/${encodeURIComponent(issueId)}?fields=attachment`);
    const body = (await this.readJson(response)) as { fields?: { attachment?: unknown } };
    return normalizeAttachments(body.fields?.attachment);
  }

  async addRemoteLink(
    connection: JiraConnection,
    issueId: string,
    input: { url: string; title: string; globalId: string },
  ): Promise<void> {
    const remote = new URL(input.url);
    if (
      remote.protocol !== "https:" ||
      remote.username ||
      remote.password ||
      remote.hash ||
      !input.title.trim() ||
      input.title.length > 500 ||
      !input.globalId.trim() ||
      input.globalId.length > 1000
    )
      throw new Error("Jira remote link is invalid.");
    await this.sendWrite(connection, `/issue/${encodeURIComponent(issueId)}/remotelink`, {
      globalId: input.globalId,
      object: { url: remote.toString(), title: input.title.trim() },
    });
    this.invalidateAfterWrite(connection.id);
  }

  private async commentPages(
    connection: JiraConnection,
    issueId: string,
  ): Promise<{ rows: Array<Record<string, any>>; complete: boolean }> {
    const deadlineAt = Date.now() + 25_000;
    const rows: Array<Record<string, any>> = [];
    let startAt = 0;
    for (let requestIndex = 0; requestIndex < 5; requestIndex++) {
      const response = await this.request(
        connection,
        `/issue/${encodeURIComponent(issueId)}/comment?startAt=${startAt}&maxResults=100`,
        this.remainingBudget(deadlineAt),
      );
      const body = (await this.readJson(response)) as {
        comments?: Array<Record<string, any>>;
        total?: number;
        startAt?: number;
      };
      if (!Array.isArray(body.comments)) return { rows, complete: false };
      const page = body.comments.slice(0, 100);
      rows.push(...page);
      startAt = (Number(body.startAt) || startAt) + page.length;
      if (Number.isFinite(body.total) && startAt >= Number(body.total)) return { rows, complete: true };
      if (page.length < 100) return { rows, complete: true };
      if (!page.length) return { rows, complete: true };
    }
    return { rows, complete: false };
  }

  /** A write changes issue data, not who the user is: it keeps the recent-history lists the user built. */
  private invalidateAfterWrite(connectionId: string): void {
    this.healthByConnection.delete(connectionId);
    this.cacheEpochs.set(connectionId, (this.cacheEpochs.get(connectionId) || 0) + 1);
    for (const scope of this.cacheScopes.get(connectionId) || []) this.safeInvalidateCache(scope, "history:");
    for (const key of this.cacheInflight.keys()) if (key.startsWith(`${connectionId}:`)) this.cacheInflight.delete(key);
  }

  /** Called with the connection id after every full invalidation of one connection (not after a write). */
  onConnectionInvalidated?: (connectionId: string) => void;

  /** Identity of the connection's credentials and configuration, for caches that live outside SQLite. */
  cacheBinding(connection: JiraConnection): string {
    return this.persistentCacheScope(connection);
  }

  invalidate(connectionId?: string): void {
    if (connectionId) this.healthByConnection.delete(connectionId);
    else this.healthByConnection.clear();
    if (!connectionId) {
      this.globalCacheEpoch += 1;
      for (const scopes of this.cacheScopes.values()) for (const scope of scopes) this.safeInvalidateCache(scope);
      this.cacheScopes.clear();
      this.scopeMemo.clear();
      this.cacheInflight.clear();
    } else {
      this.cacheEpochs.set(connectionId, (this.cacheEpochs.get(connectionId) || 0) + 1);
      for (const scope of this.cacheScopes.get(connectionId) || []) this.safeInvalidateCache(scope);
      this.cacheScopes.delete(connectionId);
      this.scopeMemo.delete(connectionId);
      for (const key of this.cacheInflight.keys())
        if (key.startsWith(`${connectionId}:`)) this.cacheInflight.delete(key);
      try {
        this.onConnectionInvalidated?.(connectionId);
      } catch {}
    }
  }

  retainConfiguredScopes(connections: readonly JiraConnection[]): void {
    if (!this.persistentCache) return;
    const previousIds = [...this.cacheScopes.keys()];
    const scopes: string[] = [];
    this.cacheScopes.clear();
    this.scopeMemo.clear();
    for (const id of previousIds) {
      this.cacheEpochs.set(id, (this.cacheEpochs.get(id) || 0) + 1);
      for (const key of this.cacheInflight.keys()) if (key.startsWith(`${id}:`)) this.cacheInflight.delete(key);
    }
    for (const connection of connections) {
      const scope = this.persistentCacheScope(connection);
      scopes.push(scope);
      const set = this.cacheScopes.get(connection.id) || new Set<string>();
      set.add(scope);
      this.cacheScopes.set(connection.id, set);
    }
    try {
      this.persistentCache.retainScopes(scopes);
    } catch {}
  }

  private async cachedRead<T extends object>(
    connection: JiraConnection,
    key: string,
    options: JiraReadOptions,
    load: () => Promise<T>,
    ttlMs = 5 * 60_000,
  ): Promise<(T & { cache: JiraCacheMetadata }) | null> {
    if (!this.persistentCache) {
      if (options.cacheOnly) return null;
      const value = await load();
      return { ...value, cache: { source: "network", fetchedAt: Date.now(), stale: false } };
    }
    const scope = this.persistentCacheScope(connection);
    const scopes = this.cacheScopes.get(connection.id) || new Set<string>();
    scopes.add(scope);
    this.cacheScopes.set(connection.id, scopes);
    const prior = this.safeReadAny<T & { cache?: JiraCacheMetadata }>(scope, key);
    if (options.cacheOnly)
      return prior
        ? { ...prior.value, cache: { source: "cache", fetchedAt: prior.fetchedAt, stale: prior.stale } }
        : null;
    if (options.refreshInBackground && prior) {
      if (!prior.stale && !options.forceRefresh)
        return { ...prior.value, cache: { source: "cache", fetchedAt: prior.fetchedAt, stale: false } };
      void this.cachedRead(connection, key, { forceRefresh: true }, load, ttlMs).catch(() => undefined);
      return { ...prior.value, cache: { source: "cache", fetchedAt: prior.fetchedAt, stale: prior.stale } };
    }
    const epoch = `${this.globalCacheEpoch}:${this.cacheEpochs.get(connection.id) || 0}`;
    const cacheKey = `${connection.id}:${scope}:${key}`;
    if (!options.forceRefresh) {
      const fresh = this.safeRead<T & { cache?: JiraCacheMetadata }>(scope, key);
      if (fresh) return { ...fresh.value, cache: { source: "cache", fetchedAt: fresh.fetchedAt, stale: false } };
    }
    let pending = this.cacheInflight.get(cacheKey) as Promise<T & { cache: JiraCacheMetadata }> | undefined;
    if (!pending) {
      pending = (async () => {
        try {
          const value = await load();
          const fetchedAt = Date.now();
          if (`${this.globalCacheEpoch}:${this.cacheEpochs.get(connection.id) || 0}` !== epoch)
            throw new JiraRequestError("network", "Jira result was invalidated while loading; refresh is required.");
          this.safeWriteCache(scope, key, value, ttlMs);
          if (key.startsWith("issue-detail:v3:")) {
            const ref = (value as { ref?: { issueId?: unknown; issueKey?: unknown } }).ref;
            for (const alias of [ref?.issueId, ref?.issueKey])
              if (typeof alias === "string" && alias && `issue-detail:v3:${alias}` !== key)
                this.safeWriteCache(scope, `issue-detail:v3:${alias}`, value, ttlMs);
          }
          return { ...value, cache: { source: "network", fetchedAt, stale: false } };
        } catch (error) {
          const code = error instanceof JiraRequestError ? error.code : "network";
          const retryAfterMs = error instanceof JiraRequestError ? error.retryAfterMs : undefined;
          if (code === "auth-expired") {
            this.invalidate(connection.id);
            throw error;
          }
          if (code === "permission-denied" || code === "not-found") {
            this.safeRemoveCache(scope, key);
            throw error;
          }
          if (`${this.globalCacheEpoch}:${this.cacheEpochs.get(connection.id) || 0}` !== epoch) throw error;
          const stale = this.safeReadAny<T & { cache?: JiraCacheMetadata }>(scope, key);
          if (!stale) throw error;
          return {
            ...stale.value,
            cache: {
              source: "cache",
              fetchedAt: stale.fetchedAt,
              stale: true,
              refreshError: {
                code,
                message: safeRefreshErrorMessage(code),
                ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
              },
            },
          };
        }
      })();
      this.cacheInflight.set(cacheKey, pending);
      void pending
        .finally(() => {
          if (this.cacheInflight.get(cacheKey) === pending) this.cacheInflight.delete(cacheKey);
        })
        .catch(() => undefined);
    }
    return pending;
  }

  private persistentCacheScope(connection: JiraConnection): string {
    const identity = connection.verifiedIdentity || connection.ownIdentity || null;
    const secretRefs = [connection.auth.secretRef, connection.auth.passphraseRef].filter((ref): ref is string =>
      Boolean(ref),
    );
    const secretFingerprints = secretRefs.map((ref) => {
      let secret = "";
      try {
        secret = this.credentialStore.getSecret(ref);
      } catch {}
      return createHash("sha256").update(`${ref}\0${secret}`).digest("hex");
    });
    const configKey = JSON.stringify({
      profileId: connection.profileId,
      connectionId: connection.id,
      deployment: connection.deployment,
      apiBaseUrl: normalizeJiraApiBaseUrl(connection.apiBaseUrl),
      cloudId: connection.cloudId || "",
      auth: connection.auth,
      subscriptionHeaderName: connection.subscriptionHeaderName || "",
      clientCertificatePath: connection.clientCertificatePath || "",
      accountPurpose: connection.accountPurpose,
      identity,
      secretFingerprints,
    });
    const memo = this.scopeMemo.get(connection.id);
    if (memo?.configKey === configKey) return memo.scope;
    const scope = `jira-scope:${createHash("sha256").update(configKey).digest("hex")}`;
    this.scopeMemo.set(connection.id, { configKey, scope });
    return scope;
  }

  private readHistory<T>(connection: JiraConnection, key: string, fallback: T): T {
    const scope = this.persistentCacheScope(connection);
    const entry = this.safeReadAny<T>(scope, `history:${key}`);
    return entry ? entry.value : fallback;
  }

  private writeHistory<T>(connection: JiraConnection, key: string, value: T): void {
    const scope = this.persistentCacheScope(connection);
    this.safeWriteCache(scope, `history:${key}`, value, 365 * 24 * 60 * 60_000);
  }

  private safeRead<T>(scope: string, key: string) {
    try {
      return this.persistentCache?.read<T>(scope, key);
    } catch {
      return undefined;
    }
  }
  private safeReadAny<T>(scope: string, key: string) {
    try {
      return this.persistentCache?.readAny<T>(scope, key);
    } catch {
      return undefined;
    }
  }
  private safeWriteCache<T>(scope: string, key: string, value: T, ttlMs: number): void {
    try {
      this.persistentCache?.write(scope, key, value, ttlMs);
    } catch {}
  }
  private safeInvalidateCache(scope: string, keepKeyPrefix?: string): void {
    try {
      this.persistentCache?.invalidate(scope, keepKeyPrefix ? { keepKeyPrefix } : undefined);
    } catch {}
  }
  private safeRemoveCache(scope: string, key: string): void {
    try {
      this.persistentCache?.remove(scope, key);
    } catch {}
  }

  private normalizeIssue(connection: JiraConnection, raw: Record<string, any>): JiraIssue {
    const fields = raw.fields || {};
    const key = String(raw.key || "");
    return {
      ref: { provider: "jira", connectionId: connection.id, issueId: String(raw.id), issueKey: key },
      summary: String(fields.summary || ""),
      status: String(fields.status?.name || "Unknown"),
      ...(fields.status?.id != null && String(fields.status.id) ? { statusId: String(fields.status.id) } : {}),
      ...(["new", "indeterminate", "done"].includes(fields.status?.statusCategory?.key)
        ? { statusCategory: fields.status.statusCategory.key as "new" | "indeterminate" | "done" }
        : {}),
      issueType: String(fields.issuetype?.name || "Issue"),
      projectKey: String(fields.project?.key || key.split("-")[0] || ""),
      updated: String(fields.updated || ""),
      ...(fields.assignee?.displayName ? { assignee: String(fields.assignee.displayName) } : {}),
      ...(connection.deployment === "cloud" && fields.assignee?.accountId
        ? {
            assigneeRef: {
              kind: "cloud" as const,
              accountId: String(fields.assignee.accountId),
              displayName: String(fields.assignee.displayName || fields.assignee.accountId || "Jira user"),
            },
          }
        : connection.deployment === "data-center" && (fields.assignee?.name || fields.assignee?.key)
          ? {
              assigneeRef: {
                kind: "data-center" as const,
                ...(fields.assignee.key ? { key: String(fields.assignee.key) } : {}),
                name: String(fields.assignee.name || fields.assignee.key),
                displayName: String(fields.assignee.displayName || fields.assignee.name || "Jira user"),
              },
            }
          : {}),
      ...(typeof fields.priority?.name === "string" && fields.priority.name
        ? { priority: fields.priority.name.slice(0, 256) }
        : {}),
      ...(typeof fields.reporter?.displayName === "string" && fields.reporter.displayName
        ? { reporter: fields.reporter.displayName.slice(0, 256) }
        : {}),
      ...(typeof fields.created === "string" && fields.created ? { created: fields.created.slice(0, 128) } : {}),
      ...(typeof fields.resolution?.name === "string" && fields.resolution.name
        ? { resolution: fields.resolution.name.slice(0, 256) }
        : {}),
      ...(Array.isArray(fields.labels)
        ? {
            labels: fields.labels
              .filter((value: unknown) => typeof value === "string")
              .slice(0, 100)
              .map((value: string) => value.slice(0, 256)),
          }
        : {}),
      ...(Array.isArray(fields.components)
        ? {
            components: fields.components
              .flatMap((item: any) => (typeof item?.name === "string" && item.name ? [item.name.slice(0, 256)] : []))
              .slice(0, 100),
          }
        : {}),
      ...(Array.isArray(fields.fixVersions)
        ? {
            versions: fields.fixVersions
              .flatMap((item: any) => (typeof item?.name === "string" && item.name ? [item.name.slice(0, 256)] : []))
              .slice(0, 100),
          }
        : {}),
      ...(Array.isArray(fields.issuelinks)
        ? {
            issueLinks: fields.issuelinks.slice(0, 100).flatMap((item: any) => {
              const type = typeof item?.type?.name === "string" ? item.type.name.slice(0, 256) : "";
              const outward = item?.outwardIssue;
              const inward = item?.inwardIssue;
              const linked = outward || inward;
              if (!type || typeof linked?.key !== "string" || !linked.key) return [];
              return [
                {
                  type,
                  direction: outward ? ("outward" as const) : ("inward" as const),
                  issueKey: linked.key.slice(0, 128),
                  ...(typeof linked.fields?.summary === "string" && linked.fields.summary
                    ? { summary: linked.fields.summary.slice(0, 32_000) }
                    : {}),
                  ...(typeof linked.fields?.status?.name === "string" && linked.fields.status.name
                    ? { status: linked.fields.status.name.slice(0, 256) }
                    : {}),
                },
              ];
            }),
          }
        : {}),
      url: (() => {
        const webUrl = safeUrl(connection.webUrl, "Jira web URL");
        webUrl.pathname = `${webUrl.pathname.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}`;
        return webUrl.toString();
      })(),
    };
  }

  private apiRoot(connection: JiraConnection): URL {
    if (connection.deployment === "cloud") {
      if (connection.cloudId)
        return new URL(`${cloudGatewayPath(connection.cloudId)}/rest/api/3/`, CLOUD_GATEWAY_ORIGIN);
      return new URL("/rest/api/3/", cloudSiteOrigin(connection.webUrl));
    }
    const base = safeUrl(connection.apiBaseUrl, "Jira API URL");
    base.pathname = `${base.pathname.replace(/\/$/, "")}/${connection.auth.kind === "dc-apim" ? "rest/api/latest" : "rest/api/2"}/`;
    return base;
  }

  private agileRoot(connection: JiraConnection): URL {
    const api = this.apiRoot(connection);
    if (connection.deployment === "cloud")
      return connection.cloudId
        ? new URL(`${cloudGatewayPath(connection.cloudId)}/rest/agile/1.0/`, CLOUD_GATEWAY_ORIGIN)
        : new URL("/rest/agile/1.0/", api.origin);
    const base = safeUrl(connection.apiBaseUrl, "Jira API URL");
    base.pathname = `${base.pathname.replace(/\/$/, "")}/rest/agile/1.0/`;
    if (api.origin !== base.origin) throw new Error("Jira Agile API origin is invalid.");
    return base;
  }

  /**
   * Jira's board configuration names no column status, only its id. Best effort, memoised per connection for an
   * hour (five minutes after a failure): without the names a status with no loaded issue cannot be offered as a filter.
   */
  private async statusNames(connection: JiraConnection, deadlineAt: number): Promise<Map<string, string>> {
    const memo = this.statusNameMemo.get(connection.id);
    if (memo && Date.now() < memo.expiresAt) return memo.names;
    try {
      const body = await this.readJson(await this.request(connection, "/status", this.remainingBudget(deadlineAt)));
      const names = new Map<string, string>();
      if (Array.isArray(body))
        for (const status of body)
          if (status?.id != null && typeof status.name === "string" && status.name.trim())
            names.set(String(status.id), status.name.trim().slice(0, 256));
      this.statusNameMemo.set(connection.id, { expiresAt: Date.now() + 60 * 60_000, names });
      logJiraRecovered(connection.id, "status-names");
      return names;
    } catch (error) {
      logJiraFailure({
        connectionId: connection.id,
        scope: "status-names",
        code: error instanceof JiraRequestError ? error.code : "unknown",
      });
      const names = memo?.names ?? new Map<string, string>();
      this.statusNameMemo.set(connection.id, { expiresAt: Date.now() + 5 * 60_000, names });
      return names;
    }
  }

  private async request(
    connection: JiraConnection,
    path: string,
    maxDurationMs?: number,
    maxResponseBytes = 10 * 1024 * 1024,
    tooLargeMessage = "Jira response exceeds the 10 MiB response limit.",
  ): Promise<Response> {
    return this.fetchAuthenticated(
      connection,
      new URL(path.replace(/^\//, ""), this.apiRoot(connection)),
      maxDurationMs,
      maxResponseBytes,
      tooLargeMessage,
    );
  }

  private async fetchAuthenticated(
    connection: JiraConnection,
    url: URL,
    maxDurationMs?: number,
    maxResponseBytes = 10 * 1024 * 1024,
    tooLargeMessage = "Jira response exceeds the 10 MiB response limit.",
  ): Promise<Response> {
    const root = this.apiRoot(connection);
    const agile = this.agileRoot(connection);
    const allowedPath =
      url.pathname.startsWith(root.pathname) ||
      (url.origin === agile.origin && url.pathname.startsWith(agile.pathname));
    if (url.origin !== root.origin || !allowedPath)
      throw new Error("Jira API request escaped the configured API root.");
    const deadlineAt = this.requestDeadline(Math.min(25_000, Math.max(1, maxDurationMs ?? 25_000)));
    let release: (() => void) | undefined;
    let dispatcher: Agent | undefined;
    let destroyDispatcher = false;
    let stage: JiraRequestStage = "acquire";
    try {
      release = await this.requestScheduler.acquire(connection.id, deadlineAt);
      stage = "auth";
      const headers = await this.untilDeadline(this.authHeaders(connection), deadlineAt);
      stage = "connect";
      dispatcher = await this.createDispatcher(connection);
      stage = "read";
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetchReadResponse(
          url,
          headers,
          deadlineAt,
          maxResponseBytes,
          tooLargeMessage,
          dispatcher,
        );
        if (response.status === 429 && attempt < 2) {
          const backoff = this.retryAfter(response.headers.get("retry-after"), attempt);
          if (backoff >= deadlineAt - Date.now())
            throw new JiraRequestError(
              "rate-limited",
              "Jira rate limit reached. Try again shortly.",
              this.retryAfterHeader(response.headers.get("retry-after")),
              429,
            );
          await this.delayWithinDeadline(backoff, deadlineAt);
          continue;
        }
        const checked = await this.checkResponse(response);
        this.noteSuccess(connection);
        return checked;
      }
    } catch (error) {
      destroyDispatcher = true;
      throw this.failRequest(connection, error, stage, url);
    } finally {
      if (destroyDispatcher) await dispatcher?.destroy().catch(() => undefined);
      else await dispatcher?.close().catch(() => dispatcher?.destroy());
      release?.();
    }
  }

  private async fetchReadResponse(
    url: URL,
    headers: Headers,
    deadlineAt: number,
    maxResponseBytes = 10 * 1024 * 1024,
    tooLargeMessage = "Jira response exceeds the 10 MiB response limit.",
    dispatcher?: Agent,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
    try {
      const response = await this.untilDeadline(
        this.fetchImpl(url, {
          headers,
          redirect: "error",
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit),
        deadlineAt,
        () => controller.abort(),
      );
      if (!response.body)
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const part = await this.untilDeadline(reader.read(), deadlineAt, () => controller.abort());
          if (part.done) break;
          total += part.value.byteLength;
          if (total > maxResponseBytes) {
            void reader.cancel().catch(() => undefined);
            throw new JiraRequestError("unsupported", tooLargeMessage);
          }
          chunks.push(part.value);
        }
      } catch (error) {
        controller.abort();
        void reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* An aborted read can still be settling; its controller owns the stream now. */
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async untilDeadline<T>(promise: Promise<T>, deadlineAt: number, onTimeout?: () => void): Promise<T> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      onTimeout?.();
      throw new Error("Jira request deadline exceeded.");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error("Jira request deadline exceeded."));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `now + ownMs`, cut to the caller's `withinJiraCallBudget`; refused unsent when less than `minimumMs` is left. */
  private requestDeadline(ownMs: number, minimumMs = 1): number {
    const own = Date.now() + ownMs;
    const budget = callBudget.getStore();
    if (!budget?.open) return own;
    if (budget.deadlineAt - Date.now() < minimumMs)
      throw this.notSentError("network", "Jira did not answer in time; nothing more was sent. Try again.");
    return Math.min(own, budget.deadlineAt);
  }

  private remainingBudget(deadlineAt: number): number {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new JiraRequestError("network", "Jira request exceeded its time limit.");
    return remaining;
  }

  private async delayWithinDeadline(delayMs: number, deadlineAt: number): Promise<void> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0 || delayMs >= remaining) throw new Error("Jira request deadline exceeded during retry delay.");
    await this.untilDeadline(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), deadlineAt);
  }

  /** Jira's own wait, or undefined when it sent none: callers must not mistake a local default for Jira's word. */
  private retryAfterHeader(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(parsed) ? Math.min(10 * 60_000, Math.max(0, parsed)) : undefined;
  }

  private retryAfter(value: string | null, attempt: number): number {
    return this.retryAfterHeader(value) ?? Math.min(15_000, 500 * 2 ** attempt);
  }

  private async sendWrite(
    connection: JiraConnection,
    path: string,
    body: unknown,
    method: "POST" | "PUT" = "POST",
  ): Promise<void> {
    const url = new URL(path.replace(/^\//, ""), this.apiRoot(connection));
    const root = this.apiRoot(connection);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname))
      throw new JiraRequestError(
        "configuration-incomplete",
        "The Jira write was refused because it points outside the configured Jira API.",
        undefined,
        undefined,
        { notSent: true },
      );
    const deadlineAt = this.requestDeadline(25_000, JIRA_WRITE_MIN_WINDOW_MS);
    let release: (() => void) | undefined;
    let dispatcher: Agent | undefined;
    let destroyDispatcher = false;
    let stage: JiraRequestStage = "acquire";
    try {
      release = await this.requestScheduler.acquire(connection.id, deadlineAt);
      stage = "auth";
      const headers = await this.untilDeadline(this.authHeaders(connection), deadlineAt);
      stage = "connect";
      dispatcher = await this.createDispatcher(connection);
      stage = "read";
      headers.set("Content-Type", "application/json");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadlineAt - Date.now()));
      try {
        const response = await this.untilDeadline(
          this.fetchImpl(url, {
            method,
            headers,
            body: JSON.stringify(body),
            redirect: "error",
            signal: controller.signal,
            ...(dispatcher ? { dispatcher } : {}),
          } as RequestInit),
          deadlineAt,
          () => controller.abort(),
        );
        await this.checkResponse(response);
        await response.body?.cancel().catch(() => undefined);
        this.noteSuccess(connection);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      destroyDispatcher = true;
      throw this.failRequest(connection, error, stage, url, "Jira write request failed or exceeded its time limit.");
    } finally {
      if (destroyDispatcher) await dispatcher?.destroy().catch(() => undefined);
      else await dispatcher?.close().catch(() => dispatcher?.destroy());
      release?.();
    }
  }

  private async authHeaders(connection: JiraConnection): Promise<Headers> {
    const headers = new Headers({ Accept: "application/json" });
    if (connection.auth.kind === "dc-apim") {
      if (connection.deployment !== "data-center" || !connection.auth.secretRef)
        throw this.notSentError("configuration-incomplete", "Jira API gateway configuration is invalid.");
      const key = this.credentialStore.getSecret(connection.auth.secretRef);
      const name = connection.subscriptionHeaderName || "Ocp-Apim-Subscription-Key";
      if (!key)
        throw this.notSentError(
          "credential-missing",
          "Jira API gateway credentials are missing. Reconnect this Jira connection.",
        );
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
        throw this.notSentError(
          "configuration-incomplete",
          "The Jira API gateway header name is invalid. Edit this connection.",
        );
      headers.set(name, key);
    } else if (connection.auth.kind === "dc-pat") {
      if (connection.deployment !== "data-center" || !connection.auth.secretRef)
        throw this.notSentError("configuration-incomplete", "Data Center PAT configuration is invalid.");
      const token = this.credentialStore.getSecret(connection.auth.secretRef);
      if (!token) throw this.notSentError("credential-missing", "Jira PAT is missing. Reconnect this Jira connection.");
      headers.set("Authorization", `Bearer ${token}`);
    } else if (connection.auth.kind === "cloud-api-token") {
      const email = connection.auth.email?.trim();
      if (connection.deployment !== "cloud" || !connection.auth.secretRef || !email)
        throw this.notSentError("configuration-incomplete", "Jira Cloud API token configuration is invalid.");
      const token = this.credentialStore.getSecret(connection.auth.secretRef);
      if (!token)
        throw this.notSentError("credential-missing", "Jira API token is missing. Reconnect this Jira connection.");
      headers.set("Authorization", `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`);
    } else {
      throw this.notSentError("configuration-incomplete", "Jira connection configuration is invalid.");
    }
    return headers;
  }

  private notSentError(code: JiraRequestErrorCode, message: string): JiraRequestError {
    return new JiraRequestError(code, message, undefined, undefined, { notSent: true });
  }

  private async createDispatcher(connection: JiraConnection): Promise<Agent | undefined> {
    if (connection.auth.kind !== "dc-apim") return undefined;
    if (!connection.clientCertificatePath) {
      if (connection.auth.passphraseRef)
        throw new JiraRequestError(
          "configuration-incomplete",
          "The saved client certificate file is missing. Edit this connection and choose its PFX/P12 file again. Enter its password again if required.",
        );
      return undefined;
    }
    let pfx: Buffer;
    try {
      pfx = await readFile(connection.clientCertificatePath);
    } catch (error) {
      throw (
        describePfxFailure(error) ??
        new JiraRequestError(
          "certificate-invalid",
          "The client certificate file could not be read. Edit this connection and choose its PFX/P12 file again.",
          undefined,
          undefined,
          { cause: error, notSent: true },
        )
      );
    }
    const passphrase = connection.auth.passphraseRef
      ? this.credentialStore.getSecret(connection.auth.passphraseRef) || undefined
      : undefined;
    try {
      createSecureContext({ pfx, ...(passphrase ? { passphrase } : {}) });
    } catch (error) {
      const failure =
        describePfxFailure(error) ??
        new JiraRequestError(
          "certificate-invalid",
          "The client certificate could not be loaded. Check the PFX/P12 file and its password.",
          undefined,
          undefined,
          { cause: error, notSent: true },
        );
      log.warn("jira client certificate could not be loaded", {
        connectionId: connection.id,
        errCode: errorCauseCode(error),
      });
      throw failure;
    }
    return new Agent({ connect: { pfx, ...(passphrase ? { passphrase } : {}) } });
  }

  private async checkResponse(response: Response): Promise<Response> {
    if (response.ok) return response;
    const bodyText = await this.readBoundedBody(response);
    const detail = jiraErrorDetail(bodyText);
    const status = response.status;
    if (status === 401)
      throw new JiraRequestError("auth-expired", "Jira rejected this connection. Sign in again.", undefined, 401, {
        detail: detail.message,
      });
    if (status === 403)
      throw new JiraRequestError(
        "permission-denied",
        "This Jira account does not have permission for that data.",
        undefined,
        403,
        { detail: detail.message },
      );
    if (status === 404)
      throw new JiraRequestError("not-found", "Jira could not find the requested issue or resource.", undefined, 404, {
        detail: detail.message,
      });
    if (status === 429)
      throw new JiraRequestError(
        "rate-limited",
        "Jira rate limit reached. Try again shortly.",
        this.retryAfterHeader(response.headers.get("retry-after")),
        429,
      );
    if (status === 400) {
      const normalized = detail.raw.replace(/[’‘]/g, "'").toLowerCase();
      if (
        normalized.includes("the backlog is not available on kanban boards") ||
        normalized.includes("the board doesn't support sprints")
      )
        throw new JiraRequestError(
          "unsupported",
          "This Jira board does not support the requested view.",
          undefined,
          400,
        );
    }
    if (detail.fields.length || detail.message) {
      const throttleKey = `${status}:${detail.fields.join(",")}`;
      const at = Date.now();
      if (at - (refusalLoggedAt.get(throttleKey) ?? 0) >= 60_000) {
        if (refusalLoggedAt.size > 200) refusalLoggedAt.clear();
        refusalLoggedAt.set(throttleKey, at);
        log.warn("jira refused a request", {
          status,
          fields: detail.fields.slice(0, 10),
          messages: detail.messageCount,
        });
      }
    }
    throw new JiraRequestError(
      status >= 500 ? "network" : "unknown",
      `Jira request failed (${status})${detail.message ? `: ${detail.message}` : "."}`,
      undefined,
      status,
      { detail: detail.message },
    );
  }

  /** At most a few KiB of an error body, read BEFORE the stream is dropped; never more, never an exception. */
  private async readBoundedBody(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < MAX_ERROR_BODY_BYTES) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        total += part.value.byteLength;
      }
    } catch {
      /* A broken body only costs the explanation. */
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      .subarray(0, MAX_ERROR_BODY_BYTES)
      .toString("utf8");
  }
}

/** Jira's own explanation of a refusal, flattened to a short message plus the names of the fields it objected to. */
export function jiraErrorDetail(bodyText: string): {
  message: string;
  raw: string;
  fields: string[];
  messageCount: number;
} {
  let raw = bodyText;
  const messages: string[] = [];
  const fields: string[] = [];
  try {
    const body = JSON.parse(bodyText) as {
      errorMessages?: unknown;
      errors?: Record<string, unknown>;
      message?: unknown;
    };
    for (const value of Array.isArray(body.errorMessages) ? body.errorMessages : [])
      if (typeof value === "string") messages.push(value);
    if (typeof body.message === "string") messages.push(body.message);
    for (const [field, value] of Object.entries(body.errors && typeof body.errors === "object" ? body.errors : {})) {
      if (typeof value !== "string") continue;
      fields.push(field.slice(0, 64));
      messages.push(`${field.slice(0, 64)}: ${value}`);
    }
    raw = messages.join(" ");
  } catch {
    // Jira may return a plain-text or HTML error body; that is never shown.
    return { message: "", raw: raw.replace(/<[^>]*>/g, " "), fields, messageCount: 0 };
  }
  const clean = messages
    .map((message) =>
      message
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const joined = clean.join("; ").slice(0, 300);
  return { message: joined, raw, fields, messageCount: clean.length };
}

export function jiraWriteTextFingerprint(value: string): string {
  return createHash("sha256").update(String(value).replace(/\r\n/g, "\n").trim(), "utf8").digest("hex");
}

function sameJiraAuthor(raw: unknown, actor: JiraWriteReconcileActor): boolean {
  if (!raw || typeof raw !== "object") return false;
  const author = raw as Record<string, unknown>;
  return actor.kind === "cloud"
    ? String(author.accountId || "") === actor.accountId
    : String(author.name || author.key || "") === actor.name;
}

function hashWriteText(value: string): string {
  return jiraWriteTextFingerprint(value.replace(/\n+$/, ""));
}

const MAX_RENDERED_HTML_CHARS = 200_000;

function boundedRenderedHtml(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= MAX_RENDERED_HTML_CHARS ? value : undefined;
}

function normalizeAttachments(value: unknown): JiraAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item: Record<string, unknown>) => {
    const id = String(item?.id || "");
    const fileName = String(item?.filename || "");
    const sizeBytes = Number(item?.size);
    if (!/^\d{1,32}$/.test(id) || !fileName || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return [];
    const mediaType = String(item?.mimeType || "application/octet-stream");
    return [
      {
        id,
        fileName: fileName.replace(/[\\/\0-\x1f]/g, "_").slice(0, 128) || `attachment-${id}`,
        mediaType: /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i.test(mediaType)
          ? mediaType
          : "application/octet-stream",
        sizeBytes: Math.min(sizeBytes, Number.MAX_SAFE_INTEGER),
      },
    ];
  });
}

function decodeJiraHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return text.replace(/&(#(?:x[\da-f]{1,6}|\d{1,7})|[a-z][a-z\d]{1,31});/gi, (entity, code: string) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
    const hex = code[1]?.toLowerCase() === "x";
    const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
      return "\uFFFD";
    return String.fromCodePoint(point);
  });
}

/** As in Jira, an emphasis mark counts only at a word edge: `snake_case_name` and `a+b+c` keep their characters. */
function stripWikiEmphasis(text: string): string {
  return text
    .replace(/(?<![\p{L}\p{N}])\*([^*\n]+)\*(?![\p{L}\p{N}])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])\+([^+\n]+)\+(?![\p{L}\p{N}])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])\^([^^\n]+)\^(?![\p{L}\p{N}])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])~([^~\n]+)~(?![\p{L}\p{N}])/gu, "$1");
}

function safeJiraText(value: unknown, depth = 0, budget = { remaining: 32_000, codeBodies: [] as string[] }): string {
  if (depth > 20 || budget.remaining <= 0 || value == null) return "";
  const clean = (text: string) =>
    text
      // Jira wiki macros are presentation wrappers, not user-facing prose. Code
      // bodies are protected separately by formatText so prose cleanup cannot alter them.
      .replace(/\{panel:[^}]*\}|\{panel\}/gi, (macro) => {
        const attributes = macro.toLowerCase().startsWith("{panel:") ? macro.slice(7, -1) : "";
        const title = attributes
          .split("|")
          .find((attribute) => /^\s*title=/i.test(attribute))
          ?.replace(/^\s*title=/i, "")
          .trim();
        return title ? `\n${title}\n` : "\n";
      })
      .replace(/\{\/?panel\}/gi, "\n")
      .replace(/\{quote:[^}]*\}|\{quote\}/gi, "\n")
      .replace(/\{\/?quote\}/gi, "\n")
      .replace(/\[~([A-Za-z0-9._@-]{1,128})\]/g, "@$1")
      .replace(/\{anchor:[^}]*\}/gi, "")
      // Preserve structure from Jira's HTML-rendered descriptions before removing
      // tags. The result remains plain text for safely escaped frontend rendering.
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/?(?:p|div|h[1-6]|blockquote|pre|table|tr)\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<\/li\s*>/gi, "\n")
      .replace(
        /<a\b[^>]*href\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a\s*>/gi,
        (_match, _quote, href, label) =>
          String(label).replace(/<[^>]*>/g, "") === href ? href : `${String(label).replace(/<[^>]*>/g, "")} (${href})`,
      )
      .replace(/<[^>]*>/g, "")
      .replace(/\{color\}/gi, "")
      .replace(/\{color:[^}]*\}/gi, "")
      .replace(/\{\{/g, "")
      .replace(/\}\}/g, "")
      .replace(/^\*+\s+/gm, "- ")
      .replace(/^\++\s+/gm, "- ")
      .replace(/^(#+)\s+/gm, (_match, marks: string) => `${"  ".repeat(marks.length - 1)}${marks.length}. `)
      .split(/(https?:\/\/[^\s<>"]+)/)
      .map((part, index) => (index % 2 ? part : stripWikiEmphasis(part)))
      .join("")
      .replace(/[{}]/g, "")
      .replace(/\?\?/g, "")
      .replace(/\[([^\]|]+)\|[^\]]+\]/g, "$1")
      .replace(/^h[1-6]\.\s*/gm, "")
      .replace(/^\*\s+/gm, "- ")
      .replace(/\r/g, "")
      .replace(/&nbsp;/gi, " ");
  const normalizeWhitespace = (text: string) =>
    decodeJiraHtmlEntities(text)
      .replace(/(^|\n)-[ \t]*\n+/g, "$1- ")
      .replace(/[\t\f\v ]+\n/g, "\n")
      .replace(/\n[\t\f\v ]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  const formatText = (text: string) => {
    const lower = text.toLowerCase();
    let protectedText = "";
    let scanAt = 0;
    let copiedThrough = 0;
    let opening: { name: "code" | "noformat"; start: number; bodyStart: number } | undefined;
    while (scanAt < text.length) {
      if (text[scanAt] !== "{") {
        scanAt++;
        continue;
      }
      let name: "code" | "noformat" | undefined;
      let tokenEnd = scanAt;
      let isClosingForm = false;
      if (lower.startsWith("{noformat}", scanAt)) {
        name = "noformat";
        tokenEnd += 10;
        isClosingForm = true;
      } else if (lower.startsWith("{code}", scanAt)) {
        name = "code";
        tokenEnd += 6;
        isClosingForm = true;
      } else if (lower.startsWith("{code:", scanAt)) {
        name = "code";
        while (tokenEnd < text.length && text[tokenEnd] !== "}") tokenEnd++;
        if (tokenEnd < text.length) tokenEnd++;
        else break;
      }
      if (!name) {
        scanAt++;
        continue;
      }
      if (opening?.name === name && isClosingForm) {
        const index = budget.codeBodies.push(text.slice(opening.bodyStart, scanAt)) - 1;
        protectedText += `${text.slice(copiedThrough, opening.start)}\n\uE000JIRACODE${index}\uE001\n`;
        copiedThrough = tokenEnd;
        opening = undefined;
      } else if (!opening) {
        opening = { name, start: scanAt, bodyStart: tokenEnd };
      }
      scanAt = tokenEnd;
    }
    protectedText += text.slice(copiedThrough);
    return normalizeWhitespace(clean(protectedText));
  };
  const clip = (text: string) => {
    const codePattern = /\uE000JIRACODE(\d+)\uE001/g;
    let result = "";
    let cursor = 0;
    for (const match of text.matchAll(codePattern)) {
      const index = match.index ?? 0;
      const plain = text.slice(cursor, index);
      const accepted = plain.slice(0, budget.remaining);
      result += accepted;
      budget.remaining -= accepted.length;
      if (budget.remaining <= 0) break;
      const codeIndex = Number(match[1]);
      const body = budget.codeBodies[codeIndex] ?? "";
      const acceptedCode = body.slice(0, budget.remaining);
      budget.codeBodies[codeIndex] = acceptedCode;
      budget.remaining -= acceptedCode.length;
      result += match[0];
      cursor = index + match[0].length;
    }
    if (budget.remaining > 0) {
      const tail = text.slice(cursor);
      const accepted = tail.slice(0, budget.remaining);
      result += accepted;
      budget.remaining -= accepted.length;
    }
    return result;
  };
  const finish = (text: string) =>
    depth === 0
      ? text.replace(
          /\uE000JIRACODE(\d+)\uE001/g,
          (_match, rawIndex: string) => budget.codeBodies[Number(rawIndex)] ?? "",
        )
      : text;
  if (typeof value === "string") {
    const text = formatText(value);
    return finish(clip(depth === 0 ? text.trim() : text));
  }
  if (Array.isArray(value)) {
    const pieces: string[] = [];
    for (const item of value) {
      if (budget.remaining <= 0) break;
      const piece = safeJiraText(item, depth + 1, budget);
      if (piece) pieces.push(piece);
    }
    return finish(pieces.join(""));
  }
  if (typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (object.type === "codeBlock" && Array.isArray(object.content)) {
    let codeBudget = budget.remaining;
    const readCode = (node: unknown, nesting: number): string => {
      if (nesting > 20 || codeBudget <= 0 || node == null) return "";
      if (typeof node === "string") {
        const part = node.slice(0, codeBudget);
        codeBudget -= part.length;
        return part;
      }
      if (Array.isArray(node)) {
        const pieces: string[] = [];
        for (const child of node) {
          if (codeBudget <= 0) break;
          pieces.push(readCode(child, nesting + 1));
        }
        return pieces.join("");
      }
      if (typeof node !== "object") return "";
      const child = node as Record<string, unknown>;
      if (typeof child.text === "string" || typeof child.value === "string")
        return readCode(String(child.text ?? child.value), nesting + 1);
      if (child.type === "hardBreak") return readCode("\n", nesting + 1);
      return Array.isArray(child.content) ? readCode(child.content, nesting + 1) : "";
    };
    const code = readCode(object.content, depth + 1);
    const index = budget.codeBodies.push(code) - 1;
    const token = `\uE000JIRACODE${index}\uE001`;
    let result = clip(token);
    if (depth !== 0 && budget.remaining > 0) {
      budget.remaining -= 1;
      result += "\n";
    }
    return finish(depth === 0 ? result.trim() : result);
  }
  if (typeof object.text === "string" || typeof object.value === "string") {
    const text = formatText(String(object.text ?? object.value));
    return finish(clip(depth === 0 ? text.trim() : text));
  }
  if (Array.isArray(object.content)) {
    const text = safeJiraText(object.content, depth + 1, budget);
    const sep = object.type === "paragraph" || object.type === "heading" || object.type === "listItem" ? "\n" : "";
    if (!sep || budget.remaining <= 0) return finish(depth === 0 ? text.trim() : text);
    budget.remaining -= 1;
    const result = `${text}\n`;
    return finish(depth === 0 ? result.trim() : result);
  }
  return "";
}
