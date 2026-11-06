import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ContextMenu from "./ContextMenu.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("ContextMenu", () => {
  function savedJiraPayload() {
    const view = (viewId: string, title: string) => ({
      viewId,
      kind: "board" as const,
      connectionId: "jira-c1",
      boardId: 7,
      boardName: title,
      title,
      mode: "issues" as const,
      sprintId: null,
      quickFilterIds: [],
      assignee: null,
      doneWithinDays: null,
      createdAt: 1,
      updatedAt: 1,
    });
    return {
      workspace: { workspace: { id: "jira-ws", kind: "jira", profileId: "default", panels: [] }, sessions: [] },
      appState: {
        workspaces: [{ id: "jira-ws", kind: "jira", profileId: "default", panels: [] }],
        activeWorkspaceId: "jira-ws",
        activeProfileId: "default",
      },
      jiraWorkspaceViews: {
        "jira-ws": {
          workspaceId: "jira-ws",
          profileId: "default",
          views: [{ viewId: "issues", kind: "issues", title: "Issues" }, view("a", "Alpha"), view("b", "Beta")],
          activeViewId: "b",
          syncByViewId: {},
        },
      },
    };
  }

  test("renders nothing when contextMenu is null", () => {
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    expect(wrapper.find(".context-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  test("renders terminal actions as buttons for a terminal tab", () => {
    const store = useAppStore();
    store.contextMenu = { viewId: "term:1", x: 100, y: 200 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu");
    expect(menu).not.toBeNull();
    const buttons = (menu as Element).querySelectorAll("button");
    const texts = Array.from(buttons).map((b) => b.textContent);
    expect(texts.some((t) => t.includes("Restart"))).toBe(true);
    wrapper.unmount();
  });

  test("offers background Jira sync on a saved view without terminal actions", async () => {
    const store = useAppStore();
    store.payload = { appState: { activeWorkspaceId: "jira-ws" } } as typeof store.payload;
    const refreshJiraWorkspaceViews = vi.fn().mockResolvedValue({});
    vi.spyOn(store, "getApi").mockReturnValue({ refreshJiraWorkspaceViews } as unknown as ReturnType<
      typeof store.getApi
    >);
    store.contextMenu = { viewId: "jira:jira-ws:view:board%3A42", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    expect(menu.textContent).not.toMatch(/Find in terminal|Save last|Clear output|Restart|companion/);
    const refresh = Array.from(menu.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Refresh Jira"),
    );
    expect(refresh).toBeDefined();
    refresh!.click();
    await wrapper.vm.$nextTick();
    expect(refreshJiraWorkspaceViews).toHaveBeenCalledExactlyOnceWith({ workspaceId: "jira-ws", viewId: "board:42" });
    expect(store.contextMenu).toBeNull();
    wrapper.unmount();
  });

  test("focuses Jira menu actions and restores the tab anchor on Escape", async () => {
    const store = useAppStore();
    store.payload = savedJiraPayload() as unknown as StatePayload;
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.focus();
    store.contextMenu = { viewId: "jira:jira-ws:view:b", x: 0, y: 0, anchor };

    const wrapper = mount(ContextMenu, { attachTo: document.body });
    await wrapper.vm.$nextTick();
    await flushPromises();
    expect(document.activeElement?.textContent).toContain("Focus tab");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    await flushPromises();
    expect(store.contextMenu).toBeNull();
    expect(document.activeElement).toBe(anchor);

    wrapper.unmount();
    anchor.remove();
  });

  test("Escape restores focus to mobile Tabs when the action-row anchor was removed", async () => {
    const store = useAppStore();
    store.payload = savedJiraPayload() as unknown as StatePayload;
    const trigger = document.createElement("button");
    trigger.dataset.role = "mobile-tab-picker-trigger";
    document.body.append(trigger);
    const removedActionAnchor = document.createElement("button");
    document.body.append(removedActionAnchor);
    store.contextMenu = { viewId: "jira:jira-ws:view:b", x: 0, y: 0, anchor: removedActionAnchor };

    const wrapper = mount(ContextMenu, { attachTo: document.body });
    await wrapper.vm.$nextTick();
    await flushPromises();
    expect(document.activeElement?.textContent).toContain("Focus tab");

    removedActionAnchor.remove();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await wrapper.vm.$nextTick();
    await flushPromises();

    expect(store.contextMenu).toBeNull();
    expect(document.activeElement).toBe(trigger);
    wrapper.unmount();
    trigger.remove();
  });

  test("saved Jira menu exposes rename and adjacent reorder actions, persisting only saved IDs", async () => {
    const store = useAppStore();
    store.payload = savedJiraPayload() as unknown as StatePayload;
    const reorderJiraWorkspaceViews = vi.fn().mockResolvedValue(savedJiraPayload().jiraWorkspaceViews["jira-ws"]);
    store.init({
      reorderJiraWorkspaceViews,
      onStateUpdated: () => () => {},
      getState: async () => store.payload,
    } as unknown as Parameters<typeof store.init>[0]);
    store.contextMenu = { viewId: "jira:jira-ws:view:b", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    const labels = Array.from(menu.querySelectorAll("button")).map((button) => button.textContent?.trim());
    expect(labels.some((label) => label?.includes("Rename view"))).toBe(true);
    expect(labels.some((label) => label?.includes("Move left"))).toBe(true);
    expect(labels.some((label) => label?.includes("Move right"))).toBe(false);
    expect(menu.textContent).not.toMatch(/Find in terminal|Save last|Clear output|Restart/);

    (
      Array.from(menu.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Move left"),
      ) as HTMLElement
    ).click();
    await wrapper.vm.$nextTick();
    expect(reorderJiraWorkspaceViews).toHaveBeenCalledExactlyOnceWith({ workspaceId: "jira-ws", viewIds: ["b", "a"] });
    await flushPromises();
    expect(store.payload?.jiraWorkspaceViews?.["jira-ws"]?.activeViewId).toBe("b");
    wrapper.unmount();
  });

  test("renames through the shared text input dialog and keeps the active view", async () => {
    const store = useAppStore();
    const payload = savedJiraPayload();
    store.payload = payload as unknown as StatePayload;
    const renamedState = {
      ...payload.jiraWorkspaceViews["jira-ws"],
      views: payload.jiraWorkspaceViews["jira-ws"].views.map((view) =>
        view.viewId === "b" ? { ...view, title: "My custom board name" } : view,
      ),
    };
    const renameJiraWorkspaceView = vi.fn().mockResolvedValue(renamedState);
    store.init({
      renameJiraWorkspaceView,
      onStateUpdated: () => () => {},
      getState: async () => store.payload,
    } as unknown as Parameters<typeof store.init>[0]);
    store.contextMenu = { viewId: "jira:jira-ws:view:b", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    const rename = Array.from(menu.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Rename view"),
    );
    (rename as HTMLElement).click();
    await wrapper.vm.$nextTick();
    expect(store.overlay).toBe("TextInputDialog");
    const submit = store.overlayProps.onSubmit as (title: string) => Promise<void>;
    await submit("My custom board name");
    expect(renameJiraWorkspaceView).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "jira-ws",
      viewId: "b",
      title: "My custom board name",
    });
    expect(store.payload?.jiraWorkspaceViews?.["jira-ws"]?.views.find((view) => view.viewId === "b")?.title).toBe(
      "My custom board name",
    );
    expect(store.payload?.jiraWorkspaceViews?.["jira-ws"]?.activeViewId).toBe("b");
    wrapper.unmount();
  });

  test("returns focus to the mobile Tabs trigger when the rename prompt is cancelled", async () => {
    const store = useAppStore();
    store.payload = savedJiraPayload() as unknown as StatePayload;
    const trigger = document.createElement("button");
    trigger.dataset.role = "mobile-tab-picker-trigger";
    document.body.append(trigger);
    const removedActionAnchor = document.createElement("button");
    store.contextMenu = { viewId: "jira:jira-ws:view:b", x: 0, y: 0, anchor: removedActionAnchor };

    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    const rename = Array.from(menu.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Rename view"),
    );
    (rename as HTMLElement).click();
    await wrapper.vm.$nextTick();

    const dialog = document.createElement("div");
    dialog.className = "dialog";
    const input = document.createElement("input");
    dialog.append(input);
    document.body.append(dialog);
    input.focus();
    (store.overlayProps.onCancel as () => void)();
    dialog.remove();
    await wrapper.vm.$nextTick();
    await flushPromises();

    expect(document.activeElement).toBe(trigger);
    wrapper.unmount();
    trigger.remove();
  });

  test("offers 'Add companion agent…' for a real terminal panel and passes the exact sourceSessionId", async () => {
    const store = useAppStore();
    store.getPanelByViewId = ((viewId: string) => {
      if (viewId !== "ws1:shell") return null;
      return { workspace: { id: "ws1", kind: "manual" }, panel: { id: "shell", command: "claude" } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const spy = { called: false, arg: "" };
    store.openCompanionAgentDialog = (id: string) => {
      spy.called = true;
      spy.arg = id;
    };
    store.contextMenu = { viewId: "ws1:shell", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    const btn = Array.from(menu.querySelectorAll("button")).find((b) => b.textContent?.includes("Add companion agent"));
    expect(btn).toBeDefined();
    (btn as HTMLElement).click();
    await wrapper.vm.$nextTick();
    expect(spy.called).toBe(true);
    expect(spy.arg).toBe("ws1:shell");
    wrapper.unmount();
  });

  test("does not offer 'Add companion agent…' for an SSH panel", () => {
    const store = useAppStore();
    store.getPanelByViewId = ((viewId: string) => {
      if (viewId !== "ws1:ssh") return null;
      return { workspace: { id: "ws1", kind: "manual" }, panel: { id: "ssh", launch: { kind: "ssh" } } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    store.contextMenu = { viewId: "ws1:ssh", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    const text = menu.textContent || "";
    expect(text).not.toContain("Add companion agent");
    wrapper.unmount();
  });

  test("does not offer 'Add companion agent…' inside a task workspace's own panels", () => {
    const store = useAppStore();
    store.getPanelByViewId = ((viewId: string) => {
      if (viewId !== "ws-task:judge") return null;
      return { workspace: { id: "ws-task", kind: "task" }, panel: { id: "judge", command: "claude" } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    store.contextMenu = { viewId: "ws-task:judge", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    const text = menu.textContent || "";
    expect(text).not.toContain("Add companion agent");
    wrapper.unmount();
  });

  // The Review tab is not a panel, so it has no Close action — detaching the
  // workspace from its PR is what removes it, and this menu is the first place
  // users look (Seba's report).
  function seedReviewWorkspace(store: ReturnType<typeof useAppStore>, review: unknown): void {
    store.payload = {
      appState: {
        workspaces: [{ id: "ws-pr", name: "web-app", panels: [{ id: "shell" }], review }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  test("offers 'Detach from PR review' on the Review tab and passes the workspace id", async () => {
    const store = useAppStore();
    seedReviewWorkspace(store, { provider: "azure-devops", prKey: "ado-main:repo-1:123" });
    const calls: string[] = [];
    store.confirmAndDetachWorkspaceReview = (async (workspaceId: string) => {
      calls.push(workspaceId);
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    store.contextMenu = { viewId: "review:ws-pr", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    // The provider refresh stays available alongside it.
    expect(menu.textContent || "").toContain("Refresh Azure DevOps");
    const btn = Array.from(menu.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Detach from PR review"),
    );
    expect(btn).toBeDefined();
    (btn as HTMLElement).click();
    await wrapper.vm.$nextTick();
    expect(calls).toEqual(["ws-pr"]);
    // The menu closes on the way out — the confirm dialog takes over.
    expect(store.contextMenu).toBeNull();
    wrapper.unmount();
  });

  test("does not offer the detach for a GitHub review tab whose workspace lost its prKey", () => {
    const store = useAppStore();
    seedReviewWorkspace(store, { provider: "github", prKey: "" });
    store.contextMenu = { viewId: "review:ws-pr", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    expect(menu.textContent || "").not.toContain("Detach from PR review");
    wrapper.unmount();
  });

  test("does not offer the detach on a terminal tab of the same workspace", () => {
    const store = useAppStore();
    seedReviewWorkspace(store, { provider: "azure-devops", prKey: "ado-main:repo-1:123" });
    const resolvePanel = (viewId: string) =>
      viewId === "ws-pr:shell" ? { workspace: { id: "ws-pr", kind: "manual" }, panel: { id: "shell" } } : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.getPanelByViewId = resolvePanel as any;
    store.contextMenu = { viewId: "ws-pr:shell", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu") as Element;
    expect(menu.textContent || "").not.toContain("Detach from PR review");
    wrapper.unmount();
  });

  test("a saved board tab can open in its own workspace; a failure is reported, not swallowed", async () => {
    const store = useAppStore();
    store.payload = savedJiraPayload() as unknown as StatePayload;
    const open = vi.spyOn(store, "openJiraViewInOwnWorkspace").mockResolvedValueOnce(undefined);
    store.contextMenu = { viewId: "jira:jira-ws:view:b", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const item = () =>
      Array.from(document.querySelectorAll(".context-menu button")).find((button) =>
        button.textContent?.includes("Open in own workspace"),
      ) as HTMLElement | undefined;
    expect(item()).toBeDefined();
    item()!.click();
    await flushPromises();
    expect(open).toHaveBeenCalledExactlyOnceWith("jira:jira-ws:view:b");
    expect(store.contextMenu).toBeNull();
    wrapper.unmount();

    open.mockRejectedValueOnce(new Error("Workspace store locked"));
    store.contextMenu = { viewId: "jira:jira-ws:view:a", x: 0, y: 0 };
    const second = mount(ContextMenu, { attachTo: document.body });
    item()!.click();
    await vi.waitFor(() => expect(useNotificationStore().sessions).toHaveLength(1));
    const event = useNotificationStore().sessions[0].events[0];
    expect(event.title).toBe("Couldn't open the board in its own workspace");
    expect(event.body).toContain("Workspace store locked");
    second.unmount();
  });

  test("the issues tab has no Open in own workspace action", () => {
    const store = useAppStore();
    store.payload = savedJiraPayload() as unknown as StatePayload;
    store.contextMenu = { viewId: "jira:jira-ws", x: 0, y: 0 };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    expect(document.querySelector(".context-menu")?.textContent).not.toContain("Open in own workspace");
    wrapper.unmount();
  });

  test("renders group actions when tab is in split group", () => {
    const store = useAppStore();
    store.contextMenu = { viewId: "term:1", x: 50, y: 50 };
    store.splitGroup = { layout: "cols", viewIds: ["term:1", "term:2"] };
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = document.querySelector(".context-menu");
    expect(menu).not.toBeNull();
    const text = (menu as Element).textContent;
    expect(text).toContain("Remove from split");
    expect(text).toContain("Disband split");
    wrapper.unmount();
  });
});
