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

/**
 * The running-agent chip's placement is the whole point of F5: it sits as a
 * DIRECT child of `.workspace-meta`, next to the bell, and never inside
 * `.workspace-meta__stats` — because src/styles/mobile.css hides that stats
 * container below 768px / under 500px of height while `.workspace-meta` and
 * `.notification-bell` survive. That is what buys the chip remote/mobile
 * visibility with no new CSS exception, so mobile.css is left untouched.
 */
describe("WorkspaceHero — running-agent chip placement", () => {
  /**
   * The chip counts SUPERVISED agents only (V3 review, Fáze 1), so the hero
   * needs a task workspace to make it appear. `kind` still varies the hero
   * BRANCH the chip has to survive; the running task lives beside it.
   */
  function payloadWithRunningAgent(kind: string): StatePayload {
    const ws = {
      id: "ws-a",
      name: "Alpha",
      kind,
      color: "#4CAF50",
      cwd: "/home/user/projects/alpha",
      profileId: "default",
      panels: [{ id: "claude", title: "Claude", command: "" }],
    };
    const task = {
      id: "ws-task",
      name: "Task One",
      kind: "task",
      color: "#4CAF50",
      cwd: "/home/user/projects/alpha-task",
      profileId: "default",
      panels: [
        { id: "worker", title: "Worker Claude", command: "" },
        { id: "judge", title: "Judge Codex", command: "" },
      ],
      task: {
        taskId: "t-1",
        state: "running",
        workerPanelId: "worker",
        judgePanelId: "judge",
        startedAt: Date.now() - 60_000,
        totalPausedMs: 0,
        pausedAt: null,
        finishedAt: null,
      },
    };
    return {
      appState: {
        activeWorkspaceId: "ws-a",
        activeProfileId: "default",
        profiles: [{ id: "default", name: "Default", color: "", workspaceIds: ["ws-a", "ws-task"] }],
        workspaces: [ws, task],
        windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-a" }],
        settings: {},
      },
      workspace: { workspace: ws, project: null, sessions: [] },
      git: { workspaces: {} },
      taskRunner: { "ws-task": { state: "running" } },
      attention: { sessions: {}, alerts: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as StatePayload;
  }

  function mountHeroWithChip() {
    return mount(WorkspaceHero, {
      global: { stubs: { WorkspaceLayoutChip: true, NotificationBell: true } },
      attachTo: document.body,
    });
  }

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).strideterm = { startupFlags: { windowId: "win-test" } };
  });

  for (const kind of ["terminal", "azure", "github"]) {
    it(`renders the chip in the ${kind} hero branch, outside workspace-meta__stats`, () => {
      const appStore = useAppStore();
      appStore.payload = payloadWithRunningAgent(kind);
      const wrapper = mountHeroWithChip();

      const chip = wrapper.get('[data-role="agent-run-chip"]');
      const el = chip.element as HTMLElement;
      expect(el.parentElement?.classList.contains("workspace-meta")).toBe(true);
      expect(el.closest(".workspace-meta__stats")).toBeNull();
      wrapper.unmount();
    });
  }

  it("survives the compact/mobile rule that hides workspace-meta__stats", () => {
    const appStore = useAppStore();
    appStore.payload = payloadWithRunningAgent("terminal");
    const wrapper = mountHeroWithChip();

    // Apply exactly the declaration src/styles/mobile.css applies below 768px
    // (jsdom does not evaluate the media query itself).
    const style = document.createElement("style");
    style.textContent = ".workspace-meta__stats { display: none; }";
    document.head.appendChild(style);

    const stats = wrapper.get(".workspace-meta__stats").element as HTMLElement;
    const chip = wrapper.get('[data-role="agent-run-chip"]').element as HTMLElement;
    expect(window.getComputedStyle(stats).display).toBe("none");
    expect(chip.closest(".workspace-meta__stats")).toBeNull();
    expect(window.getComputedStyle(chip).display).not.toBe("none");

    style.remove();
    wrapper.unmount();
  });

  it("is absent when nothing is running", () => {
    const appStore = useAppStore();
    const payload = payloadWithRunningAgent("terminal") as unknown as Record<string, unknown>;
    payload.taskRunner = { "ws-task": { state: "paused" } };
    appStore.payload = payload as unknown as StatePayload;

    const wrapper = mountHeroWithChip();
    expect(wrapper.find('[data-role="agent-run-chip"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
