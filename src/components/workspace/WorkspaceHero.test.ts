import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import WorkspaceHero from "./WorkspaceHero.vue";
import { useAppStore } from "../../stores/app.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

function buildPayload(): StatePayload {
  const ws = {
    id: "ws-a",
    name: "Alpha",
    kind: "terminal",
    color: "#4CAF50",
    cwd: "/home/user/projects/alpha",
    panels: [{ id: "main", command: "" }],
  };
  return {
    appState: {
      activeWorkspaceId: "ws-a",
      profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-a"] }],
      workspaces: [ws],
    },
    workspace: { workspace: ws, project: null, sessions: [] },
    git: { workspaces: {} },
  } as unknown as StatePayload;
}

function mountHero() {
  return mount(WorkspaceHero, {
    global: {
      stubs: {
        WorkspaceLayoutChip: true,
        NotificationBell: true,
      },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
});

/**
 * Category B (code-review batch, 2026-07): copyPath used
 * `navigator.clipboard.writeText(cwd).then(...)` with no `.catch()` — a
 * failed copy (non-secure context, remote web client) was invisible.
 */
describe("WorkspaceHero — copyPath feedback", () => {
  it("shows 'Copied!' after a successful copy", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    const wrapper = mountHero();

    const pathEl = wrapper.find(".workspace-meta__path--copyable");
    expect(pathEl.exists()).toBe(true);
    await pathEl.trigger("click");
    await flushPromises();

    expect(pathEl.text()).toBe("Copied!");
  });

  it("shows a 'Copy failed' message instead of silently doing nothing when the clipboard write rejects", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    const appStore = useAppStore();
    appStore.payload = buildPayload();
    const wrapper = mountHero();

    const pathEl = wrapper.find(".workspace-meta__path--copyable");
    const before = pathEl.text();
    expect(before).toContain("alpha");

    await pathEl.trigger("click");
    await flushPromises();

    expect(pathEl.text()).toBe("Copy failed");
  });
});
