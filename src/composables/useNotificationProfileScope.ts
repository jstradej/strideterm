import { computed } from "vue";
import { useAppStore } from "../stores/app.js";

/**
 * Profile-scoping helpers for the notification center.
 *
 * The notification store is process-shared (loaded from localStorage in every
 * BrowserWindow) and the backend payload carries review/pipeline activity for
 * every connection regardless of profile. Without scoping, a window viewing
 * profile B would surface toasts, sound and dock badges for profile A.
 *
 * Sessions are stamped with `meta.profileId` at creation time (see
 * useReviewNotifications / usePipelineNotifications). At read time we prefer
 * the stamped profileId, fall back to the workspace's own profileId, and
 * finally accept sessions whose owner can't be resolved at all (legacy /
 * deleted-workspace history) so we don't silently drop user-visible state.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

/**
 * Resolve which profile owns a notification session. Returns `""` when the
 * profile can't be determined (legacy session pre-dating profile-stamping).
 */
export function resolveSessionProfileId(
  session: { workspaceId?: string; meta?: AnyApi | null },
  profileByWs: Map<string, string>,
): string {
  const stamped = session.meta?.profileId;
  if (stamped) return String(stamped);
  const owning = profileByWs.get(session.workspaceId || "");
  if (owning) return owning;
  return "";
}

/**
 * Resolve which profile owns a review/pipeline event before it lands in the
 * store. Prefers the event's review/existing workspace, then falls back to
 * the originating connection's profile. Returns `""` if nothing matches.
 */
export function resolveEventProfileId(ev: AnyApi, provider: string, payload: AnyApi): string {
  const wsId = ev?.reviewWorkspaceId || ev?.existingWorkspaceId || "";
  if (wsId) {
    const workspaces = (payload?.appState?.workspaces || []) as AnyApi[];
    const ws = workspaces.find((w: AnyApi) => w.id === wsId);
    if (ws) return ws.profileId || "default";
  }
  const connectionId = ev?.connectionId || "";
  if (connectionId) {
    const settings = payload?.appState?.settings as AnyApi;
    const conns: AnyApi[] =
      provider === "github"
        ? settings?.integrations?.github?.connections || []
        : settings?.integrations?.azureDevops?.connections || [];
    const conn = conns.find((c: AnyApi) => c.id === connectionId);
    if (conn) return conn.profileId || "default";
  }
  return "";
}

/**
 * Composable returning a reactive predicate that tells whether a notification
 * session belongs to this window's active profile. Used by the bell badge,
 * the dock filter and the Ack/Clear actions to keep them profile-scoped.
 */
export function useNotificationProfileScope() {
  const appStore = useAppStore();

  const activeProfileId = computed(() => appStore.activeProfile?.id || "default");

  const profileByWs = computed(() => {
    const workspaces = (appStore.payload?.appState?.workspaces || []) as AnyApi[];
    const map = new Map<string, string>();
    for (const ws of workspaces) map.set(ws.id, ws.profileId || "default");
    return map;
  });

  function sessionInActiveProfile(session: { workspaceId?: string; meta?: AnyApi | null }): boolean {
    const owning = resolveSessionProfileId(session, profileByWs.value);
    if (!owning) return true; // unknown owner — keep (legacy/deleted history)
    return owning === activeProfileId.value;
  }

  return {
    activeProfileId,
    profileByWs,
    sessionInActiveProfile,
  };
}
