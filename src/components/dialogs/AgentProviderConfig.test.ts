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
    // codex's worker-suggested model is gpt-5.6-terra (see PROVIDER_CHOICES),
    // and codex defaults to skipPermissions: true.
    const updated = lastEmitted<{ providerId: string; model: string; skipPermissions: boolean }>(
      wrapper,
      "update:provider",
    );
    expect(updated.model).toBe("gpt-5.6-terra");
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
    const updated = lastEmitted<{ model: string }>(wrapper, "update:provider");
    expect(updated.model).toBe("gpt-5.6-sol");
  });
});
