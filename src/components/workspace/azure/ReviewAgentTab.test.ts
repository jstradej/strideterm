/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.3: agent
 * prompt save/delete were fire-and-forget (save) or catch-less (delete), so a
 * failed write silently closed the edit dialog (discarding the user's edits)
 * or vanished as an unhandled rejection. Both now go through
 * notifications.runWithToast, which surfaces an error toast and reports
 * success/failure back to the caller.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const confirmInApp = vi.fn(async () => true);
const openDialog = vi.fn();
const closeDialog = vi.fn();
const saveAgentPrompt = vi.fn();
const deleteAgentPrompt = vi.fn();
const resetAgentPrompts = vi.fn();
let isRemoteTransport = false;

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({
    confirmInApp,
    openDialog,
    closeDialog,
    saveAgentPrompt,
    deleteAgentPrompt,
    resetAgentPrompts,
    copyText: vi.fn(),
    get isRemoteTransport() {
      return isRemoteTransport;
    },
  }),
}));
vi.mock("../../../stores/git-ui.js", () => ({
  useGitUiStore: () => ({ reviewSetAgentSubtab: vi.fn() }),
}));

import ReviewAgentTab from "./ReviewAgentTab.vue";
import { useNotificationStore } from "../../../stores/notifications.js";

const PROMPT = { promptId: "p1", title: "Review", description: "", template: "hello {prId}", isDefault: false };

function mountTab() {
  return mount(ReviewAgentTab, {
    props: {
      prKey: "pr-1",
      workspaceId: "ws-1",
      pullRequest: { id: 42, title: "Fix bug" },
      agentPrompts: [PROMPT],
      mcpCommandLine: "npx mcp",
      reviewUi: { agentSubTab: "prompts" },
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  confirmInApp.mockClear();
  openDialog.mockClear();
  closeDialog.mockClear();
  saveAgentPrompt.mockClear();
  deleteAgentPrompt.mockClear();
  resetAgentPrompts.mockClear();
  isRemoteTransport = false;
});

describe("ReviewAgentTab — agent prompt mutations surface failures instead of silently succeeding", () => {
  test("editAgentPrompt onSubmit: successful save closes the dialog", async () => {
    saveAgentPrompt.mockResolvedValueOnce(undefined);
    const wrapper = mountTab();
    const editBtn = wrapper.findAll("button").find((b) => b.text() === "✎")!;
    await editBtn.trigger("click");
    expect(openDialog).toHaveBeenCalled();
    const config = openDialog.mock.calls[0][1] as { onSubmit: (v: string) => Promise<void> };
    await config.onSubmit("edited body");

    expect(saveAgentPrompt).toHaveBeenCalledWith({
      promptId: "p1",
      title: "Review",
      description: "",
      template: "edited body",
    });
    expect(closeDialog).toHaveBeenCalled();
  });

  test("editAgentPrompt onSubmit: failed save keeps the dialog open and shows an error toast", async () => {
    saveAgentPrompt.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mountTab();
    const editBtn = wrapper.findAll("button").find((b) => b.text() === "✎")!;
    await editBtn.trigger("click");
    const config = openDialog.mock.calls[0][1] as { onSubmit: (v: string) => Promise<void> };

    await config.onSubmit("edited body");
    await flushPromises();

    expect(closeDialog).not.toHaveBeenCalled();
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Save prompt failed");
    expect(notifications.sessions[0].events[0].body).toBe("network down");
  });

  test("handleDeletePrompt: rejection is caught and surfaced as a toast, not an unhandled rejection", async () => {
    deleteAgentPrompt.mockRejectedValueOnce(new Error("locked"));
    const wrapper = mountTab();
    const deleteBtn = wrapper.findAll("button").find((b) => b.text() === "🗑")!;
    await deleteBtn.trigger("click");
    await flushPromises();

    expect(deleteAgentPrompt).toHaveBeenCalledWith("p1");
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Delete prompt failed");
  });

  test("handleResetPrompts: rejection after confirm is caught and surfaced as a toast", async () => {
    resetAgentPrompts.mockRejectedValueOnce(new Error("db busy"));
    const wrapper = mountTab();
    const resetBtn = wrapper.findAll("button").find((b) => b.text().includes("Reset to defaults"))!;
    await resetBtn.trigger("click");
    await flushPromises();

    expect(confirmInApp).toHaveBeenCalled();
    expect(resetAgentPrompts).toHaveBeenCalled();
    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Reset prompts failed");
  });

  test("edit and delete affordances are hidden on the remote transport (saveAgentPrompt/deleteAgentPrompt are desktop-only)", async () => {
    isRemoteTransport = true;
    const wrapper = mountTab();
    await flushPromises();

    expect(wrapper.findAll("button").find((b) => b.text() === "✎")).toBeUndefined();
    expect(wrapper.findAll("button").find((b) => b.text() === "🗑")).toBeUndefined();
    // Copy and reset-to-defaults stay available — copy is client-side and
    // reset has a real remote route.
    expect(wrapper.findAll("button").find((b) => b.text() === "📋")).toBeDefined();
    expect(wrapper.findAll("button").find((b) => b.text().includes("Reset to defaults"))).toBeDefined();
  });
});
