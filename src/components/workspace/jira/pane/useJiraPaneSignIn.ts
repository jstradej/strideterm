import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { JiraPaneContext } from "./jira-pane-context.js";
import type { JiraConnection } from "./jira-pane-types.js";

const SIGN_IN_CODES = new Set(["auth-expired", "credential-missing"]);
const TICK_MS = 250;

/** Expired sign-in (a card instead of the content) and the rate-limit countdown with one automatic retry. */
export function useJiraPaneSignIn(ctx: JiraPaneContext) {
  const { activeView, connectionId, connections, connectionsOnly, error, errorStatus, jiraViewId, store } = ctx;

  const signInConnection = computed<JiraConnection | null>(() => {
    if (connectionsOnly.value) return null;
    const list = connections.value;
    const bannerNeedsSignIn = Boolean(errorStatus.value && SIGN_IN_CODES.has(errorStatus.value.code));
    if (connectionId.value === "__all__") return list.find((connection) => connection.status === "needs-login") ?? null;
    const current = list.find((connection) => connection.id === connectionId.value);
    if (!current) return null;
    return current.status === "needs-login" || bannerNeedsSignIn ? current : null;
  });
  const signInExpired = computed(
    () => Boolean(signInConnection.value) && activeView.value !== "settings" && !ctx.setupVisible.value,
  );
  const signInBannerDuplicate = computed(
    () => signInExpired.value && Boolean(errorStatus.value && SIGN_IN_CODES.has(errorStatus.value.code)),
  );

  async function signInAgain() {
    const connection = signInConnection.value;
    if (!connection) return;
    await ctx.signInAgainWithCredentials(connection);
  }
  function openJiraSettings() {
    if (jiraViewId.value === "issues") {
      activeView.value = "settings";
      return;
    }
    store.openSettingsDialog?.({ initialTab: "jira" });
  }

  const rateLimitRemainingMs = ref(0);
  const rateLimitAutoRetry = ref(true);
  let timer: ReturnType<typeof setInterval> | undefined;
  let autoRetryUsed = false;
  let retryInFlight = false;
  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }
  async function retryNow() {
    stopTimer();
    rateLimitRemainingMs.value = 0;
    retryInFlight = true;
    error.value = "";
    try {
      await ctx.refreshVisibleJiraData({ userInitiated: true });
    } finally {
      retryInFlight = false;
      if (errorStatus.value?.code !== "rate-limited") autoRetryUsed = false;
    }
  }
  function retryAfterRateLimit() {
    autoRetryUsed = false;
    void retryNow();
  }
  watch(errorStatus, (status) => {
    stopTimer();
    if (status?.code !== "rate-limited" || !status.retryAfterMs) {
      rateLimitRemainingMs.value = 0;
      if (!retryInFlight) autoRetryUsed = false;
      rateLimitAutoRetry.value = !autoRetryUsed;
      return;
    }
    const until = Date.now() + status.retryAfterMs;
    rateLimitRemainingMs.value = status.retryAfterMs;
    rateLimitAutoRetry.value = !autoRetryUsed;
    timer = setInterval(() => {
      rateLimitRemainingMs.value = Math.max(0, until - Date.now());
      if (rateLimitRemainingMs.value > 0) return;
      stopTimer();
      if (autoRetryUsed) return;
      autoRetryUsed = true;
      rateLimitAutoRetry.value = false;
      void retryNow();
    }, TICK_MS);
  });
  onBeforeUnmount(stopTimer);

  return {
    signInConnection,
    signInExpired,
    signInBannerDuplicate,
    signInAgain,
    openJiraSettings,
    rateLimitRemainingMs,
    rateLimitAutoRetry,
    retryAfterRateLimit,
  };
}
