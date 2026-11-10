import { createHash } from "node:crypto";
import type { JiraPollingWatchStatus } from "../../shared/types/jira-workspace-views.js";
import { JIRA_POLL_MAX_SECONDS, JIRA_POLL_MIN_SECONDS } from "../../shared/jira-poll-interval.js";

export type JiraPollKey = { profileId: string; connectionId: string; queryId: string };
export type JiraPollIssue = { issueId: string; issueKey: string; updatedAt: number };
export type JiraPollConfig = JiraPollKey & { query: string; intervalMs: number; enabled: boolean };
export type JiraPollRequest = JiraPollKey & {
  query: string;
  watermark: number | null;
  overlapMs: number;
  maxIssues: number;
  maxRequests: number;
};
export type JiraPollResult =
  | { kind: "snapshot"; supported: true; complete: boolean; observedAt: number; issues: JiraPollIssue[] }
  | { kind: "unsupported"; reasonCode: string }
  | { kind: "rate-limited"; retryAfterMs?: number };
export type JiraPollNotification = JiraPollKey & {
  eventId: string;
  type: "added" | "removed" | "changed";
  issueId: string;
  issueKey: string;
  observedAt: number;
};
export type JiraPollStatus = JiraPollKey & {
  status: "idle" | "polling" | "unsupported" | "incomplete" | "rate-limited" | "error";
  reasonCode?: string;
  retryAt?: number;
};
type Watch = {
  config: JiraPollConfig;
  members: Record<string, JiraPollIssue>;
  watermark: number | null;
  baselinePending: boolean;
  nextPollAt: number;
};
export type JiraPollingState = { version: 1; watches: Record<string, Watch>; dedupeIds: string[] };
export interface JiraPollingStore {
  load(): Promise<JiraPollingState | undefined>;
  save(state: JiraPollingState): Promise<void>;
}
export interface JiraPollingOptions {
  store: JiraPollingStore;
  poller: (request: JiraPollRequest) => Promise<JiraPollResult>;
  onNotification: (notification: JiraPollNotification) => Promise<void> | void;
  onStatus?: (status: JiraPollStatus) => Promise<void> | void;
  now?: () => number;
  limits?: Partial<{
    minIntervalMs: number;
    maxIntervalMs: number;
    maxIssues: number;
    maxRequests: number;
    maxDedupeIds: number;
    overlapMs: number;
    maxConcurrentPolls: number;
  }>;
}
export type JiraPollOutcome =
  | { status: "complete"; notifications: number; baseline: boolean }
  | { status: "pending" }
  | { status: "unsupported"; reasonCode: string }
  | { status: "incomplete" }
  | { status: "rate-limited"; retryAt: number }
  | { status: "error" }
  | { status: "disabled" };

const RATE_LIMIT_BACKOFF_CAP_MS = 15 * 60_000;
const emptyState = (): JiraPollingState => ({ version: 1, watches: {}, dedupeIds: [] });
const bounded = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const watchId = (key: JiraPollKey): string => JSON.stringify([key.profileId, key.connectionId, key.queryId]);
const memberId = (issueId: string): string => `issue:${issueId}`;
const eventId = (watch: Watch, type: JiraPollNotification["type"], issue: JiraPollIssue): string =>
  createHash("sha256")
    .update(
      `${watch.config.profileId}\0${watch.config.connectionId}\0${watch.config.queryId}\0${type}\0${issue.issueId}\0${issue.updatedAt}\0${issue.issueKey}`,
    )
    .digest("hex");

/** Opt-in polling and bounded membership-delta detection. The caller owns profile/connection authorization. */
export class JiraPollingService {
  private readonly now: () => number;
  private readonly limits: Required<NonNullable<JiraPollingOptions["limits"]>>;
  private state: JiraPollingState | undefined;
  private loading?: Promise<JiraPollingState>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, Promise<JiraPollOutcome>>();
  private disposed = false;
  private running = 0;
  /** Consecutive rate-limited polls per watch; in memory only, so a restart simply asks again. */
  private readonly rateLimitStrikes = new Map<string, number>();
  private readonly watchStatuses = new Map<
    string,
    Omit<JiraPollingWatchStatus, "connectionId"> & { profileId: string; connectionId: string; queryId: string }
  >();

