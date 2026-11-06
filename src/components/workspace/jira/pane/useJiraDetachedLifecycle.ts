import { onMounted, onUnmounted } from "vue";
import type { JiraPaneContext } from "./jira-pane-context.js";
import type { JiraConnection } from "./jira-pane-types.js";

/**
 * The whole lifecycle of a pop-out window's context: the connection list (capabilities and identity) and the one
 * issue it was opened for. It restores no saved view, runs no search or board load and persists no preference.
 */
export function useJiraDetachedLifecycle(ctx: JiraPaneContext) {
  async function load() {
    const issue = ctx.props.detachedIssue;
    ctx.connectionsLoading.value = true;
    try {
      ctx.connections.value = (await ctx.api.listJiraConnections()) as JiraConnection[];
    } catch (cause) {
      ctx.reportFailure("Could not load the Jira connections", cause);
      return;
    } finally {
      ctx.connectionsLoaded.value = true;
      ctx.connectionsLoading.value = false;
    }
    if (!issue) return;
    const context = `Could not open ${issue.issueKey}`;
    if (!ctx.connections.value.some((connection) => connection.id === issue.connectionId)) {
      ctx.reportFailure(context, new Error("Its Jira connection is unavailable in this profile."));
      return;
    }
    ctx.connectionId.value = issue.connectionId;
    try {
      await ctx.openIssue({ ref: { provider: "jira", ...issue }, key: issue.issueKey });
    } catch (cause) {
      ctx.reportFailure(context, cause);
    }
  }
  onMounted(() => {
    void load();
    window.addEventListener("focus", ctx.updateSyncClock);
    document.addEventListener("visibilitychange", ctx.updateSyncClock);
  });
  onUnmounted(() => {
    ctx.vars.issueOpenGeneration++;
    window.removeEventListener("focus", ctx.updateSyncClock);
    document.removeEventListener("visibilitychange", ctx.updateSyncClock);
  });
  return {};
}
