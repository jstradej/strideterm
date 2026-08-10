import { describe, expect, test, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CompanionAgentDialog from "./CompanionAgentDialog.vue";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

function setSourcePayload(panelCommand: string) {
  const store = useAppStore();
  store.payload = {
    appState: {
      workspaces: [
        {
          id: "ws-source",
          name: "My Project",
          kind: "manual",
          cwd: "/repo",
          profileId: "default",
          panels: [{ id: "panel-source", title: "Claude", command: panelCommand, cwd: "/repo" }],
        },
      ],
      settings: { taskDefaults: { judgeProvider: { providerId: "codex", model: "gpt-5.6-sol" } } },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return store;
}

function mountDialog(sourceSessionId = "ws-source:panel-source", extraProps: Record<string, unknown> = {}) {
  return mount(CompanionAgentDialog, {
    props: { sourceSessionId, onCancel: vi.fn(), ...extraProps },
  });
}

describe("CompanionAgentDialog", () => {
  test("defaults to the Reviewer role and never silently pre-selects Planner", () => {
    setSourcePayload("claude");
    const wrapper = mountDialog();
    const selected = wrapper.find(".companion-dialog__role-card--selected");
    expect(selected.text()).toContain("Reviewer");
  });

  test("a known agent command (claude) never shows the primary-provider confirm field", () => {
    setSourcePayload("claude --dangerously-skip-permissions --model sonnet");
    const wrapper = mountDialog();
    expect(wrapper.find(".companion-dialog__confirm-primary").exists()).toBe(false);
    expect(wrapper.text()).toContain("Claude Code");
  });

  test("an unclear shell command requires an explicit confirm and disables submit until chosen", async () => {
    setSourcePayload("bash");
    const wrapper = mountDialog();
    expect(wrapper.find(".companion-dialog__confirm-primary").exists()).toBe(true);
    const submitBtn = wrapper.find('button[type="submit"]');
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(true);
    expect(wrapper.text()).toContain("Unknown agent");
  });

  test("selecting a different role card updates the selection", async () => {
    setSourcePayload("claude");
    const wrapper = mountDialog();
    const cards = wrapper.findAll(".companion-dialog__role-card");
    const criticCard = cards.find((c) => c.text().includes("Critic"))!;
    await criticCard.trigger("click");
    expect(criticCard.classes()).toContain("companion-dialog__role-card--selected");
  });

  test("shows a 'recommended' badge on Planner when the focus mentions plan/design, without auto-selecting it", async () => {
    setSourcePayload("claude");
    const wrapper = mountDialog();
    await wrapper.find("textarea").setValue("Please review my plan document carefully.");
    const plannerCard = wrapper.findAll(".companion-dialog__role-card").find((c) => c.text().includes("Planner"))!;
    expect(plannerCard.text()).toContain("recommended");
    expect(plannerCard.classes()).not.toContain("companion-dialog__role-card--selected");
  });

  test("submits the expected payload shape, always forcing skipPermissions:false on the companion provider", async () => {
    setSourcePayload("claude");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountDialog("ws-source:panel-source", { onSubmit });
    await wrapper.find("textarea").setValue("Pay attention to X.");
    await wrapper.find("form").trigger("submit");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.sourceSessionId).toBe("ws-source:panel-source");
    expect(payload.companionRole).toBe("reviewer");
    expect(payload.focus).toBe("Pay attention to X.");
    expect(payload.companionProvider.skipPermissions).toBe(false);
    expect(payload.primaryProvider).toEqual({ providerId: "claude", model: "sonnet" });
  });

  test("a backend rejection keeps the dialog open and shows the inline error banner", async () => {
    setSourcePayload("claude");
    const onSubmit = vi.fn().mockRejectedValue(new Error("Another task agent is currently running"));
    const wrapper = mountDialog("ws-source:panel-source", { onSubmit });
    await wrapper.find("form").trigger("submit");
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapper.find(".dialog__error").exists()).toBe(true);
    expect(wrapper.text()).toContain("Another task agent is currently running");
    // Dialog itself doesn't unmount/emit cancel on failure — focus text stays.
    expect(wrapper.emitted("cancel")).toBeUndefined();
  });

  test("the companion provider picker never exposes skip-permissions or a custom-command escape hatch", () => {
    setSourcePayload("claude");
    const wrapper = mountDialog();
    expect(wrapper.text()).not.toContain("Skip permission prompts");
    expect(wrapper.text()).not.toContain("Advanced: custom command");
    expect(wrapper.text()).toContain("Inspect only");
  });
});
