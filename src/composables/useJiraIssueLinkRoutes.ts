import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from "vue";
import type { Transport } from "../transport.js";

const ROUTES_CHANGED_EVENT = "strideterm:jira-link-routes-changed";

export function notifyJiraIssueLinkRoutesChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ROUTES_CHANGED_EVENT));
}

export interface JiraIssueLinkRoute {
  connectionId: string;
  label: string;
  webUrl: string;
  issueKeyPrefixes: string[];
}

function safeWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function normalizeJiraIssueLinkRoutes(value: unknown, profileId: string): JiraIssueLinkRoute[] {
  if (!Array.isArray(value) || !profileId) return [];
  return value.flatMap((item): JiraIssueLinkRoute[] => {
    if (!item || typeof item !== "object") return [];
    const connection = item as Record<string, unknown>;
    const webUrl = safeWebUrl(connection.webUrl);
    if (
      connection.profileId !== profileId ||
      connection.enabled !== true ||
      typeof connection.id !== "string" ||
      typeof connection.label !== "string" ||
      !webUrl ||
      (connection.issueKeyPrefixes !== undefined && !Array.isArray(connection.issueKeyPrefixes))
    )
      return [];
    const issueKeyPrefixes = [
      ...new Set(
        (Array.isArray(connection.issueKeyPrefixes) ? connection.issueKeyPrefixes : []).filter(
          (prefix): prefix is string => typeof prefix === "string" && /^[A-Z][A-Z0-9_]{0,19}$/.test(prefix),
        ),
      ),
    ];
    return [{ connectionId: connection.id, label: connection.label, webUrl, issueKeyPrefixes }];
  });
}

export function useJiraIssueLinkRoutes(
  api: Pick<Transport, "listJiraConnections">,
  profileId: Ref<string>,
): { routes: ComputedRef<JiraIssueLinkRoute[]>; refresh: () => Promise<void> } {
  const connections = ref<unknown[]>([]);
  let requestId = 0;
  async function refresh() {
    const currentRequest = ++requestId;
    const requestedProfile = profileId.value;
    if (!profileId.value || !api.listJiraConnections) {
      connections.value = [];
      return;
    }
    try {
      const result = await api.listJiraConnections();
      if (currentRequest === requestId && profileId.value === requestedProfile)
        connections.value = Array.isArray(result) ? result : [];
    } catch (error) {
      if (currentRequest === requestId && profileId.value === requestedProfile) connections.value = [];
      throw error;
    }
  }
  watch(
    profileId,
    () => {
      connections.value = [];
      void refresh().catch(() => undefined);
    },
    { immediate: true, flush: "sync" },
  );
  const onRoutesChanged = () => {
    connections.value = [];
    void refresh().catch(() => undefined);
  };
  if (typeof window !== "undefined") window.addEventListener(ROUTES_CHANGED_EVENT, onRoutesChanged);
  onScopeDispose(() => {
    if (typeof window !== "undefined") window.removeEventListener(ROUTES_CHANGED_EVENT, onRoutesChanged);
    requestId++;
  });
  const routes = computed(() => normalizeJiraIssueLinkRoutes(connections.value, profileId.value));
  return { routes, refresh };
}
