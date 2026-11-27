import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import AgentUsagePanel from "./AgentUsagePanel.vue";

const { readAgentUsage, addUsageAccountProfile, removeUsageAccountProfile, state } = vi.hoisted(() => ({
  readAgentUsage: vi.fn(),
  addUsageAccountProfile: vi.fn(),
  removeUsageAccountProfile: vi.fn(),
  state: { managementApiEnabled: true, remote: false },
}));
vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({
    activeSessionId: "session-test",
    getApi: () => ({
      readAgentUsage,
      isRemote: state.remote,
      ...(state.managementApiEnabled ? { addUsageAccountProfile, removeUsageAccountProfile } : {}),
    }),
  }),
}));
vi.mock("../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError: vi.fn() }),
}));

describe("AgentUsagePanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readAgentUsage.mockReset();
    addUsageAccountProfile.mockReset();
    removeUsageAccountProfile.mockReset();
    state.managementApiEnabled = true;
    state.remote = false;
  });
  afterEach(() => vi.useRealTimers());

  it("renders per-provider windows with exact fractional percentages and local reset times", async () => {
    const checkedAt = Date.now();
    readAgentUsage.mockResolvedValue([
      {
        provider: "claude",
        checkedAt,
        windows: [
          { label: "Session", usedPercent: 0.04, resetsAt: checkedAt + 56 * 60_000 },
          { label: "Monthly", usedPercent: 80 },
          { label: "Weekly", usedPercent: 99.99 },
        ],
      },
      { provider: "gemini", checkedAt: new Date("2026-01-03T03:04:00Z").getTime(), windows: [] },
    ]);

    const wrapper = mount(AgentUsagePanel);
    await flushPromises();

    expect(readAgentUsage).toHaveBeenCalledTimes(1);
    expect(readAgentUsage).toHaveBeenCalledWith("session-test");
    expect(wrapper.text()).toContain("Claude Code");
    expect(wrapper.text()).toContain("Claude and Codex use the default CLI accounts on this computer.");
    expect(wrapper.text()).toMatch(/0[.,]04%/);
    expect(wrapper.text()).toContain("80%");
    expect(wrapper.text()).toMatch(/99[.,]99%/);
    expect(wrapper.findAll('[role="img"]')).toHaveLength(3);
    expect(wrapper.text()).toContain("Until reset");
    expect(wrapper.text()).not.toContain("Observed");
    wrapper.unmount();
  });

  it("shows provider-specific reasons when usage is unavailable", async () => {
    readAgentUsage.mockResolvedValue([
      { provider: "codex", checkedAt: 1000, windows: [], unavailable: "Sign in to Codex to view usage." },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toBe("Sign in to Codex to view usage.");
    wrapper.unmount();
  });

  it("shows extra accounts as clearly stale history and permits adding and removing tracked folders", async () => {
    const lastSeen = Date.now() - 12 * 60 * 60_000;
    readAgentUsage.mockResolvedValue([
      {
        provider: "claude",
        checkedAt: Date.now(),
        account: { key: "default", label: "Default profile" },
        windows: [{ label: "Session", usedPercent: 10 }],
        otherAccounts: [
          {
            id: "profile-1",
            label: "Work profile",
            status: "last-seen",
            checkedAt: lastSeen,
            windows: [{ label: "Weekly", usedPercent: 60, resetsAt: lastSeen - 1_000 }],
            removable: true,
          },
          {
            id: "profile-separate",
            label: "Default account folder",
            status: "separate-login",
            checkedAt: lastSeen,
            windows: [{ label: "Monthly", usedPercent: 100 }],
            sameAsDefault: true,
          },
          {
            id: "profile-zero",
            label: "Empty usage",
            status: "separate-login",
            checkedAt: lastSeen,
            windows: [{ label: "Today", usedPercent: 0, durationMinutes: 60, resetsAt: Date.now() + 30 * 60_000 }],
          },
          {
            id: "profile-no-quotas",
            label: "No active quota",
            status: "separate-login",
            checkedAt: lastSeen,
            windows: [],
          },
          { id: "listed-1", label: "Listed profile", status: "listed" },
        ],
      },
    ]);
    addUsageAccountProfile.mockResolvedValue(true);
    removeUsageAccountProfile.mockResolvedValue(undefined);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Default profile (default CLI)");
    await wrapper.get(".agent-usage__accounts summary").trigger("click");
    expect(wrapper.get(".agent-usage__accounts summary").text().replace(/\s+/g, " ")).toContain(
      "Other logins and profiles · 5",
    );
    expect(wrapper.text()).toContain("Last seen");
    expect(wrapper.text()).toContain(
      `Last seen ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(lastSeen)}`,
    );
    expect(wrapper.text()).toContain(
      `Separate login · checked ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(lastSeen)}`,
    );
    expect(wrapper.text()).toContain("Monthly: 100% used");
    expect(wrapper.text()).toContain("Same account as default.");
    expect(wrapper.text()).not.toContain("Limit reached");
    const zeroProfile = wrapper.findAll(".agent-usage__account").find((row) => row.text().includes("Empty usage"));
    expect(zeroProfile?.text()).toContain("Today: 0% used");
    expect(zeroProfile?.get('[role="img"]').attributes("aria-label")).toContain("Today: 0% used");
    expect(wrapper.text()).toContain("No active quota windows.");
    expect(wrapper.text()).toContain("Weekly: 60% used");
    expect(wrapper.text()).toContain("Reset");
    expect(wrapper.text()).toContain("Listed account · no quota data available.");
    expect(wrapper.text()).not.toContain("Even pace now");
    await wrapper.get(".agent-usage__add").trigger("click");
    expect(addUsageAccountProfile).toHaveBeenCalledWith("claude");
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
    await wrapper.get(".agent-usage__remove").trigger("click");
    expect(removeUsageAccountProfile).toHaveBeenCalledWith("profile-1");
    expect(readAgentUsage).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it("hides account management actions and setup hints when the transport does not support them", async () => {
    state.managementApiEnabled = false;
    state.remote = true;
    readAgentUsage.mockResolvedValue([
      {
        provider: "codex",
        checkedAt: Date.now(),
        windows: [],
        otherAccounts: [{ id: "candidate-a", label: "Codex config", status: "candidate" }],
      },
      { provider: "gemini", checkedAt: Date.now(), windows: [{ label: "Daily", usedPercent: 5 }] },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    await wrapper.get(".agent-usage__accounts summary").trigger("click");
    expect(wrapper.text()).toContain("Detected configuration folder");
    expect(wrapper.text()).toContain("paired desktop's default CLI accounts");
    expect(wrapper.text()).toContain("selected Gemini terminal on the paired desktop");
    expect(wrapper.text()).not.toContain("Check this folder to verify");
    expect(wrapper.find(".agent-usage__add").exists()).toBe(false);
    expect(wrapper.find(".agent-usage__remove").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("CODEX_HOME");
    wrapper.unmount();
  });

  it("does not show an empty profiles disclosure for a read-only single-account provider", async () => {
    state.managementApiEnabled = false;
    readAgentUsage.mockResolvedValue([
      { provider: "codex", checkedAt: Date.now(), windows: [{ label: "Weekly", usedPercent: 35 }] },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.find(".agent-usage__accounts").exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps detected folders unverified until checked and excludes their quota from advice", async () => {
    const checkedAt = Date.now();
    const initial = [
      {
        provider: "claude" as const,
        checkedAt,
        windows: [{ label: "Weekly", usedPercent: 100, resetsAt: checkedAt + 2 * 24 * 60 * 60_000 }],
        otherAccounts: [
          {
            id: "candidate-a",
            label: "Detected Codex home",
            status: "candidate" as const,
            windows: [{ label: "Weekly", usedPercent: 99 }],
          },
        ],
      },
      {
        provider: "codex" as const,
        checkedAt,
        windows: [
          { label: "Weekly", usedPercent: 2, durationMinutes: 7 * 24 * 60, resetsAt: checkedAt + 6 * 24 * 60 * 60_000 },
        ],
      },
    ];
    const verified = [
      {
        ...initial[0],
        otherAccounts: [
          {
            id: "candidate-a",
            label: "Detected Codex home",
            status: "last-seen" as const,
            checkedAt,
            windows: [{ label: "Weekly", usedPercent: 55 }],
          },
        ],
      },
      initial[1],
    ];
    readAgentUsage.mockResolvedValueOnce(initial).mockResolvedValueOnce(verified);
    addUsageAccountProfile.mockResolvedValue(true);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Use Codex for the next task");
    expect(wrapper.text()).toContain("Claude Code Weekly quota is exhausted.");
    expect(wrapper.text()).not.toContain("99% used");
    await wrapper.get(".agent-usage__accounts summary").trigger("click");
    const candidate = wrapper
      .findAll(".agent-usage__account")
      .find((row) => row.text().includes("Detected Codex home"));
    expect(candidate?.text()).toContain("Detected configuration folder");
    expect(candidate?.text()).toContain("Check this folder to verify its account and current usage.");
    expect(candidate?.text()).not.toContain("99% used");
    expect(candidate?.find('[role="img"]').exists()).toBe(false);
    await candidate?.get("button").trigger("click");
    expect(addUsageAccountProfile).toHaveBeenCalledWith("claude", "candidate-a");
    await flushPromises();
    expect(wrapper.text()).toContain("Weekly: 55% used");
    expect(wrapper.text()).toContain("Use Codex for the next task");
    wrapper.unmount();
  });

  it("avoids displaying rounded endpoints and clears stale usage after a failed refresh", async () => {
    readAgentUsage
      .mockResolvedValueOnce([
        {
          provider: "codex",
          checkedAt: 1000,
          windows: [
            { label: "Short", usedPercent: 0.001 },
            { label: "Long", usedPercent: 99.999 },
          ],
        },
      ])
      .mockRejectedValueOnce(new Error("connection lost"));
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("<0.01%");
    expect(wrapper.text()).toContain(">99.99%");
    await wrapper.get(".agent-usage__refresh").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Could not read provider usage: connection lost");
    expect(wrapper.text()).not.toContain("Short");
    wrapper.unmount();
  });

  it("refreshes when a displayed quota window resets", async () => {
    readAgentUsage
      .mockResolvedValueOnce([
        {
          provider: "claude",
          checkedAt: Date.now(),
          windows: [{ label: "Session", usedPercent: 100, resetsAt: Date.now() + 1_000 }],
        },
      ])
      .mockResolvedValueOnce([]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_250);
    await flushPromises();
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it("announces exactly exhausted quota accessibly", async () => {
    readAgentUsage.mockResolvedValue([
      { provider: "codex", checkedAt: 1000, windows: [{ label: "Weekly", usedPercent: 100 }] },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Exhausted");
    expect(wrapper.get('[role="img"]').attributes("aria-label")).toContain("Limit reached — 100% used");
    expect(wrapper.get(".usage-card__pill").attributes("style")).toContain("--danger");
    wrapper.unmount();
  });

  it("front-loads a scoped pace recommendation and marks projected use on the bullet chart", async () => {
    const checkedAt = Date.now();
    readAgentUsage.mockResolvedValue([
      {
        provider: "codex",
        checkedAt,
        windows: [
          {
            label: "Weekly",
            scope: "Codex pool",
            usedPercent: 80,
            durationMinutes: 2 * 24 * 60,
            resetsAt: checkedAt + 24 * 60 * 60_000,
          },
        ],
      },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Codex pool · Weekly");
    expect(wrapper.text()).toContain("Slow down");
    expect(wrapper.get(".usage-card__pill").attributes("title")).toBe("Slow down on Codex (Codex pool)");
    expect(wrapper.text()).toContain("would run out");
    expect(wrapper.text()).toMatch(/At your pace \(.*\/hour\)/);
    expect(wrapper.text()).toContain("To last, keep to");
    expect(wrapper.text()).toContain("Pace estimates use the average since each window began.");
    expect(wrapper.text()).toMatch(/1d 0hUntil reset/);
    expect(wrapper.get('[role="img"]').attributes("aria-label")).toContain("Even pace now 50%");
    expect(wrapper.find(".usage-chart").exists()).toBe(true);
    expect(wrapper.text()).toContain("limit ~");
    expect(wrapper.text()).toContain("projected");
    wrapper.unmount();
  });

  it("does not invent a Gemini forecast", async () => {
    readAgentUsage.mockResolvedValue([
      {
        provider: "gemini",
        checkedAt: Date.now(),
        windows: [{ label: "Daily", usedPercent: 35, resetsAt: Date.now() + 3_600_000 }],
      },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Rounded usage from the selected local Gemini terminal.");
    expect(wrapper.text()).not.toContain("No active usage window is available.");
    expect(wrapper.text()).not.toContain("Forecast");
    expect(wrapper.find(".usage-meter__tick").exists()).toBe(false);
    expect(wrapper.find(".usage-chart").exists()).toBe(false);
    expect(wrapper.text()).toContain("≈35%");
    expect(wrapper.text()).toContain("Observed");
    expect(wrapper.get('[role="img"]').attributes("aria-label")).toContain("Even pace unavailable");
    wrapper.unmount();
  });

  it("routes the next task to an underused provider when the other unscoped quota is exhausted", async () => {
    const checkedAt = Date.now();
    readAgentUsage.mockResolvedValue([
      {
        provider: "claude",
        checkedAt,
        windows: [{ label: "Weekly", usedPercent: 100, resetsAt: checkedAt + 2 * 24 * 60 * 60_000 }],
      },
      {
        provider: "codex",
        checkedAt,
        windows: [
          {
            label: "Weekly",
            usedPercent: 2,
            durationMinutes: 7 * 24 * 60,
            resetsAt: checkedAt + 6 * 24 * 60 * 60_000,
          },
        ],
      },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.get(".agent-usage__next-task").text()).toContain("Use Codex for the next task");
    expect(wrapper.get(".agent-usage__next-task").text()).toContain("Claude Code Weekly quota is exhausted.");
    wrapper.unmount();
  });

  it("shows the remaining quota directly when a weekly window is less than an hour from reset", async () => {
    const checkedAt = Date.now();
    readAgentUsage.mockResolvedValue([
      {
        provider: "claude",
        checkedAt,
        windows: [
          {
            label: "Weekly",
            usedPercent: 65,
            durationMinutes: 7 * 24 * 60,
            resetsAt: checkedAt + 30 * 60_000,
          },
        ],
      },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Available until reset: 35% of quota.");
    expect(wrapper.text()).not.toContain("% of quota per day");
    wrapper.unmount();
  });

  it("shows Codex reset credits with advice and without any way to redeem them", async () => {
    const checkedAt = Date.now();
    const day = 24 * 60 * 60_000;
    readAgentUsage.mockResolvedValue([
      {
        provider: "codex",
        checkedAt,
        windows: [{ label: "Weekly", usedPercent: 42, durationMinutes: 7 * 24 * 60, resetsAt: checkedAt + 5.5 * day }],
        resetCredits: { available: 4, expiresAt: [checkedAt + 3.5 * day, checkedAt + 4.6 * day, checkedAt + 14 * day] },
      },
      {
        provider: "claude",
        checkedAt,
        windows: [{ label: "Weekly", usedPercent: 10, durationMinutes: 7 * 24 * 60, resetsAt: checkedAt + 5 * day }],
      },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    const credits = wrapper.findAll(".usage-resets");
    expect(credits).toHaveLength(1);
    expect(credits[0]?.text()).toContain("4 resets available");
    expect(credits[0]?.findAll(".usage-resets__token")).toHaveLength(4);
    expect(credits[0]?.findAll(".usage-resets__token--soon")).toHaveLength(2);
    expect(credits[0]?.text()).toContain("a reset is worth it then");
    expect(credits[0]?.text()).toContain("2 expire before this window resets");
    expect(credits[0]?.find("button").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows no reset block without available credits", async () => {
    const checkedAt = Date.now();
    readAgentUsage.mockResolvedValue([
      {
        provider: "codex",
        checkedAt,
        windows: [{ label: "Weekly", usedPercent: 42, durationMinutes: 7 * 24 * 60, resetsAt: checkedAt + 86_400_000 }],
        resetCredits: { available: 0, expiresAt: [] },
      },
    ]);
    const wrapper = mount(AgentUsagePanel);
    await flushPromises();
    expect(wrapper.find(".usage-resets").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows spinners only while a read is in flight", async () => {
    let resolveRead!: (_value: []) => void;
    readAgentUsage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const wrapper = mount(AgentUsagePanel);
    await nextTick();
    expect(wrapper.get(".agent-usage__empty").text()).toContain("Checking provider usage…");
    expect(wrapper.findAll(".spinner").length).toBe(2);
    expect(wrapper.get(".agent-usage__refresh").attributes("disabled")).toBeDefined();
    resolveRead([]);
    await flushPromises();
    expect(wrapper.find(".spinner").exists()).toBe(false);
    wrapper.unmount();
  });

  it("refreshes every five minutes while mounted and does not overlap an in-flight read", async () => {
    let resolveRead!: (_value: []) => void;
    readAgentUsage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const wrapper = mount(AgentUsagePanel);
    expect(readAgentUsage).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(readAgentUsage).toHaveBeenCalledTimes(1);
    resolveRead([]);
    await flushPromises();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
    // The read triggered on resume is pending; further interval ticks cannot overlap it.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(readAgentUsage).toHaveBeenCalledTimes(2);
  });
});
