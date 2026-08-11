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

  test("submits the expected payload shape", async () => {
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
    // Defaults to the provider's own setting (codex bypasses) so the loop runs
    // unattended out of the box — the checkbox is there to turn it off.
    expect(payload.companionProvider.skipPermissions).toBe(true);
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

  // Both escape hatches are the user's to use: whether the companion bypasses
  // permission prompts, and whether to launch a hand-written command instead of
  // the one built from the picker.
  test("the companion provider picker offers both skip-permissions and a custom command", () => {
    setSourcePayload("claude");
    const wrapper = mountDialog();
    expect(wrapper.text()).toContain("Skip permission prompts");
    expect(wrapper.text()).toContain("Advanced: custom command");
    expect(wrapper.text()).not.toContain("Inspect only");
  });

  // Regression: submit used to overwrite skipPermissions with false, so the
  // checkbox rendered but its value never reached the backend. Assert on the
  // submitted payload, not just on what the picker draws.
  test("submits the companion's permission choice instead of overwriting it", async () => {
    setSourcePayload("claude");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountDialog("ws-source:panel-source", { onSubmit });

    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.find("form").trigger("submit");

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        companionProvider: expect.objectContaining({ skipPermissions: true }),
      }),
    );
  });

  test("sends a custom command only while the override is on", async () => {
    setSourcePayload("claude");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountDialog("ws-source:panel-source", { onSubmit });

    await wrapper.find("form").trigger("submit");
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ companionCommand: undefined }));

    await wrapper.find(".agent-config-section__advanced-btn").trigger("click");
    await wrapper.find(".agent-config-section input[maxlength='500']").setValue("codex --my-flag");
    await wrapper.find("form").trigger("submit");

    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ companionCommand: "codex --my-flag" }));
  });
});
