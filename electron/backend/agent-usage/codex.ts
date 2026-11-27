import { createHash } from "node:crypto";
import type { UsageAccountReading, UsageResetCredits, UsageWindow } from "../../shared/agent-usage.js";
import { UsageUnavailable } from "./unavailable.js";
import { runJsonlCli } from "./cli-probe.js";

type RateWindow = { usedPercent?: unknown; resetsAt?: unknown; resetAt?: unknown; windowDurationMins?: unknown };
const MAX_USAGE_WINDOWS = 32;

function safeLabel(value: unknown, fallback: string): string {
  const normalized =
    typeof value === "string"
      ? value
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  return normalized.slice(0, 96) || fallback;
}

function toWindow(label: string, value: unknown): UsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const item = value as RateWindow;
  if (
    typeof item.usedPercent !== "number" ||
    !Number.isFinite(item.usedPercent) ||
    item.usedPercent < 0 ||
    item.usedPercent > 100
  )
    return null;
  const reset = item.resetsAt ?? item.resetAt;
  let resetsAt: number | undefined;
  if (typeof reset === "number" && Number.isFinite(reset)) resetsAt = reset < 100_000_000_000 ? reset * 1000 : reset;
  else if (typeof reset === "string") {
    const parsed = Date.parse(reset);
    if (Number.isFinite(parsed)) resetsAt = parsed;
  }
  if (resetsAt !== undefined && (!Number.isFinite(resetsAt) || Math.abs(resetsAt) > 8.64e15)) resetsAt = undefined;
  const durationMinutes =
    typeof item.windowDurationMins === "number" &&
    Number.isSafeInteger(item.windowDurationMins) &&
    item.windowDurationMins > 0
      ? item.windowDurationMins
      : undefined;
  return {
    label,
    usedPercent: item.usedPercent,
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function windowLabel(duration: unknown, fallback: string): string {
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0) return fallback;
  if (duration === 10080) return "Weekly";
  if (duration === 1440) return "Daily";
  if (duration % 60 === 0) return `${duration / 60}-hour`;
  return `${duration}-minute`;
}

// https://developers.openai.com/codex/app-server#rate-limits-chatgpt
export function parseCodexUsageWindows(payload: unknown): UsageWindow[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const result: UsageWindow[] = [];
  const pools = new Map<string, unknown>();
  if (root.rateLimits && typeof root.rateLimits === "object") {
    const defaultPool = root.rateLimits as Record<string, unknown>;
    const poolId = typeof defaultPool.limitId === "string" && defaultPool.limitId ? defaultPool.limitId : "codex";
    pools.set(poolId, defaultPool);
  }
  if (root.rateLimitsByLimitId && typeof root.rateLimitsByLimitId === "object") {
    for (const [poolId, pool] of Object.entries(root.rateLimitsByLimitId as Record<string, unknown>)) {
      if (pools.size >= MAX_USAGE_WINDOWS && !pools.has(poolId)) break;
      pools.set(poolId, pool);
    }
  }
  if (!pools.size) pools.set("codex", root);
  for (const [poolId, rawPool] of pools) {
    if (result.length >= MAX_USAGE_WINDOWS) break;
    if (!rawPool || typeof rawPool !== "object") continue;
    const pool = rawPool as Record<string, unknown>;
    const displayPool = safeLabel(pool.limitName, safeLabel(poolId, "Codex"));
    for (const [fallback, rawWindow] of [
      ["Primary", pool.primary],
      ["Secondary", pool.secondary],
    ] as const) {
      if (!rawWindow || typeof rawWindow !== "object") continue;
      const label = windowLabel((rawWindow as RateWindow).windowDurationMins, fallback);
      const suffix = poolId === "codex" ? "" : ` (${displayPool})`;
      const mapped = toWindow(`${label}${suffix}`, rawWindow);
      if (!mapped) continue;
      result.push(poolId === "codex" ? mapped : { ...mapped, scope: displayPool });
      if (result.length >= MAX_USAGE_WINDOWS) break;
    }
  }
  return result;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 100_000_000_000 ? value * 1000 : value;
  return ms <= 8.64e15 ? ms : undefined;
}

