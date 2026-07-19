import { defineStore } from "pinia";
import { ref, watchEffect } from "vue";
import { useAppStore } from "./app.js";

export type TabKind =
  "container" | "project" | "image" | "volume" | "network" | "images-list" | "volumes-list" | "networks-list";

export type SubTabKind = "logs" | "stats" | "shell" | "inspect" | "env" | "top";

export interface OpenTab {
  tabId: string;
  kind: TabKind;
  label: string;
  backendId: string;
  contextName: string;
  containerId?: string;
  projectName?: string;
  imageId?: string;
  volumeName?: string;
  networkId?: string;
  removed?: boolean;
  logSessionId?: string;
  shellSessionId?: string;
  activeSubTab?: SubTabKind;
}

function makeTabId(kind: TabKind, backendId: string, contextName: string, id: string): string {
  switch (kind) {
    case "container":
      return `container:${backendId}:${contextName}:${id}`;
    case "project":
      return `compose:${backendId}:${contextName}:${id}`;
    case "image":
      return `image:${backendId}:${contextName}:${id}`;
    case "volume":
      return `volume:${backendId}:${contextName}:${id}`;
    case "network":
      return `network:${backendId}:${contextName}:${id}`;
    case "images-list":
      return `images-list:${backendId}:${contextName}`;
    case "volumes-list":
      return `volumes-list:${backendId}:${contextName}`;
    case "networks-list":
      return `networks-list:${backendId}:${contextName}`;
  }
}

