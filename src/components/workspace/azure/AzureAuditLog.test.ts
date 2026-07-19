import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AzureAuditLog from "./AzureAuditLog.vue";
import { useAppStore } from "../../../stores/app.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const EMPTY_STATS = { total: 0, successCount: 0, errorCount: 0, readCount: 0, writeCount: 0, avgDurationMs: 0 };

function mountLog(apiOverrides: Record<string, unknown> = {}) {
  const appStore = useAppStore();
  const api: AnyApi = {
    queryAzureAuditLog: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    getAzureAuditStats: vi.fn().mockResolvedValue(EMPTY_STATS),
    ...apiOverrides,
  };
  vi.spyOn(appStore, "getApi").mockReturnValue(api);
  const wrapper = mount(AzureAuditLog, {
    global: {
      stubs: { CustomSelect: true },
    },
  });
  return { wrapper, api };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

/**
 * Category A (code-review batch, 2026-07): loadEntries used to swallow a
 * failed query into an empty `entries` array, which rendered the literal
 * "No audit log entries for the selected period." message — actively wrong,
 * since it implies the query succeeded and simply found nothing.
 */
describe("AzureAuditLog — loadEntries surfaces a load failure", () => {
  it("renders a distinct failure message instead of the misleading empty-state copy", async () => {
    const { wrapper } = mountLog({
      queryAzureAuditLog: vi.fn().mockRejectedValue(new Error("query timed out")),
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain("No audit log entries for the selected period.");
    expect(wrapper.text()).toContain("query timed out");
  });

  it("a subsequent successful refresh clears the error and restores normal rendering", async () => {
    const queryAzureAuditLog = vi
      .fn()
      .mockRejectedValueOnce(new Error("query timed out"))
      .mockResolvedValueOnce({ entries: [], total: 0 });
    const { wrapper } = mountLog({ queryAzureAuditLog });
    await flushPromises();
    expect(wrapper.text()).toContain("query timed out");

    await wrapper.find("button.button--ghost").trigger("click"); // Refresh
    await flushPromises();

    expect(wrapper.text()).not.toContain("query timed out");
    expect(wrapper.text()).toContain("No audit log entries for the selected period.");
  });
});

/**
 * Category B (code-review batch, 2026-07): copyEntry did
 * `navigator.clipboard.writeText(...).catch(() => {})` with no failure
 * feedback — the button just silently stayed "Copy to clipboard".
 */
describe("AzureAuditLog — copyEntry feedback", () => {
  const ENTRY = {
    id: 1,
    timestamp: "2026-07-01T00:00:00.000Z",
    operation: "GET /repos",
    category: "read",
    method: "GET",
    statusCode: 200,
    success: true,
    durationMs: 42,
    userInitiated: true,
    project: "MyProject",
  };

  function mountWithEntry() {
    return mountLog({
      queryAzureAuditLog: vi.fn().mockResolvedValue({ entries: [ENTRY], total: 1 }),
    });
  }

  it("shows 'Copied!' on the row's button after a successful copy", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    const { wrapper } = mountWithEntry();
    await flushPromises();

    await wrapper.find(".azure-audit-log__row").trigger("click"); // expand detail row
    const copyBtn = wrapper.find(".azure-audit-log__copy-btn");
    expect(copyBtn.exists()).toBe(true);
    await copyBtn.trigger("click");
    await flushPromises();

    expect(copyBtn.text()).toBe("Copied!");
  });

  it("shows 'Failed' on the row's button when the clipboard write rejects", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    const { wrapper } = mountWithEntry();
    await flushPromises();

    await wrapper.find(".azure-audit-log__row").trigger("click");
    const copyBtn = wrapper.find(".azure-audit-log__copy-btn");
    await copyBtn.trigger("click");
    await flushPromises();

    expect(copyBtn.text()).toBe("Failed");
  });
});
