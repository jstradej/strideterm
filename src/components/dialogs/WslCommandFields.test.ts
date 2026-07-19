import { describe, test, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import WslCommandFields from "./WslCommandFields.vue";

function mountFields(command = "", compact = false) {
  const onUpdate = vi.fn();
  const wrapper = mount(WslCommandFields, {
    props: { command, compact, "onUpdate:command": onUpdate },
  });
  return { wrapper, onUpdate };
}

function lastEmitted(onUpdate: ReturnType<typeof vi.fn>): string {
  return onUpdate.mock.calls[onUpdate.mock.calls.length - 1]?.[0];
}

describe("WslCommandFields", () => {
  test("opens in Shell mode for a plain command", async () => {
    const { wrapper } = mountFields("claude");
    await flushPromises();
    expect(wrapper.find('[aria-selected="true"]').text()).toContain("Shell");
    expect(wrapper.find(".wsl-grid").exists()).toBe(false);
  });

  test("auto-detects a full wsl wrapper command and opens in WSL mode with parsed fields", async () => {
    const { wrapper } = mountFields(`wsl -d Ubuntu-22.04 -- bash -lic "cd /home/me && claude; exec bash"`);
    await flushPromises();
    const inputs = wrapper.findAll("input");
    expect(wrapper.find('[aria-selected="true"]').text()).toContain("WSL");
    // Distro / cwd / command structured fields are seeded from the parsed wrapper.
    expect((inputs[0].element as HTMLInputElement).value).toBe("Ubuntu-22.04");
    expect((inputs[1].element as HTMLInputElement).value).toBe("/home/me");
    expect((inputs[2].element as HTMLInputElement).value).toBe("claude");
  });

  test("bare `wsl` command opens in WSL mode and preserves the original text in the preview", async () => {
    const { wrapper, onUpdate } = mountFields("wsl");
    await flushPromises();
    expect(wrapper.find('[aria-selected="true"]').text()).toContain("WSL");
    // Nothing filled in yet — buildWslCommand would return "", so the preview
    // must fall back to the override seeded from the original bare command.
    expect(lastEmitted(onUpdate)).toBe("wsl");
  });

  test("typing in Shell mode emits the effective command immediately", async () => {
    const { wrapper, onUpdate } = mountFields("");
    await flushPromises();
    await wrapper.find("input").setValue("codex --model gpt-5.5");
    expect(lastEmitted(onUpdate)).toBe("codex --model gpt-5.5");
  });

  test("filling structured WSL fields emits the generated wrapper", async () => {
    const { wrapper, onUpdate } = mountFields("");
    await flushPromises();
    await wrapper.findAll('[role="tab"]')[1].trigger("click"); // switch to WSL
    const inputs = wrapper.findAll("input");
    await inputs[0].setValue("Ubuntu-22.04"); // distro
    await inputs[2].setValue("claude"); // command
    expect(lastEmitted(onUpdate)).toBe(`wsl -d Ubuntu-22.04 -- bash -lic "claude; exec bash"`);
  });

  test("a manual edit to the generated-command preview survives switching back to Shell mode (drift fix)", async () => {
    // Before this extraction, PanelEditor had no override tracking at all: its
    // WSL->Shell toggle always recomputed from the structured fields, silently
    // discarding any manual edit made directly to the "Generated command"
    // preview. EditTabDialog already tracked this via generatedWslOverride;
    // the shared component now gives PanelEditor the same guarantee.
    const { wrapper, onUpdate } = mountFields("");
    await flushPromises();
    const tabs = wrapper.findAll('[role="tab"]');
    await tabs[1].trigger("click"); // Shell -> WSL
    const inputs = wrapper.findAll("input");
    await inputs[0].setValue("Ubuntu-22.04"); // distro
    await inputs[2].setValue("claude"); // command
    // Manually edit the generated-command preview (the last input) directly —
    // this diverges from what buildWslCommand(wsl) would produce.
    const preview = wrapper.find(".wsl-preview__code--input");
    await preview.setValue(`wsl -d Ubuntu-22.04 -- bash -lic "MANUALLY EDITED"`);
    // Switch to Shell: the shell field was never touched (still empty), so it
    // must pick up the override, not a fresh buildWslCommand() derivation.
    await tabs[0].trigger("click");
    expect(lastEmitted(onUpdate)).toBe(`wsl -d Ubuntu-22.04 -- bash -lic "MANUALLY EDITED"`);
  });

  test("compact prop adds the compact modifier class to the segmented control", () => {
    const { wrapper } = mountFields("", true);
    expect(wrapper.find(".segmented").classes()).toContain("segmented--compact");
  });

  test("does not add the compact modifier class by default", () => {
    const { wrapper } = mountFields("");
    expect(wrapper.find(".segmented").classes()).not.toContain("segmented--compact");
  });
});
