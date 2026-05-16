import { watch } from "vue";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { fireNotificationAlert } from "./useNotificationSound.js";
import { resolveEventProfileId } from "./useNotificationProfileScope.js";

/**
 * Watches Azure DevOps and GitHub PR check states for transitions from
 * "pending" to a terminal state (succeeded/failed) and raises a notification
 * center entry + toast for each completed check.
 *
 * Deduplication key is provider:prKey:checkId so each check only notifies once.
 * Startup grace period (5s) seeds seen states without firing toasts.
 */

const STARTUP_GRACE_MS = 5_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractChecks(prs: Record<string, any>): Array<{
  prKey: string;
  prTitle: string;
  workspaceId: string;
  connectionId: string;
  reviewWorkspaceId: string;
  existingWorkspaceId: string;
  checkId: string;
  checkName: string;
  state: string;
}> {
  const results = [];
  for (const [prKey, summary] of Object.entries(prs || {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pr = summary as any;
    const prTitle: string = pr?.pullRequest?.title || prKey;
    const workspaceId: string = pr?.reviewWorkspaceId || pr?.existingWorkspaceId || "";
    for (const check of pr?.checks?.items || []) {
      if (!check?.id) continue;
      results.push({
        prKey,
        prTitle,
        workspaceId,
        connectionId: String(pr?.connectionId || ""),
        reviewWorkspaceId: String(pr?.reviewWorkspaceId || ""),
        existingWorkspaceId: String(pr?.existingWorkspaceId || ""),
        checkId: String(check.id),
        checkName: String(check.name || check.displayName || "Check"),
        state: String(check.state || ""),
      });
    }
  }
  return results;
}

export function usePipelineNotifications() {
  const appStore = useAppStore();
  const notifStore = useNotificationStore();

  // provider:prKey:checkId → last known state
  const seenStates = new Map<string, string>();
  const startupAt = Date.now();

  function seedProvider(prs: Record<string, unknown>, prefix: string) {
    for (const check of extractChecks(prs as Record<string, unknown>)) {
      seenStates.set(`${prefix}:${check.prKey}:${check.checkId}`, check.state);
    }
  }

  // Seed initial states so we don't fire for checks already in terminal state at startup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seedProvider((appStore.payload?.azureDevops as any)?.pullRequests || {}, "azure");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seedProvider((appStore.payload?.github as any)?.pullRequests || {}, "github");

  function processChecks(prs: Record<string, unknown>, prefix: string) {
    const inStartupGrace = Date.now() - startupAt < STARTUP_GRACE_MS;
    const provider = prefix === "azure" ? "azure-devops" : "github";
    const activeProfileId = appStore.activeProfile?.id || "default";

    for (const check of extractChecks(prs)) {
      const key = `${prefix}:${check.prKey}:${check.checkId}`;
      const prev = seenStates.get(key);
      seenStates.set(key, check.state);

      if (inStartupGrace) continue;
      if (prev === undefined) continue; // first time — don't notify
      const wasRunning = prev === "pending" || prev === "";
      const isTerminal = check.state === "succeeded" || check.state === "failed";
      if (!wasRunning || !isTerminal) continue;

      // Skip checks whose PR belongs to a different profile. Pipeline state
      // is broadcast to every window via the shared payload, but the toast
      // / sound / dock entry must stay scoped to the active profile so a
      // window viewing profile B doesn't ping for profile A's pipelines.
      const eventProfileId = resolveEventProfileId(
        {
          reviewWorkspaceId: check.reviewWorkspaceId,
          existingWorkspaceId: check.existingWorkspaceId,
          connectionId: check.connectionId,
        },
        provider,
        appStore.payload,
      );
      if (eventProfileId && eventProfileId !== activeProfileId) continue;

      const icon = check.state === "succeeded" ? "✅" : "❌";
      const title = `${icon} ${check.checkName} — ${check.prTitle}`;
      const body = check.state === "succeeded" ? "Pipeline passed" : "Pipeline failed";

      notifStore.add({
        title,
        body,
        kind: "review",
        tier: 2,
        urgency: check.state === "failed" ? "urgent" : "normal",
        workspaceId: check.workspaceId,
        workspaceName: check.prTitle,
        tabName: "Pipelines",
        viewId: `pipeline:${check.prKey}:${check.checkId}`,
        category: "review",
        meta: {
          provider,
          prKey: check.prKey,
          kind: "pipeline",
          checkId: check.checkId,
          checkName: check.checkName,
          checkState: check.state,
          profileId: eventProfileId || activeProfileId,
        },
      });

      fireNotificationAlert(title, body, {
        tier: 2,
        urgency: check.state === "failed" ? "urgent" : "normal",
        sessionKey: `pipeline:${check.prKey}:${check.checkId}`,
      });
    }
  }

  watch(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (appStore.payload?.azureDevops as any)?.pullRequests,
    (prs) => processChecks((prs as Record<string, unknown>) || {}, "azure"),
    { deep: false },
  );

  watch(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (appStore.payload?.github as any)?.pullRequests,
    (prs) => processChecks((prs as Record<string, unknown>) || {}, "github"),
    { deep: false },
  );
}