  constructor(private readonly options: JiraPollingOptions) {
    this.now = options.now ?? Date.now;
    this.limits = {
      minIntervalMs: JIRA_POLL_MIN_SECONDS * 1000,
      maxIntervalMs: JIRA_POLL_MAX_SECONDS * 1000,
      maxIssues: 500,
      maxRequests: 5,
      maxDedupeIds: 5000,
      overlapMs: 5 * 60_000,
      maxConcurrentPolls: 2,
      ...options.limits,
    };
    if (
      this.limits.minIntervalMs < 1 ||
      this.limits.maxIntervalMs < this.limits.minIntervalMs ||
      this.limits.maxIssues < 1 ||
      this.limits.maxRequests < 1 ||
      this.limits.maxDedupeIds < 1 ||
      this.limits.maxConcurrentPolls < 1
    )
      throw new Error("Jira polling limits are invalid.");
  }

  async enable(config: JiraPollConfig): Promise<void> {
    this.assertLive();
    validateConfig(config, this.limits);
    const state = await this.getState();
    const key = watchId(config);
    const current = state.watches[key];
    const changed = !current || current.config.query !== config.query;
    const wasDisabled = current?.config.enabled !== true;
    const configChanged = changed || wasDisabled || current?.config.intervalMs !== config.intervalMs;
    if (!configChanged && current) {
      current.config = { ...config };
      this.schedule(key, Math.max(0, current.nextPollAt - this.now()));
      return;
    }
    state.watches[key] = {
      config: { ...config },
      members: changed ? {} : (current?.members ?? {}),
      watermark: changed ? null : (current?.watermark ?? null),
      baselinePending: changed || wasDisabled || current?.baselinePending === true,
      nextPollAt: changed || wasDisabled ? this.now() : (current?.nextPollAt ?? this.now()),
    };
    await this.persist();
    this.schedule(key, Math.max(0, state.watches[key].nextPollAt - this.now()));
  }

  async disable(key: JiraPollKey): Promise<void> {
    const state = await this.getState();
    const id = watchId(key);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const watch = state.watches[id];
    this.watchStatuses.delete(id);
    if (watch) {
      watch.config = { ...watch.config, enabled: false };
      watch.nextPollAt = Number.MAX_SAFE_INTEGER;
      await this.persist();
    }
  }

  /** What the last polls of one profile's saved queries did, by saved-query id. In memory only. */
  getWatchStatuses(profileId: string): Record<string, JiraPollingWatchStatus> {
    const result: Record<string, JiraPollingWatchStatus> = {};
    for (const item of this.watchStatuses.values()) {
      if (item.profileId !== profileId) continue;
      const { profileId: _profileId, queryId, ...status } = item;
      result[queryId] = status;
    }
    return result;
  }

  async listEnabled(): Promise<JiraPollConfig[]> {
    const state = await this.getState();
    return Object.values(state.watches)
      .filter((watch) => watch.config.enabled)
      .map((watch) => ({ ...watch.config }));
  }

  async removeConnection(profileId: string, connectionId: string): Promise<void> {
    const state = await this.getState();
    for (const [id, watch] of Object.entries(state.watches)) {
      if (watch.config.profileId !== profileId || watch.config.connectionId !== connectionId) continue;
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      this.watchStatuses.delete(id);
      delete state.watches[id];
    }
    await this.persist();
  }

  async disableProfile(profileId: string): Promise<void> {
    const state = await this.getState();
    for (const [id, watch] of Object.entries(state.watches)) {
      if (watch.config.profileId !== profileId) continue;
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      watch.config = { ...watch.config, enabled: false };
      watch.nextPollAt = Number.MAX_SAFE_INTEGER;
    }
    await this.persist();
  }