export const useDockerDetail = defineStore("docker-detail", () => {
  // VIEWER-LOCAL by design: this Pinia store lives in each renderer process,
  // so two windows showing the same Docker workspace keep independent open
  // tabs / active tab / sub-tab selection. The Docker daemon, containers and
  // log/shell sessions stay global runtime state in the backend — viewers
  // only subscribe to them.
  const appStore = useAppStore();

  // Tabs per workspace: Map<workspaceId, OpenTab[]>
  const tabsByWorkspace = ref<Map<string, OpenTab[]>>(new Map());
  // Active tab per workspace
  const activeByWorkspace = ref<Map<string, string>>(new Map());

  function getTabs(workspaceId: string): OpenTab[] {
    return tabsByWorkspace.value.get(workspaceId) || [];
  }

  function getActiveTabId(workspaceId: string): string | null {
    return activeByWorkspace.value.get(workspaceId) || null;
  }

  function getActiveTab(workspaceId: string): OpenTab | null {
    const activeId = getActiveTabId(workspaceId);
    if (!activeId) return null;
    return getTabs(workspaceId).find((t) => t.tabId === activeId) || null;
  }

  // Shared by every open*() below: add the tab if it isn't already open, then
  // focus it either way — a second click on an already-open node just switches to it.
  function openTab(workspaceId: string, tabId: string, buildTab: () => OpenTab): void {
    const tabs = getTabs(workspaceId);
    if (!tabs.find((t) => t.tabId === tabId)) {
      tabsByWorkspace.value.set(workspaceId, [...tabs, buildTab()]);
    }
    setActive(workspaceId, tabId);
  }

  function openContainer(
    workspaceId: string,
    containerId: string,
    backendId: string,
    contextName: string,
    label: string,
  ): void {
    const tabId = makeTabId("container", backendId, contextName, containerId);
    openTab(workspaceId, tabId, () => ({
      tabId,
      kind: "container",
      label,
      backendId,
      contextName,
      containerId,
      logSessionId: crypto.randomUUID(),
      shellSessionId: crypto.randomUUID(),
      activeSubTab: "logs",
    }));
  }

  function setActiveSubTab(workspaceId: string, tabId: string, subTab: SubTabKind): void {
    const tabs = getTabs(workspaceId);
    const updated = tabs.map((t) => (t.tabId === tabId ? { ...t, activeSubTab: subTab } : t));
    tabsByWorkspace.value.set(workspaceId, updated);
  }

  function openImage(
    workspaceId: string,
    imageId: string,
    backendId: string,
    contextName: string,
    label: string,
  ): void {
    const tabId = makeTabId("image", backendId, contextName, imageId);
    openTab(workspaceId, tabId, () => ({
      tabId,
      kind: "image",
      label,
      backendId,
      contextName,
      imageId,
      activeSubTab: "inspect",
    }));
  }

  function openVolume(workspaceId: string, volumeName: string, backendId: string, contextName: string): void {
    const tabId = makeTabId("volume", backendId, contextName, volumeName);
    openTab(workspaceId, tabId, () => ({
      tabId,
      kind: "volume",
      label: volumeName,
      backendId,
      contextName,
      volumeName,
      activeSubTab: "inspect",
    }));
  }

  function openNetwork(
    workspaceId: string,
    networkId: string,
    backendId: string,
    contextName: string,
    label: string,
  ): void {
    const tabId = makeTabId("network", backendId, contextName, networkId);
    openTab(workspaceId, tabId, () => ({
      tabId,
      kind: "network",
      label,
      backendId,
      contextName,
      networkId,
      activeSubTab: "inspect",
    }));
  }

  /**
   * Group-level list tabs. One per (backend, context, kind) — opening the
   * Images group node for `default` context always returns the same tab,
   * second click just focuses it. The label includes the context name when
   * more than one context is in play; the table itself filters by both
   * backendId + contextName from the tab.
   */
  function openImagesList(workspaceId: string, backendId: string, contextName: string, label: string): void {
    const tabId = makeTabId("images-list", backendId, contextName, "");
    openTab(workspaceId, tabId, () => ({ tabId, kind: "images-list", label, backendId, contextName }));
  }

  function openVolumesList(workspaceId: string, backendId: string, contextName: string, label: string): void {
    const tabId = makeTabId("volumes-list", backendId, contextName, "");
    openTab(workspaceId, tabId, () => ({ tabId, kind: "volumes-list", label, backendId, contextName }));
  }

  function openNetworksList(workspaceId: string, backendId: string, contextName: string, label: string): void {
    const tabId = makeTabId("networks-list", backendId, contextName, "");
    openTab(workspaceId, tabId, () => ({ tabId, kind: "networks-list", label, backendId, contextName }));
  }

  function openComposeProject(workspaceId: string, projectName: string, backendId: string, contextName: string): void {
    const tabId = makeTabId("project", backendId, contextName, projectName);
    openTab(workspaceId, tabId, () => ({
      tabId,
      kind: "project",
      label: projectName,
      backendId,
      contextName,
      projectName,
    }));
  }

  function closeTab(workspaceId: string, tabId: string): void {
    const tabs = getTabs(workspaceId).filter((t) => t.tabId !== tabId);
    tabsByWorkspace.value.set(workspaceId, tabs);
    // If we just closed the active tab, activate the last tab
    if (activeByWorkspace.value.get(workspaceId) === tabId) {
      const last = tabs[tabs.length - 1];
      if (last) {
        activeByWorkspace.value.set(workspaceId, last.tabId);
      } else {
        activeByWorkspace.value.delete(workspaceId);
      }
    }
  }

  // Closing a tab also has to tear down its backing log/shell sessions —
  // the store owns the session ids, so it owns the teardown too.
  function closeTabAndSessions(workspaceId: string, tabId: string): void {
    const tab = getTabs(workspaceId).find((t) => t.tabId === tabId);
    if (tab?.logSessionId) {
      appStore.dockerLogsClose(tab.logSessionId).catch(() => {});
    }
    if (tab?.shellSessionId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = appStore.getApi() as any;
      api?.dockerShellClose?.({ sessionId: tab.shellSessionId }).catch(() => {});
    }
    closeTab(workspaceId, tabId);
  }

  function setActive(workspaceId: string, tabId: string): void {
    activeByWorkspace.value.set(workspaceId, tabId);
  }

  function markRemoved(workspaceId: string, containerId: string): void {
    const tabs = getTabs(workspaceId);
    const updated = tabs.map((t) => (t.containerId === containerId ? { ...t, removed: true } : t));
    tabsByWorkspace.value.set(workspaceId, updated);
  }

  // Watch for removed containers to mark tabs as removed
  watchEffect(() => {
    const docker = appStore.dockerState();
    if (!docker?.containers) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liveIds = new Set<string>(docker.containers.map((c: any) => String(c.ID)));
    for (const [wsId, tabs] of tabsByWorkspace.value.entries()) {
      for (const tab of tabs) {
        if (tab.kind === "container" && tab.containerId && !liveIds.has(tab.containerId) && !tab.removed) {
          markRemoved(wsId, tab.containerId);
        }
      }
    }
  });

  return {
    getTabs,
    getActiveTabId,
    getActiveTab,
    openContainer,
    openComposeProject,
    openImage,
    openVolume,
    openNetwork,
    openImagesList,
    openVolumesList,
    openNetworksList,
    closeTab,
    closeTabAndSessions,
    setActive,
    setActiveSubTab,
    markRemoved,
    tabsByWorkspace,
    activeByWorkspace,
  };
});
