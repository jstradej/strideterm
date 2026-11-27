import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import UsageStatusBar from "./UsageStatusBar.vue";

const { state } = vi.hoisted(() => ({
  state: { entries: [], loading: false, error: "" } as {
    entries: Array<Record<string, unknown>>;
    loading: boolean;
    error: string;
  },
}));
vi.mock("../../composables/useAgentUsage.js", () => ({
  useAgentUsage: () => ({ entries: ref(state.entries), loading: ref(state.loading), error: ref(state.error) }),
}));

describe("UsageStatusBar", () => {
  it("summarizes Claude and Codex with actual use and even-pace marker, then emits open", async () => {
    const now = Date.now();
    state.entries = [
      {
        provider: "claude",
        checkedAt: now,
        windows: [{ label: "Session", usedPercent: 40, durationMinutes: 1000, resetsAt: now + 600_000 }],
      },
      {
        provider: "codex",
        checkedAt: now,
        windows: [{ label: "Weekly", usedPercent: 18, durationMinutes: 10080, resetsAt: now + 7 * 86_400_000 }],
      },
    ];
    state.loading = false;
    state.error = "";
    const wrapper = mount(UsageStatusBar);
    expect(wrapper.text()).toContain("Claude");
    expect(wrapper.text()).toContain("Codex");
    expect(wrapper.text()).toContain("40%");
    expect(wrapper.findAll('[role="img"]')).toHaveLength(2);
    expect(wrapper.attributes("aria-label")).toContain("used");
    expect(wrapper.findAll(".usage-status-bar__pace")).toHaveLength(2);
    await wrapper.trigger("click");
    expect(wrapper.emitted("open")).toHaveLength(1);
    wrapper.unmount();
  });

  it("shows the projection, the time to reset and the Codex reset credits", () => {
    const now = Date.now();
    state.entries = [
      {
        provider: "codex",
        checkedAt: now,
        windows: [{ label: "Weekly", usedPercent: 20, durationMinutes: 7 * 1440, resetsAt: now + 3.5 * 86_400_000 }],
        resetCredits: { available: 3, expiresAt: [] },
      },
      {
        provider: "claude",
        checkedAt: now,
        windows: [{ label: "Weekly", usedPercent: 5, durationMinutes: 7 * 1440, resetsAt: now + 3.5 * 86_400_000 }],
      },
    ];
    state.loading = false;
    const wrapper = mount(UsageStatusBar);
    const rows = wrapper.findAll(".usage-status-bar__provider");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.get(".usage-status-bar__projection").attributes("style")).toContain("left: 20%");
    expect(rows[1]?.get(".usage-status-bar__projection").attributes("style")).toContain("width: 20%");
    expect(rows[1]?.get(".usage-status-bar__reset").attributes("title")).toBe("Resets in");
    expect(rows[1]?.get(".usage-status-bar__reset").text()).toBe("3d 12h");
    expect(rows[1]?.get(".usage-status-bar__credits").text()).toBe("3× reset");
    expect(rows[0]?.find(".usage-status-bar__credits").exists()).toBe(false);
    expect(wrapper.attributes("aria-label")).toContain("3 resets available");
    wrapper.unmount();
  });

  it("spins while loading without data and next to the label while refreshing", () => {
    state.entries = [];
    state.loading = true;
    const empty = mount(UsageStatusBar);
    expect(empty.findAll(".spinner")).toHaveLength(1);
    empty.unmount();
    state.entries = [{ provider: "claude", checkedAt: Date.now(), windows: [{ label: "Weekly", usedPercent: 30 }] }];
    const refreshing = mount(UsageStatusBar);
    expect(refreshing.find(".usage-status-bar__label .spinner").exists()).toBe(true);
    refreshing.unmount();
    state.loading = false;
    const idle = mount(UsageStatusBar);
    expect(idle.find(".spinner").exists()).toBe(false);
    idle.unmount();
  });

  it("labels scoped usage and keeps an unavailable forecast neutral", () => {
    state.entries = [
      {
        provider: "claude",
        checkedAt: Date.now(),
        windows: [{ label: "Session", scope: "project-x", usedPercent: 35 }],
      },
    ];
    const wrapper = mount(UsageStatusBar);
    expect(wrapper.text()).toContain("project-x");
    expect(wrapper.text()).toContain("Forecast unknown");
    expect(wrapper.findAll(".usage-status-bar__pace")).toHaveLength(0);
    expect(wrapper.get('[role="img"]').attributes("aria-label")).toContain("Even pace unavailable");
    wrapper.unmount();
  });

  it("shows a healthy empty state while loading and an unavailable state afterward", () => {
    state.entries = [];
    state.loading = true;
    state.error = "";
    const loadingWrapper = mount(UsageStatusBar);
    expect(loadingWrapper.text()).toContain("Checking usage");
    loadingWrapper.unmount();
    state.loading = false;
    state.error = "provider offline";
    const unavailableWrapper = mount(UsageStatusBar);
    expect(unavailableWrapper.text()).toContain("Usage unavailable");
    unavailableWrapper.unmount();
  });

  it("shows Gemini's observed usage when Claude and Codex have no readings", () => {
    state.entries = [
      { provider: "claude", checkedAt: Date.now(), windows: [], unavailable: "Claude CLI not installed." },
      { provider: "codex", checkedAt: Date.now(), windows: [], unavailable: "Codex login expired." },
      { provider: "gemini", checkedAt: Date.now(), windows: [{ label: "Pro", usedPercent: 45 }] },
    ];
    state.loading = false;
    state.error = "";
    const wrapper = mount(UsageStatusBar);
    expect(wrapper.text()).toContain("Gemini");
    expect(wrapper.text()).toContain("Pro");
    expect(wrapper.text()).toContain("≈45%");
    expect(wrapper.text()).toContain("Observed");
    expect(wrapper.findAll(".usage-status-bar__pace")).toHaveLength(0);
    wrapper.unmount();
  });

  it("points to a separately signed-in account when the default login has no reading", () => {
    state.entries = [
      {
        provider: "codex",
        checkedAt: Date.now(),
        windows: [],
        otherAccounts: [{ id: "work", status: "separate-login", windows: [{ label: "Weekly", usedPercent: 12 }] }],
      },
    ];
    const wrapper = mount(UsageStatusBar);
    expect(wrapper.text()).toContain("See other logins");
    expect(wrapper.attributes("aria-label")).toContain("Codex usage is available for another login");
    expect(wrapper.find('[role="img"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps candidate folder quotas out of footer usage and next-account advice", () => {
    const checkedAt = Date.now();
    state.entries = [
      {
        provider: "claude",
        checkedAt,
        windows: [{ label: "Weekly", usedPercent: 100, resetsAt: checkedAt + 2 * 86_400_000 }],
        otherAccounts: [
          {
            id: "candidate",
            label: "Detected profile",
            status: "candidate",
            windows: [{ label: "Weekly", usedPercent: 99 }],
          },
        ],
      },
      {
        provider: "codex",
        checkedAt,
        windows: [
          { label: "Weekly", usedPercent: 2, durationMinutes: 7 * 24 * 60, resetsAt: checkedAt + 6 * 86_400_000 },
        ],
      },
    ];
    state.loading = false;
    state.error = "";
    const wrapper = mount(UsageStatusBar);
    expect(wrapper.text()).toContain("Use next");
    expect(wrapper.text()).not.toContain("99%");
    expect(wrapper.attributes("aria-label")).toContain("Claude Weekly, 100% used");
    expect(wrapper.attributes("aria-label")).toContain("Codex Weekly, 2% used");
    wrapper.unmount();
  });
});
