import type { AgentUsage, UsageAccountSnapshot, UsageResetCredits, UsageWindow } from "../../shared/agent-usage.js";

function displayText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/[\r\n\t\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return text || undefined;
}

function projectWindows(windows: unknown): UsageWindow[] {
  if (!Array.isArray(windows)) return [];
  return windows.slice(0, 16).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const source = value as Record<string, unknown>;
    if (typeof source.usedPercent !== "number" || !Number.isFinite(source.usedPercent)) return [];
    const label = displayText(source.label, 48);
    if (!label) return [];
    const scope = displayText(source.scope, 48);
    return [
      {
        label,
        usedPercent: Math.max(0, Math.min(100, source.usedPercent)),
        ...(source.rounded === true ? { rounded: true } : {}),
        ...(typeof source.durationMinutes === "number" &&
        Number.isSafeInteger(source.durationMinutes) &&
        source.durationMinutes > 0
          ? { durationMinutes: source.durationMinutes }
          : {}),
        ...(scope ? { scope } : {}),
        ...(typeof source.resetsAt === "number" && Number.isFinite(source.resetsAt)
          ? { resetsAt: source.resetsAt }
          : {}),
      },
    ];
  });
}

function projectResetCredits(value: unknown): { resetCredits?: UsageResetCredits } {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  if (typeof source.available !== "number" || !Number.isSafeInteger(source.available) || source.available <= 0)
    return {};
  const available = Math.min(source.available, 32);
  const expiresAt = (Array.isArray(source.expiresAt) ? source.expiresAt : [])
    .filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    .slice(0, available);
  return { resetCredits: { available, expiresAt } };
}

function projectOtherAccounts(
  provider: AgentUsage["provider"],
  snapshots: UsageAccountSnapshot[],
): UsageAccountSnapshot[] {
  return snapshots.flatMap((snapshot, index) => {
    if (snapshot.identityUnknown || snapshot.sameAsDefault || snapshot.status === "candidate") return [];
    if (provider !== "gemini" && snapshot.status === "listed") return [];
    if (provider === "gemini" && snapshot.status !== "listed") return [];
    const label = displayText(snapshot.label);
    if (!label) return [];
    return [
      {
        id: `${provider}-other-${index}`,
        label,
        status: snapshot.status,
        ...(typeof snapshot.checkedAt === "number" && Number.isFinite(snapshot.checkedAt)
          ? { checkedAt: snapshot.checkedAt }
          : {}),
        ...(Array.isArray(snapshot.windows) ? { windows: projectWindows(snapshot.windows) } : {}),
        ...(snapshot.unavailable
          ? {
              unavailable:
                provider === "gemini"
                  ? "Open /model or /stats model in Gemini CLI to check quota for this account."
                  : "Usage is unavailable for this account.",
            }
          : {}),
      },
    ];
  });
}

/** Removes desktop profile metadata and substitutes only phone-local opaque account keys. */
export function projectMobileAgentUsage(rows: AgentUsage[]): AgentUsage[] {
  return rows.slice(0, 3).map((row) => {
    const accountLabel = displayText(row.account?.label);
    const otherAccounts = projectOtherAccounts(row.provider, row.otherAccounts ?? []);
    return {
      provider: row.provider,
      checkedAt: Number.isFinite(row.checkedAt) ? row.checkedAt : Date.now(),
      windows: projectWindows(row.windows),
      ...(accountLabel ? { account: { label: accountLabel, key: `mobile-${row.provider}-active` } } : {}),
      ...projectResetCredits(row.resetCredits),
      ...(row.unavailable
        ? {
            unavailable:
              row.provider === "gemini"
                ? "Open /model or /stats model in Gemini CLI to check quota for this account."
                : "Usage is unavailable for this account.",
          }
        : {}),
      ...(otherAccounts.length ? { otherAccounts } : {}),
    };
  });
}
