import { describe, test, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AgentProviderConfig from "./AgentProviderConfig.vue";
import CustomSelect from "../common/CustomSelect.vue";

const providerOptions = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex CLI" },
];

function mountConfig(role: "worker" | "judge", overrides: Record<string, unknown> = {}) {
  const provider = { providerId: "claude", model: "sonnet", skipPermissions: true };
  const panel = { command: "claude --model sonnet" };
  return mount(AgentProviderConfig, {
    props: {
      role,
      provider,
      panel,
      commandOverride: false,
      providerOptions,
      ...overrides,
    },
  });
}

describe("AgentProviderConfig", () => {
  test("worker role shows the Worker agent label and worker-suggested placeholder", () => {
    const wrapper = mountConfig("worker");
    expect(wrapper.find(".agent-config-section__label").text()).toBe("Worker agent");
  });

  test("judge role shows the Judge agent label", () => {
    const wrapper = mountConfig("judge");
    expect(wrapper.find(".agent-config-section__label").text()).toBe("Judge agent");
  });

  test("toggling to advanced command prefills the panel command from the current provider picker state, then shows the command input", async () => {
    const panel = { command: "" };
    const provider = { providerId: "gemini", model: "gemini-3-flash-preview", skipPermissions: true };
    const wrapper = mount(AgentProviderConfig, {
      props: { role: "worker", provider, panel, commandOverride: false, providerOptions },
    });
    await wrapper.find(".agent-config-section__advanced-btn").trigger("click");
    expect(panel.command).toBe("gemini --yolo -m gemini-3-flash-preview");
    expect(wrapper.emitted("update:commandOverride")![0]).toEqual([true]);
  });

  test("commandOverride=true renders the command input labeled for the role instead of the provider picker", () => {
    const wrapper = mountConfig("judge", { commandOverride: true });
    expect(wrapper.find(".agent-config-section").text()).toContain("Judge command");
    expect(wrapper.findComponent(CustomSelect).exists()).toBe(false);
  });

  test("changing provider auto-selects the role-suggested model and resets skipPermissions to the provider default", async () => {
    const provider = { providerId: "claude", model: "opus", skipPermissions: false };
    const wrapper = mount(AgentProviderConfig, {
      props: { role: "worker", provider, panel: { command: "" }, commandOverride: false, providerOptions },
    });
    const select = wrapper.findComponent(CustomSelect);
    provider.providerId = "codex";
    await select.vm.$emit("change");
    // codex's worker-suggested model is gpt-5.5 (see PROVIDER_CHOICES), and
    // codex defaults to skipPermissions: true.
    expect(provider.model).toBe("gpt-5.5");
    expect(provider.skipPermissions).toBe(true);
  });

  test("judge role auto-selects the judge-suggested model on provider change", async () => {
    const provider = { providerId: "claude", model: "", skipPermissions: true };
    const wrapper = mount(AgentProviderConfig, {
      props: { role: "judge", provider, panel: { command: "" }, commandOverride: false, providerOptions },
    });
    const select = wrapper.findComponent(CustomSelect);
    provider.providerId = "codex";
    await select.vm.$emit("change");
    expect(provider.model).toBe("gpt-5.6-sol");
  });
});
