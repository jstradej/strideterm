import { describe, expect, test, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ContextMenu from "./ContextMenu.vue";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("ContextMenu", () => {
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