export function parseCodexResetCredits(payload: unknown, now = Date.now()): UsageResetCredits | undefined {
  const root = object(object(payload)?.rateLimitResetCredits);
  if (!root) return undefined;
  if (Array.isArray(root.credits)) {
    const live = root.credits.slice(0, MAX_USAGE_WINDOWS).flatMap((raw) => {
      const credit = object(raw);
      if (credit?.status !== "available") return [];
      const expiresAt = epochMs(credit.expiresAt);
      if (expiresAt !== undefined && expiresAt <= now) return [];
      return [expiresAt];
    });
    const expiresAt = live.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
    return live.length ? { available: live.length, expiresAt } : undefined;
  }
  const count = root.availableCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0
    ? { available: Math.min(count, MAX_USAGE_WINDOWS), expiresAt: [] }
    : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function accountIdentity(payload: unknown, env: NodeJS.ProcessEnv): UsageAccountReading["account"] {
  const root = object(payload);
  const account = object(root?.account);
  const workspaceRouting = object(root?.workspaceRouting);
  const userId = typeof root?.userId === "string" && root.userId.trim() ? root.userId.trim() : undefined;
  const email = typeof account?.email === "string" ? account.email.trim() : undefined;
  if (!account || (!email && !userId)) return undefined;
  const workspaceId =
    (typeof workspaceRouting?.chatgptAccountId === "string" && workspaceRouting.chatgptAccountId.trim()) ||
    (typeof account?.workspaceId === "string" && account.workspaceId.trim()) ||
    undefined;
  const type = typeof account?.type === "string" ? account.type : undefined;
  const plan = typeof account?.planType === "string" ? account.planType : undefined;
  const label = safeLabel(email, `Codex ${safeLabel(plan || type, "account")} account`);
  const source = env.CODEX_HOME || "default";
  const identity = userId || email?.toLowerCase();
  // Workspace identity distinguishes separate workspace accounts. When it is
  // unavailable, include the selected Codex home so same-email profiles remain distinct.
  const keyParts = [identity, workspaceId || `home:${source}`];
  const key = `codex:${createHash("sha256").update(keyParts.join("\0")).digest("hex")}`;
  return { label, key };
}

/** Reads the active Codex account and its plan quota without starting a model turn. */
export async function readCodexAccountUsage(env: NodeJS.ProcessEnv = process.env): Promise<UsageAccountReading> {
  try {
    let identity: UsageAccountReading["account"];
    let accountRead = false;
    let windows: UsageWindow[] | undefined;
    let resetCredits: UsageResetCredits | undefined;
    const done = (found: UsageWindow[]): UsageAccountReading => ({
      ...(identity ? { account: identity } : {}),
      windows: found,
      ...(resetCredits ? { resetCredits } : {}),
    });
    const result = await runJsonlCli<UsageAccountReading>(
      "codex",
      ["app-server"],
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "strideterm", title: "Strideterm", version: "1.0.0" }, capabilities: {} },
      },
      (message, send) => {
        if (!message || typeof message !== "object") return undefined;
        const msg = message as Record<string, unknown>;
        if (msg.id === 1 && msg.error) {
          throw new UsageUnavailable("Codex could not initialize its usage reader. Update Codex and try again.");
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/read", params: { refreshToken: false } });
          send({ jsonrpc: "2.0", id: 3, method: "account/rateLimits/read", params: {} });
          return undefined;
        }
        if (msg.id === 2) {
          // Identity is optional: quota can still be displayed when this older
          // server does not implement account/read.
          if (!msg.error) identity = accountIdentity(msg.result, env);
          accountRead = true;
          if (windows) return done(windows);
          return undefined;
        }
        if (msg.id === 3) {
          if (msg.error)
            throw new UsageUnavailable("Codex could not read plan limits. Check your ChatGPT login in Codex.");
          windows = parseCodexUsageWindows(msg.result);
          if (!windows.length) throw new UsageUnavailable("This Codex login did not return any plan limits.");
          resetCredits = parseCodexResetCredits(msg.result);
          if (accountRead) return done(windows);
          return undefined;
        }
        return undefined;
      },
      { env },
    );
    return result;
  } catch (error) {
    if (error instanceof UsageUnavailable) throw error;
    const reason = error instanceof Error ? error.message : "";
    if (reason.includes("not found")) {
      throw new UsageUnavailable("Codex CLI was not found. Install Codex or add it to PATH, then refresh usage.");
    }
    if (reason.includes("timed out")) {
      throw new UsageUnavailable(
        "Codex usage request timed out. Confirm Codex is installed and signed in, then refresh.",
      );
    }
    throw new UsageUnavailable("Codex could not read usage. Confirm Codex is installed and signed in, then refresh.");
  }
}

/** Compatibility API used by callers that only need quota windows. */
export async function readCodexUsage(): Promise<UsageWindow[]> {
  return (await readCodexAccountUsage()).windows;
}
