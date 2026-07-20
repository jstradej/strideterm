import { beforeEach, describe, expect, test, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useDockerDetail } from "./docker-detail.js";
import { useAppStore } from "./app.js";

describe("useDockerDetail — list tab openers", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("openImagesList creates one tab per (backend, context) and is idempotent", () => {
    const store = useDockerDetail();
    store.openImagesList("ws-1", "host", "default", "Images");
    expect(store.getTabs("ws-1")).toHaveLength(1);

    // Same args — should focus the existing tab, not add another.
    store.openImagesList("ws-1", "host", "default", "Images (127)");
    expect(store.getTabs("ws-1")).toHaveLength(1);

    // Different context — separate tab.
    store.openImagesList("ws-1", "host", "remote", "Images");
    expect(store.getTabs("ws-1")).toHaveLength(2);

    // Different workspace — fully independent.
    store.openImagesList("ws-2", "host", "default", "Images");
    expect(store.getTabs("ws-2")).toHaveLength(1);
    expect(store.getTabs("ws-1")).toHaveLength(2);
  });

  test("each kind owns its own tab id namespace", () => {
    const store = useDockerDetail();
    store.openImagesList("ws", "host", "default", "Images");
    store.openVolumesList("ws", "host", "default", "Volumes");
    store.openNetworksList("ws", "host", "default", "Networks");
    const tabs = store.getTabs("ws");
    expect(tabs).toHaveLength(3);
    const ids = new Set(tabs.map((t) => t.tabId));
    expect(ids.size).toBe(3);
    expect(tabs.map((t) => t.kind)).toEqual(["images-list", "volumes-list", "networks-list"]);
  });

  test("opener activates the new tab", () => {
    const store = useDockerDetail();
    store.openImagesList("ws", "host", "default", "Images");
    const t = store.getTabs("ws")[0];
    expect(store.getActiveTabId("ws")).toBe(t.tabId);

    // Open another, then re-open the first → it becomes active again.
    store.openVolumesList("ws", "host", "default", "Volumes");
    expect(store.getActiveTabId("ws")).not.toBe(t.tabId);
    store.openImagesList("ws", "host", "default", "Images");
    expect(store.getActiveTabId("ws")).toBe(t.tabId);
  });

  test("closing a list tab removes it and falls back to a sibling", () => {
    const store = useDockerDetail();
    store.openImagesList("ws", "host", "default", "Images");
    store.openVolumesList("ws", "host", "default", "Volumes");
    const tabs = store.getTabs("ws");
    const images = tabs[0];
    store.closeTab("ws", images.tabId);
    expect(store.getTabs("ws")).toHaveLength(1);
    expect(store.getTabs("ws")[0].kind).toBe("volumes-list");
  });
});

describe("useDockerDetail — closeTabAndSessions", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // closeTabAndSessions used to be reimplemented byte-identically in
  // DockerDetail.vue and DockerPane.vue. This is the shared store action
  // both were migrated to.
  test("tears down the tab's log + shell sessions, then removes it", () => {
    const store = useDockerDetail();
    const appStore = useAppStore();
    const dockerLogsClose = vi.spyOn(appStore, "dockerLogsClose").mockResolvedValue(undefined);
    const dockerShellClose = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(appStore, "getApi").mockReturnValue({ dockerShellClose } as unknown as ReturnType<typeof appStore.getApi>);

    store.openContainer("ws", "c1", "host", "default", "my-container");
    const tab = store.getTabs("ws")[0];
    expect(tab.logSessionId).toBeTruthy();
    expect(tab.shellSessionId).toBeTruthy();

    store.closeTabAndSessions("ws", tab.tabId);

    expect(dockerLogsClose).toHaveBeenCalledWith(tab.logSessionId);
    expect(dockerShellClose).toHaveBeenCalledWith({ sessionId: tab.shellSessionId });
    expect(store.getTabs("ws")).toHaveLength(0);
  });

  test("skips session teardown for tabs without log/shell sessions", () => {
    const store = useDockerDetail();
    const appStore = useAppStore();
    const dockerLogsClose = vi.spyOn(appStore, "dockerLogsClose").mockResolvedValue(undefined);

    store.openImage("ws", "img1", "host", "default", "my-image");
    const tab = store.getTabs("ws")[0];

    store.closeTabAndSessions("ws", tab.tabId);

    expect(dockerLogsClose).not.toHaveBeenCalled();
    expect(store.getTabs("ws")).toHaveLength(0);
  });
});
