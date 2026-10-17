import { describe, test, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AgentProviderConfig from "./AgentProviderConfig.vue";
import CustomSelect from "../common/CustomSelect.vue";

const providerOptions = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex CLI" },
];

function mountConfig(role: "worker" | "judge", overrides: Record<string, unknown> = {}) {
  return mount(AgentProviderConfig, {
    props: {
      role,
      provider: { providerId: "claude", model: "sonnet", skipPermissions: true },
      panelCommand: "claude --model sonnet",
      commandOverride: false,
      providerOptions,
      ...overrides,
    },
  });
}

function lastEmitted<T>(wrapper: ReturnType<typeof mount>, event: string): T {
  const calls = wrapper.emitted(event);
  return calls![calls!.length - 1][0] as T;
}

describe("AgentProviderConfig", () => {
  test("worker role shows the Worker agent label", () => {
    const wrapper = mountConfig("worker");
    expect(wrapper.find(".agent-config-section__label").text()).toBe("Worker agent");
  });

  test("judge role shows the Judge agent label", () => {
    const wrapper = mountConfig("judge");
    expect(wrapper.find(".agent-config-section__label").text()).toBe("Judge agent");
  });

  test("toggling to advanced command emits the panel command built from the current provider picker state", async () => {
    const wrapper = mount(AgentProviderConfig, {
      props: {
        role: "worker",
        provider: { providerId: "gemini", model: "gemini-3-flash-preview", skipPermissions: true },
        panelCommand: "",
        commandOverride: false,
        providerOptions,
      },
    });
    await wrapper.find(".agent-config-section__advanced-btn").trigger("click");
    expect(lastEmitted<string>(wrapper, "update:panelCommand")).toBe("gemini --yolo -m gemini-3-flash-preview");
    expect(lastEmitted<boolean>(wrapper, "update:commandOverride")).toBe(true);
  });

  test("commandOverride=true renders the command input labeled for the role instead of the provider picker", () => {
    const wrapper = mountConfig("judge", { commandOverride: true });
    expect(wrapper.find(".agent-config-section").text()).toContain("Judge command");
    expect(wrapper.findComponent(CustomSelect).exists()).toBe(false);
  });

  test("changing provider auto-selects the role-suggested model and resets skipPermissions to the provider default", async () => {
    const wrapper = mount(AgentProviderConfig, {
      props: {
        role: "worker",
        provider: { providerId: "claude", model: "opus", skipPermissions: false },
        panelCommand: "",
        commandOverride: false,
        providerOptions,
      },
    });
    // Simulate the CustomSelect's own v-model update having already flowed
    // the new providerId into the prop (as it would synchronously in real
    // usage) before its @change handler fires.
    // setProps's typing is too strict on script-setup components; cast to
    // accept the prop name the component does take (see
    // TerminalSearchOverlay.test.ts for the same precedent).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper as any).setProps({ provider: { providerId: "codex", model: "opus", skipPermissions: false } });
    await wrapper.findComponent(CustomSelect).vm.$emit("change");
    // codex suggests no worker model, so the worker gets "Default" (Codex picks
    // its own recommended model); codex defaults to skipPermissions: true.
    const updated = lastEmitted<{ providerId: string; model: string; effort: string; skipPermissions: boolean }>(
      wrapper,
      "update:provider",
    );
    expect(updated.model).toBe("");
    expect(updated.effort).toBe("");
    expect(updated.skipPermissions).toBe(true);
  });

  // Both escape hatches are offered for every role, the attached Companion
  // included — how much rope to take is the user's decision.
  test("offers the skip-permissions checkbox and the custom-command hatch for the judge role", () => {
    const wrapper = mountConfig("judge");
    expect(wrapper.find(".agent-config-section__advanced-btn").exists()).toBe(true);
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Skip permission prompts");
  });

  test("judge role auto-selects the judge-suggested model on provider change", async () => {
    const wrapper = mount(AgentProviderConfig, {
      props: {
        role: "judge",
        provider: { providerId: "claude", model: "", skipPermissions: true },
        panelCommand: "",
        commandOverride: false,
        providerOptions,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper as any).setProps({ provider: { providerId: "codex", model: "", skipPermissions: true } });
    await wrapper.findComponent(CustomSelect).vm.$emit("change");
    const updated = lastEmitted<{ model: string; effort: string }>(wrapper, "update:provider");
    expect(updated.model).toBe("gpt-6.1-sol");
    expect(updated.effort).toBe("xhigh");
  });

  test("offers the provider's effort levels, and none for a CLI without an effort flag", async () => {
    const wrapper = mountConfig("judge", {
      provider: { providerId: "codex", model: "gpt-6.1-sol", effort: "xhigh", skipPermissions: true },
    });
    const selects = wrapper.findAllComponents(CustomSelect);
    expect(selects).toHaveLength(2);
    const effortSelect = selects[1];
    expect(effortSelect.props("modelValue")).toBe("xhigh");
    expect((effortSelect.props("options") as Array<{ value: string }>).map((o) => o.value)).toEqual([
      "",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    await effortSelect.vm.$emit("update:modelValue", "high");
    expect(lastEmitted<{ effort: string }>(wrapper, "update:provider").effort).toBe("high");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapper as any).setProps({ provider: { providerId: "gemini", model: "", skipPermissions: false } });
    expect(wrapper.findAllComponents(CustomSelect)).toHaveLength(1);
  });

  test("the custom-command prefill carries the effort flag", async () => {
    const wrapper = mountConfig("judge", {
      provider: { providerId: "codex", model: "gpt-6.1-sol", effort: "xhigh", skipPermissions: true },
    });
    await wrapper.find(".agent-config-section__advanced-btn").trigger("click");
    expect(lastEmitted<string>(wrapper, "update:panelCommand")).toBe(
      "codex --dangerously-bypass-approvals-and-sandbox -s danger-full-access --model gpt-6.1-sol -c model_reasoning_effort=xhigh",
    );
  });
});
