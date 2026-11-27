import type { AgentUsage, UsageWindow } from "../../shared/agent-usage.js";

const OBSERVATION_TTL_MS = 10 * 60_000;

type Observation =
  | { kind: "quota"; checkedAt: number; windows: UsageWindow[] }
  | { kind: "rate-limit"; checkedAt: number; resetsAt?: number };

// Gemini CLI ModelQuotaDisplay renders used percent rounded to a whole number.
// https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/components/ModelQuotaDisplay.tsx
const MODEL_ROW = /^(Pro|Flash Lite|Flash)\s+▬+\s+(\d{1,3})%\s+Resets:\s+\d{1,2}:\d{2}\s+[AP]M\s+\(([\dhm ]{2,12})\)$/u;

function parseModelQuotaRows(text: string, now: number): UsageWindow[] {
  const rows = new Map<string, UsageWindow>();
  for (const line of text.split(/[\r\n]+/u)) {
    const match = MODEL_ROW.exec(line.trim());
    if (!match) continue;
    const [, label, percent, duration] = match;
    const hours = /^(\d{1,3})h\b/u.exec(duration);
    const minutes = /\b(\d{1,2})m$/u.exec(duration);
    const resetMinutes = Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0);
    if (Number(percent) > 100 || !resetMinutes) continue;
    rows.set(label, {
      label,
      scope: label,
      usedPercent: Number(percent),
      rounded: true,
      resetsAt: now + resetMinutes * 60_000,
    });
  }
  return [...rows.values()];
}

export function createGeminiUsageObserver() {
  // Session ids can be reused when a tab restarts. Its runtime drops this entry on spawn and removal.
  const observations = new Map<string, Observation>();
  /** Observe an already-rendered quota row from a verified local Gemini panel. */
  function observeGeminiTerminalOutput(sessionId: string, text: string, checkedAt = Date.now()): void {
    if (!sessionId || !text) return;
    const windows = parseModelQuotaRows(text, checkedAt);
    if (windows.length) observations.set(sessionId, { kind: "quota", checkedAt, windows });
  }

  /** Record only a rate-limit signal after the runtime's confirmation path. */
  function observeGeminiRateLimit(sessionId: string, checkedAt = Date.now(), resetsAt?: number): void {
    if (!sessionId) return;
    observations.set(sessionId, { kind: "rate-limit", checkedAt, ...(resetsAt === undefined ? {} : { resetsAt }) });
  }

  /** Read a fresh observation from exactly the selected, verified local panel. */
  function readGeminiUsage(sessionId: string | undefined): AgentUsage {
    const now = Date.now();
    const observation = sessionId ? observations.get(sessionId) : undefined;
    if (observation && now - observation.checkedAt <= OBSERVATION_TTL_MS) {
      if (observation.kind === "quota") {
        const windows = observation.windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now);
        if (windows.length) return { provider: "gemini", checkedAt: observation.checkedAt, windows };
      } else {
        const reset = observation.resetsAt;
        if (reset === undefined || reset > now) {
          return {
            provider: "gemini",
            checkedAt: observation.checkedAt,
            windows: [],
            unavailable: `Gemini CLI reported a rate limit at ${new Date(observation.checkedAt).toISOString()} in the active local session. Open /model or /stats model in Gemini CLI to check quota.`,
          };
        }
      }
    }
    return {
      provider: "gemini",
      checkedAt: now,
      windows: [],
      unavailable: "Open /model or /stats model in Gemini CLI to check the quota for this account.",
    };
  }

  function clearGeminiUsageObservation(sessionId: string): void {
    observations.delete(sessionId);
  }

  return { readGeminiUsage, observeGeminiTerminalOutput, observeGeminiRateLimit, clearGeminiUsageObservation };
}
