import { useNotificationStore } from "../stores/notifications.js";

/**
 * Wraps a native file/directory picker call (`api.browseDirectory` /
 * `api.browseFile`) in a try/catch. These IPC calls almost never reject, but
 * a rare IPC-layer failure would otherwise be an unhandled rejection with no
 * user-visible feedback. On success, returns whatever the picker resolved to
 * — a path, or `null` when the user cancelled. On rejection, surfaces an
 * error toast via the notification store and returns `null`.
 */
export async function pickPath(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    const result = await fn();
    return (result as string | null | undefined) ?? null;
  } catch (err) {
    useNotificationStore().showError("Failed to open picker", (err as Error)?.message || "Action failed");
    return null;
  }
}
