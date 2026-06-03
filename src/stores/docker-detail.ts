import { defineStore } from "pinia";
import { ref, watchEffect } from "vue";
import { useAppStore } from "./app.js";

export type TabKind =
  | "container"
  | "project"
  | "image"
  | "volume"
  | "network"
  | "images-list"
  | "volumes-list"
  | "networks-list";

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

export interface ComposeActionProgress {
  action: string;
  current: number;
  total: number;
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
  // Compose action progress per workspace
  const composeProgress = ref<Map<string, ComposeActionProgress>>(new Map());

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

  function openContainer(
    workspaceId: string,
    containerId: string,
    backendId: string,
    contextName: string,
    label: string,
  ): void {
    const tabId = makeTabId("container", backendId, contextName, containerId);
    const tabs = getTabs(workspaceId);
    const existing = tabs.find((t) => t.tabId === tabId);
    if (!existing) {
      const newTab: OpenTab = {
        tabId,
        kind: "container",
        label,
        backendId,
        contextName,
        containerId,
        logSessionId: crypto.randomUUID(),
        shellSessionId: crypto.randomUUID(),
        activeSubTab: "logs",
      };
      tabsByWorkspace.value.set(workspaceId, [...tabs, newTab]);
    }
    setActive(workspaceId, tabId);
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
    const tabs = getTabs(workspaceId);
    if (!tabs.find((t) => t.tabId === tabId)) {
      tabsByWorkspace.value.set(workspaceId, [
        ...tabs,
        { tabId, kind: "image", label, backendId, contextName, imageId, activeSubTab: "inspect" },
      ]);
    }
    setActive(workspaceId, tabId);
  }

  function openVolume(workspaceId: string, volumeName: string, backendId: string, contextName: string): void {
    const tabId = makeTabId("volume", backendId, contextName, volumeName);
    const tabs = getTabs(workspaceId);
    if (!tabs.find((t) => t.tabId === tabId)) {
      tabsByWorkspace.value.set(workspaceId, [
        ...tabs,
        {
          tabId,
          kind: "volume",
          label: volumeName,
          backendId,
          contextName,
          volumeName,
          activeSubTab: "inspect",
        },
      ]);
    }
    setActive(workspaceId, tabId);
  }

  function openNetwork(
    workspaceId: string,
    networkId: string,
    backendId: string,
    contextName: string,
    label: string,
  ): void {
    const tabId = makeTabId("network", backendId, contextName, networkId);
    const tabs = getTabs(workspaceId);
    if (!tabs.find((t) => t.tabId === tabId)) {
      tabsByWorkspace.value.set(workspaceId, [
        ...tabs,
        { tabId, kind: "network", label, backendId, contextName, networkId, activeSubTab: "inspect" },
      ]);
    }
    setActive(workspaceId, tabId);
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
    const tabs = getTabs(workspaceId);
    if (!tabs.find((t) => t.tabId === tabId)) {
      tabsByWorkspace.value.set(workspaceId, [...tabs, { tabId, kind: "images-list", label, backendId, contextName }]);
    }
    setActive(workspaceId, tabId);
  }

  function openVolumesList(workspaceId: string, backendId: string, contextName: string, label: string): void {
    const tabId = makeTabId("volumes-list", backendId, contextName, "");
    const tabs = getTabs(workspaceId);
    if (!tabs.find((t) => t.tabId === tabId)) {
      tabsByWorkspace.value.set(workspaceId, [...tabs, { tabId, kind: "volumes-list", label, backendId, contextName }]);
    }
    setActive(workspaceId, tabId);
  }

  function openNetworksList(workspaceId: string, backendId: string, contextName: string, label: string): void {
    const tabId = makeTabId("networks-list", backendId, contextName, "");
    const tabs = getTabs(workspaceId);
    if (!tabs.find((t) => t.tabId === tabId)) {
      tabsByWorkspace.value.set(workspaceId, [
        ...tabs,
        { tabId, kind: "networks-list", label, backendId, contextName },
      ]);
    }
    setActive(workspaceId, tabId);
  }

  function openComposeProject(workspaceId: string, projectName: string, backendId: string, contextName: string): void {
    const tabId = makeTabId("project", backendId, contextName, projectName);
    const tabs = getTabs(workspaceId);
    const existing = tabs.find((t) => t.tabId === tabId);
    if (!existing) {
      const newTab: OpenTab = {
        tabId,
        kind: "project",
        label: projectName,
        backendId,
        contextName,
        projectName,
      };
      tabsByWorkspace.value.set(workspaceId, [...tabs, newTab]);
    }
    setActive(workspaceId, tabId);
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

  function setActive(workspaceId: string, tabId: string): void {
    activeByWorkspace.value.set(workspaceId, tabId);
  }

  function markRemoved(workspaceId: string, containerId: string): void {
    const tabs = getTabs(workspaceId);
    const updated = tabs.map((t) => (t.containerId === containerId ? { ...t, removed: true } : t));
    tabsByWorkspace.value.set(workspaceId, updated);
  }

  function updateLogSessionId(workspaceId: string, tabId: string, sessionId: string): void {
    const tabs = getTabs(workspaceId);
    const updated = tabs.map((t) => (t.tabId === tabId ? { ...t, logSessionId: sessionId } : t));
    tabsByWorkspace.value.set(workspaceId, updated);
  }

  // Watch for removed containers to mark tabs as removed
  watchEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docker = (appStore.payload as any)?.docker;
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
    setActive,
    setActiveSubTab,
    markRemoved,
    updateLogSessionId,
    composeProgress,
    tabsByWorkspace,
    activeByWorkspace,
  };
});
