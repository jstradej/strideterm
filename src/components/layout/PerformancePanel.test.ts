import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import PerformancePanel from "./PerformancePanel.vue";
import type { PerformanceSnapshot } from "../../../electron/shared/performance.js";
import type { TerminalDiagnosticsSnapshot } from "../../app/terminal-controller.js";

const {
  getPerformanceSnapshot,
  captureRendererCpuProfile,
  revealCpuProfile,
  setTerminalDiagnosticsEnabled,
  getTerminalDiagnostics,
  showError,
  downloadSpy,
} = vi.hoisted(() => ({
  getPerformanceSnapshot: vi.fn(),
  captureRendererCpuProfile: vi.fn(),
  revealCpuProfile: vi.fn(),
  setTerminalDiagnosticsEnabled: vi.fn(),
  getTerminalDiagnostics: vi.fn(),
  showError: vi.fn(),
  downloadSpy: vi.fn(),
}));

vi.mock("../../stores/app.js", () => ({
  useAppStore: () => ({ getPerformanceSnapshot, captureRendererCpuProfile, revealCpuProfile }),
}));
vi.mock("../../stores/terminal.js", () => ({
  useTerminalStore: () => ({ setTerminalDiagnosticsEnabled, getTerminalDiagnostics }),
}));
vi.mock("../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError }),
}));
vi.mock("../../app/helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/helpers.js")>()),
  downloadTextFile: downloadSpy,
}));

function snapshot(overrides: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
  return {
    sampledAt: 1,
    intervalMs: 2000,
    warmingUp: false,
    currentRendererPid: 10,
    totalCpuPercent: 42,
    totalWorkingSetKb: 512 * 1024,
    systemMemory: { totalKb: 16 * 1024 * 1024, freeKb: 8 * 1024 * 1024 },
    processes: [
      { pid: 10, type: "Tab", creationTime: 5, cpuPercent: 20, workingSetKb: 200 * 1024, isCurrentRenderer: true },
      { pid: 2, type: "GPU", creationTime: 6, cpuPercent: 15, workingSetKb: 120 * 1024, isCurrentRenderer: false },
      { pid: 1, type: "Browser", creationTime: 4, cpuPercent: 7, workingSetKb: 192 * 1024, isCurrentRenderer: false },
    ],
    ...overrides,
  };
}