  async pollNow(key: JiraPollKey): Promise<JiraPollOutcome> {
    this.assertLive();
    const state = await this.getState();
    const id = watchId(key);
    const watch = state.watches[id];
    if (!watch || !watch.config.enabled) return { status: "disabled" };
    if (watch.nextPollAt > this.now()) return { status: "pending" };
    const current = this.inFlight.get(id);
    if (current) return current;
    if (this.running >= this.limits.maxConcurrentPolls) {
      this.schedule(id, Math.min(1000, Math.max(1, watch.config.intervalMs)));
      return { status: "pending" };
    }
    const promise = this.runPoll(id, watch);
    this.inFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(id);
      this.running -= 1;
      const latest = this.state?.watches[id];
      if (!this.disposed && latest?.config.enabled) this.schedule(id, Math.max(0, latest.nextPollAt - this.now()));
    }
  }

  /**
   * Somebody is using Jira in this profile: check its saved queries now instead of at their next slot.
   * Skips a watch that polled within `minAgeMs`, is already due or in flight, or is backing off from a
   * rate limit. Returns how many watches were brought forward.
   */
  async pollProfileSoon(profileId: string, minAgeMs: number): Promise<number> {
    this.assertLive();
    const state = await this.getState();
    const now = this.now();
    let nudged = 0;
    for (const [id, watch] of Object.entries(state.watches)) {
      if (watch.config.profileId !== profileId || !watch.config.enabled) continue;
      if (this.inFlight.has(id) || this.rateLimitStrikes.has(id) || watch.nextPollAt <= now) continue;
      const lastPolledAt = watch.nextPollAt - watch.config.intervalMs;
      if (now - lastPolledAt < minAgeMs) continue;
      watch.nextPollAt = now;
      this.schedule(id, 0);
      nudged += 1;
    }
    return nudged;
  }

  async start(): Promise<void> {
    this.assertLive();
    const state = await this.getState();
    for (const [id, watch] of Object.entries(state.watches)) {
      if (watch.config.enabled) this.schedule(id, Math.max(0, watch.nextPollAt - this.now()));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async runPoll(id: string, watch: Watch): Promise<JiraPollOutcome> {
    this.running += 1;
    const key = watch.config;
    await this.status({ ...key, status: "polling" });
    try {
      const result = await this.options.poller({
        profileId: key.profileId,
        connectionId: key.connectionId,
        queryId: key.queryId,
        query: key.query,
        watermark: watch.watermark === null ? null : Math.max(0, watch.watermark - this.limits.overlapMs),
        overlapMs: this.limits.overlapMs,
        maxIssues: this.limits.maxIssues,
        maxRequests: this.limits.maxRequests,
      });
      const latest = this.state?.watches[id];
      if (this.disposed || latest !== watch || !latest.config.enabled) return { status: "disabled" };
      if (result.kind !== "rate-limited") this.rateLimitStrikes.delete(id);
      if (result.kind === "unsupported") {
        watch.nextPollAt = this.now() + key.intervalMs;
        await this.persist();
        await this.status({ ...key, status: "unsupported", reasonCode: safeReason(result.reasonCode) });
        return { status: "unsupported", reasonCode: safeReason(result.reasonCode) };
      }
      if (result.kind === "rate-limited") {
        const strikes = (this.rateLimitStrikes.get(id) ?? 0) + 1;
        this.rateLimitStrikes.set(id, strikes);
        const explicit = result.retryAfterMs;
        const backoff = Math.min(RATE_LIMIT_BACKOFF_CAP_MS, key.intervalMs * 2 ** (strikes - 1));
        const retryAfter =
          typeof explicit === "number" && Number.isFinite(explicit)
            ? bounded(Math.max(explicit, backoff), 1000, this.limits.maxIntervalMs)
            : backoff;
        const retryAt = this.now() + retryAfter;
        watch.nextPollAt = retryAt;
        await this.status({ ...key, status: "rate-limited", retryAt });
        return { status: "rate-limited", retryAt };
      }
      if (!result.complete || result.issues.length > this.limits.maxIssues || !Number.isFinite(result.observedAt)) {
        watch.nextPollAt = this.now() + key.intervalMs;
        await this.persist();
        await this.status({ ...key, status: "incomplete" });
        return { status: "incomplete" };
      }
      const nextMembers = normalizeIssues(result.issues);
      const baseline = watch.baselinePending;
      let notifications = 0;
      if (!baseline) {
        const prior = watch.members;
        const changes: Array<{ type: JiraPollNotification["type"]; issue: JiraPollIssue }> = [];
        for (const issue of Object.values(nextMembers)) {
          const old = prior[memberId(issue.issueId)];
          if (!old) changes.push({ type: "added", issue });
          else if (old.updatedAt !== issue.updatedAt || old.issueKey !== issue.issueKey)
            changes.push({ type: "changed", issue });
        }
        for (const issue of Object.values(prior)) {
          if (!nextMembers[memberId(issue.issueId)]) changes.push({ type: "removed", issue });
        }
        for (const change of changes) {
          if (this.disposed || this.state?.watches[id] !== watch || !watch.config.enabled)
            return { status: "disabled" };
          const idempotencyId = eventId(watch, change.type, change.issue);
          if (this.state!.dedupeIds.includes(idempotencyId)) continue;
          await this.options.onNotification({
            profileId: key.profileId,
            connectionId: key.connectionId,
            queryId: key.queryId,
            eventId: idempotencyId,
            type: change.type,
            issueId: change.issue.issueId,
            issueKey: change.issue.issueKey,
            observedAt: result.observedAt,
          });
          if (this.disposed || this.state?.watches[id] !== watch || !watch.config.enabled)
            return { status: "disabled" };
          this.state!.dedupeIds.push(idempotencyId);
          notifications += 1;
        }
      }
      watch.members = nextMembers;
      if (result.issues.length)
        watch.watermark = Math.max(watch.watermark ?? 0, ...result.issues.map((issue) => issue.updatedAt));
      watch.baselinePending = false;
      watch.nextPollAt = this.now() + key.intervalMs;
      this.state!.dedupeIds = this.state!.dedupeIds.slice(-this.limits.maxDedupeIds);
      await this.persist();
      await this.status({ ...key, status: "idle" });
      return { status: "complete", notifications, baseline };
    } catch (error) {
      this.rateLimitStrikes.delete(id);
      watch.nextPollAt = this.now() + key.intervalMs;
      await this.persist().catch(() => undefined);
      const rawCode = (error as { code?: unknown } | null)?.code;
      const reason = typeof rawCode === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(rawCode) ? rawCode : "poll-failed";
      await this.status({ ...key, status: "error", reasonCode: reason });
      return { status: "error" };
    }
  }

  private schedule(id: string, delay: number): void {
    if (this.disposed) return;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const watch = this.state?.watches[id];
      if (watch?.config.enabled) void this.pollNow(watch.config);
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async getState(): Promise<JiraPollingState> {
    if (this.state) return this.state;
    this.loading ??= this.options.store.load().then((stored) => sanitizeJiraPollingState(stored) ?? emptyState());
    try {
      this.state = await this.loading;
    } catch (error) {
      this.loading = undefined;
      throw error;
    }
    return this.state;
  }

  private async persist(): Promise<void> {
    await this.options.store.save(structuredClone(await this.getState()));
  }

  private async status(status: JiraPollStatus): Promise<void> {
    this.recordStatus(status);
    try {
      await this.options.onStatus?.(status);
    } catch {
      // Status reporting must not change polling or persistence behavior.
    }
  }

  private recordStatus(status: JiraPollStatus): void {
    const id = watchId(status);
    if (!this.state?.watches[id]) return;
    const previous = this.watchStatuses.get(id);
    const at = this.now();
    this.watchStatuses.set(id, {
      profileId: status.profileId,
      connectionId: status.connectionId,
      queryId: status.queryId,
      status: status.status,
      ...(status.status === "idle"
        ? { lastSuccessAt: at }
        : previous?.lastSuccessAt !== undefined
          ? { lastSuccessAt: previous.lastSuccessAt }
          : {}),
      ...(status.status === "polling" || status.status === "idle"
        ? status.status === "polling" && previous?.lastError
          ? { lastError: previous.lastError }
          : {}
        : { lastError: { code: status.reasonCode ?? status.status, at } }),
      ...(status.retryAt !== undefined ? { retryAt: status.retryAt } : {}),
    });
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("Jira polling service has been disposed.");
  }
}

function validateConfig(config: JiraPollConfig, limits: { minIntervalMs: number; maxIntervalMs: number }): void {
  if (!safeId(config.profileId) || !safeId(config.connectionId) || !safeId(config.queryId))
    throw new Error("Jira polling identifiers are invalid.");
  if (config.enabled !== true) throw new Error("Jira polling is opt-in and must be explicitly enabled.");
  if (typeof config.query !== "string" || !config.query.trim() || config.query.length > 4096)
    throw new Error("Jira polling query is invalid.");
  if (
    !Number.isFinite(config.intervalMs) ||
    config.intervalMs < limits.minIntervalMs ||
    config.intervalMs > limits.maxIntervalMs
  )
    throw new Error("Jira polling interval is outside the configured bounds.");
}

function normalizeIssues(issues: JiraPollIssue[]): Record<string, JiraPollIssue> {
  const members: Record<string, JiraPollIssue> = {};
  for (const issue of issues) {
    if (
      !issue ||
      !safeId(issue.issueId) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(issue.issueKey) ||
      !Number.isFinite(issue.updatedAt)
    )
      throw new Error("Jira poll returned invalid issue metadata.");
    members[memberId(issue.issueId)] = { issueId: issue.issueId, issueKey: issue.issueKey, updatedAt: issue.updatedAt };
  }
  return members;
}

function safeReason(reasonCode: string): string {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(reasonCode) ? reasonCode : "unsupported";
}

export function createJiraPollingState(): JiraPollingState {
  return emptyState();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Accepts only a state this build understands. A malformed or newer-version value yields `undefined` and the
 * caller starts from an empty state: polling state is a cache of what was already notified, never worth failing startup.
 */
export function sanitizeJiraPollingState(value: unknown): JiraPollingState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.watches) || !Array.isArray(value.dedupeIds))
    return undefined;
  const watches: Record<string, Watch> = {};
  for (const [id, raw] of Object.entries(value.watches)) {
    if (!isRecord(raw) || !isRecord(raw.config) || !isRecord(raw.members)) continue;
    const config = raw.config;
    if (
      typeof config.profileId !== "string" ||
      typeof config.connectionId !== "string" ||
      typeof config.queryId !== "string" ||
      !safeId(config.profileId) ||
      !safeId(config.connectionId) ||
      !safeId(config.queryId) ||
      typeof config.query !== "string" ||
      typeof config.intervalMs !== "number" ||
      !Number.isFinite(config.intervalMs) ||
      typeof config.enabled !== "boolean" ||
      (raw.watermark !== null && !(typeof raw.watermark === "number" && Number.isFinite(raw.watermark))) ||
      typeof raw.baselinePending !== "boolean" ||
      typeof raw.nextPollAt !== "number" ||
      Number.isNaN(raw.nextPollAt)
    )
      continue;
    const members: Record<string, JiraPollIssue> = {};
    let membersValid = true;
    for (const [memberKey, member] of Object.entries(raw.members)) {
      if (
        !isRecord(member) ||
        typeof member.issueId !== "string" ||
        typeof member.issueKey !== "string" ||
        typeof member.updatedAt !== "number" ||
        !Number.isFinite(member.updatedAt)
      ) {
        membersValid = false;
        break;
      }
      members[memberKey] = { issueId: member.issueId, issueKey: member.issueKey, updatedAt: member.updatedAt };
    }
    if (!membersValid) continue;
    watches[id] = {
      config: {
        profileId: config.profileId,
        connectionId: config.connectionId,
        queryId: config.queryId,
        query: config.query,
        intervalMs: config.intervalMs,
        enabled: config.enabled,
      },
      members,
      watermark: raw.watermark as number | null,
      baselinePending: raw.baselinePending,
      nextPollAt: raw.nextPollAt as number,
    };
  }
  return {
    version: 1,
    watches,
    dedupeIds: value.dedupeIds.filter((item): item is string => typeof item === "string"),
  };
}

export function createJiraPollingStoreAdapter(
  load: () => Promise<JiraPollingState | undefined>,
  save: (state: JiraPollingState) => Promise<void>,
): JiraPollingStore {
  return { load, save };
}
