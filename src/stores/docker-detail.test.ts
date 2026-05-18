import { beforeEach, describe, expect, test } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useDockerDetail } from "./docker-detail.js";

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