function termDiag(overrides: Partial<TerminalDiagnosticsSnapshot> = {}): TerminalDiagnosticsSnapshot {
  return {
    enabled: true,
    sampledAt: 1,
    intervalMs: 2000,
    dataChunks: 10,
    dataBytes: 2048,
    renderEvents: 8,
    renderedRows: 40,
    resizeCallbacks: 3,
    resizeChanges: 1,
    fullRefreshes: 2,
    webglAttachFailures: 0,
    webglContextLosses: 0,
    webglFallbacks: 0,
    liveViews: 2,
    webglRenderers: 2,
    domRenderers: 0,
    topSessions: [{ sessionId: "workspace-1:panel-1", dataChunks: 8, dataBytes: 2000, renderEvents: 6 }],
    ...overrides,
  };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.clearAllMocks();
  setVisibility("visible");
  window.localStorage.clear();
  getPerformanceSnapshot.mockResolvedValue(snapshot());
  getTerminalDiagnostics.mockReturnValue(termDiag());
  captureRendererCpuProfile.mockResolvedValue({ ok: true, path: "/logs/x.cpuprofile", durationMs: 6000 });
  revealCpuProfile.mockResolvedValue({ ok: true });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PerformancePanel", () => {
  it("enables terminal diagnostics and fetches a snapshot on mount", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    expect(setTerminalDiagnosticsEnabled).toHaveBeenCalledWith(true);
    expect(getPerformanceSnapshot).toHaveBeenCalled();
    // Renders the four summary cards + three sparkline charts.
    expect(wrapper.findAll(".perf__card").length).toBe(4);
    expect(wrapper.findAll(".sparkline").length).toBe(3);
    expect(wrapper.text()).toContain("this window");
    wrapper.unmount();
  });

  it("marks the current renderer and sorts processes by CPU (from the sampler)", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    const rows = wrapper.findAll(".perf__table tbody tr");
    expect(rows.length).toBe(3);
    // First row is the highest-CPU process and is flagged as the current window.
    expect(rows[0].classes()).toContain("perf__row--current");
    expect(rows[0].text()).toContain("this window");
    wrapper.unmount();
  });

  it("shows a warming-up notice on the first sample", async () => {
    getPerformanceSnapshot.mockResolvedValue(snapshot({ warmingUp: true, intervalMs: null }));
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    expect(wrapper.text()).toContain("Warming up");
    wrapper.unmount();
  });

  it("stops the timer and disables diagnostics on unmount", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    setTerminalDiagnosticsEnabled.mockClear();
    wrapper.unmount();
    expect(setTerminalDiagnosticsEnabled).toHaveBeenCalledWith(false);
  });

  it("pausing stops diagnostics; resuming re-enables them", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    const pauseBtn = wrapper.findAll(".perf__btn").find((b) => b.text() === "Pause")!;
    await pauseBtn.trigger("click");
    expect(setTerminalDiagnosticsEnabled).toHaveBeenLastCalledWith(false);
    expect(wrapper.text()).toContain("Paused");
    const resumeBtn = wrapper.findAll(".perf__btn").find((b) => b.text() === "Resume")!;
    await resumeBtn.trigger("click");
    expect(setTerminalDiagnosticsEnabled).toHaveBeenLastCalledWith(true);
    wrapper.unmount();
  });

  it("pauses polling when the document becomes hidden", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    setTerminalDiagnosticsEnabled.mockClear();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(setTerminalDiagnosticsEnabled).toHaveBeenCalledWith(false);
    wrapper.unmount();
  });

  it("caps the history at 150 samples", async () => {
    vi.useFakeTimers();
    const wrapper = mount(PerformancePanel);
    for (let i = 0; i < 160; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(wrapper.text()).toContain("150/150");
    wrapper.unmount();
  });

  it("changing the refresh interval persists it", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    await wrapper.find(".perf__select").setValue("5000");
    expect(window.localStorage.getItem("strideterm-perf-refresh-ms")).toBe("5000");
    expect(wrapper.text()).toContain("every 5s");
    wrapper.unmount();
  });

  it("capture button reports success and surfaces errors as a toast", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    const captureBtn = wrapper.findAll(".perf__btn").find((b) => b.text().includes("Capture"))!;
    await captureBtn.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("/logs/x.cpuprofile");

    captureRendererCpuProfile.mockResolvedValue({ ok: false, error: "DevTools attached" });
    await captureBtn.trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("CPU profile failed", "DevTools attached");
    wrapper.unmount();
  });

  it("reveals the saved profile in the OS file manager via the Open folder button", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    const captureBtn = wrapper.findAll(".perf__btn").find((b) => b.text().includes("Capture"))!;
    await captureBtn.trigger("click");
    await flushPromises();
    const openBtn = wrapper.findAll(".perf__btn").find((b) => b.text() === "Open folder");
    expect(openBtn).toBeTruthy();
    await openBtn!.trigger("click");
    expect(revealCpuProfile).toHaveBeenCalledWith("/logs/x.cpuprofile");
    wrapper.unmount();
  });

  it("exported diagnostics are JSON with no terminal content", async () => {
    const wrapper = mount(PerformancePanel);
    await flushPromises();
    const exportBtn = wrapper.findAll(".perf__btn").find((b) => b.text() === "Export")!;
    await exportBtn.trigger("click");
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    const [filename, content, mime] = downloadSpy.mock.calls[0];
    expect(filename).toMatch(/^strideterm-perf-.*\.json$/);
    expect(mime).toBe("application/json");
    const parsed = JSON.parse(content);
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(["generatedAt", "process", "terminal", "history"]));
    // Top sessions carry only ids + counters — never terminal output text.
    for (const s of parsed.terminal.topSessions) {
      expect(Object.keys(s).sort()).toEqual(["dataBytes", "dataChunks", "renderEvents", "sessionId"]);
    }
    wrapper.unmount();
  });
});
