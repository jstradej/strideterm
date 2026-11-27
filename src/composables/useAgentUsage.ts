import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import { apiKey } from "../types/keys.js";
import { useAppStore } from "../stores/app.js";
import type { AgentUsage } from "../../electron/shared/agent-usage.js";

const REFRESH_MS = 5 * 60_000;
const entries = ref<AgentUsage[]>([]);
const loading = ref(false);
const error = ref("");
const accountCheckedAt = computed(() =>
  entries.value.reduce<number | null>((latest, entry) => {
    if (entry.provider === "gemini") return latest;
    return latest === null || entry.checkedAt > latest ? entry.checkedAt : latest;
  }, null),
);

let interval: ReturnType<typeof setInterval> | undefined;
let resetTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | undefined;
let generation = 0;
let currentSession: string | undefined;
type RefreshUsage = (_force?: boolean) => Promise<void>;
let activeRefresh: RefreshUsage | undefined;
const refreshers = new Set<RefreshUsage>();

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void activeRefresh?.(false);
}

function clearTimers(): void {
  if (interval) clearInterval(interval);
  if (resetTimer) clearTimeout(resetTimer);
  interval = undefined;
  resetTimer = undefined;
}

function currentWindows(snapshot: AgentUsage[]): AgentUsage[] {
  const now = Date.now();
  const current = (windows: AgentUsage["windows"]) =>
    windows.filter((window) => window.resetsAt === undefined || window.resetsAt > now);
  return snapshot.map((entry) => ({
    ...entry,
    windows: current(entry.windows),
    ...(entry.otherAccounts
      ? {
          otherAccounts: entry.otherAccounts.map((account) =>
            account.status === "separate-login" && account.windows
              ? { ...account, windows: current(account.windows) }
              : account,
          ),
        }
      : {}),
  }));
}

function scheduleReset(snapshot: AgentUsage[]): void {
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = undefined;
  const liveWindows = snapshot.flatMap((entry) => [
    ...entry.windows,
    ...(entry.otherAccounts ?? []).flatMap((account) =>
      account.status === "separate-login" ? (account.windows ?? []) : [],
    ),
  ]);
  const untilReset = Math.min(...liveWindows.map((window) => window.resetsAt ?? Infinity)) - Date.now();
  if (Number.isFinite(untilReset) && untilReset > 0 && untilReset < REFRESH_MS) {
    resetTimer = setTimeout(() => void activeRefresh?.(false), untilReset + 1);
  }
}

export function useAgentUsage() {
  const appStore = useAppStore();
  const transport = inject(apiKey, null);
  const sessionId = () => appStore.activeSessionId || undefined;

  const refresh = async (force = true): Promise<void> => {
    if (refreshers.size === 0 || document.visibilityState === "hidden") return;
    const requestedSession = sessionId();
    if (inFlight && requestedSession === currentSession) return inFlight;
    const requestGeneration = ++generation;
    currentSession = requestedSession;
    entries.value = currentWindows(entries.value);
    const api = transport ?? appStore.getApi();
    const readUsage = api?.readAgentUsage;
    if (typeof readUsage !== "function") {
      entries.value = [];
      error.value = "Provider usage is unavailable in this client.";
      return;
    }
    const readUsageBound = readUsage.bind(api);
    loading.value = true;
    error.value = "";
    const request = (async () => {
      try {
        const result = force ? await readUsageBound(requestedSession, true) : await readUsageBound(requestedSession);
        if (requestGeneration !== generation) return;
        entries.value = currentWindows(result);
        scheduleReset(entries.value);
      } catch (cause) {
        if (requestGeneration !== generation) return;
        entries.value = [];
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = undefined;
        error.value =
          cause instanceof Error ? `Could not read provider usage: ${cause.message}` : "Could not read provider usage.";
      }
    })();
    inFlight = request;
    try {
      await request;
    } finally {
      if (requestGeneration === generation) {
        loading.value = false;
        inFlight = undefined;
      }
    }
  };
  const stopSessionWatch = watch(
    () => appStore.activeSessionId,
    (next) => {
      const selectedSession = next || undefined;
      if (selectedSession === currentSession) return;
      generation++;
      inFlight = undefined;
      loading.value = false;
      entries.value = entries.value.filter((entry) => entry.provider !== "gemini");
      error.value = "";
      currentSession = selectedSession;
      if (refreshers.size && document.visibilityState !== "hidden") void refresh(false);
    },
    { flush: "sync" },
  );
  onMounted(() => {
    refreshers.add(refresh);
    activeRefresh = refresh;
    if (refreshers.size === 1) {
      currentSession = sessionId();
      interval = setInterval(() => void activeRefresh?.(false), REFRESH_MS);
      document.addEventListener("visibilitychange", onVisibilityChange);
      void refresh(false);
    }
  });
  onUnmounted(() => {
    stopSessionWatch();
    refreshers.delete(refresh);
    activeRefresh = Array.from(refreshers).at(-1);
    if (refreshers.size === 0) {
      generation++;
      inFlight = undefined;
      loading.value = false;
      entries.value = [];
      error.value = "";
      clearTimers();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  });

  async function refreshAfterAccountChange(): Promise<void> {
    // The request started before the picker completed can contain the old list of accounts.
    if (inFlight) await inFlight;
    await refresh();
  }
  return { entries, loading, error, accountCheckedAt, refresh, refreshAfterAccountChange };
}
