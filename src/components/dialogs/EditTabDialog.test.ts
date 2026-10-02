import { describe, test, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import EditTabDialog from "./EditTabDialog.vue";

beforeEach(() => {
  setActivePinia(createPinia());
});

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(EditTabDialog, { props });
}

describe("EditTabDialog", () => {
  test("new local shell tab: typing a plain command and submitting emits it verbatim", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.find(".title-input").setValue("My Shell");
    // The default command field stays visible outside Advanced.
    await wrapper.find(".edit-tab-dialog__form input[placeholder='optional boot command']").setValue("htop");
    await wrapper.find("form").trigger("submit");
    const submitted = wrapper.emitted("submit");
    expect(submitted).toBeTruthy();
    expect(submitted![0][0]).toMatchObject({ title: "My Shell", command: "htop" });
  });

  test("Advanced has the WSL checkbox while the basic command stays visible", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.find(".title-input").setValue("WSL tab");
    (wrapper.find(".advanced-options").element as HTMLDetailsElement).open = true;
    await wrapper.find(".advanced-options").element.dispatchEvent(new Event("toggle"));
    await flushPromises();
    expect(wrapper.find(".advanced-options").attributes("open")).toBeDefined();
    expect(wrapper.text()).toContain("SSH");
    expect(wrapper.text()).toContain("Run in WSL");
    expect(wrapper.findAll('[aria-label="Launch mode"]')).toHaveLength(0);
    expect(wrapper.find("input[placeholder='optional boot command']").exists()).toBe(true);
    expect(wrapper.find(".advanced-options .run-wsl-toggle input").exists()).toBe(true);
  });

  test("selecting WSL wraps the basic command only when submitting", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.find(".title-input").setValue("WSL tab");
    const basicCommand = wrapper.find("input[placeholder='optional boot command']");
    await basicCommand.setValue("claude");
    expect((basicCommand.element as HTMLInputElement).value).toBe("claude");
    (wrapper.find(".advanced-options").element as HTMLDetailsElement).open = true;
    await wrapper.find(".advanced-options").element.dispatchEvent(new Event("toggle"));
    await wrapper.find(".run-wsl-toggle input").setValue(true);
    await wrapper.find("input[placeholder='/home/you']").setValue("/home/me");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")![0][0]).toMatchObject({
      command: 'wsl -- bash -lic "cd /home/me && claude; exec bash"',
    });
  });

  test("turning WSL off submits the preserved inner command", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.find(".title-input").setValue("Shell tab");
    const basicCommand = wrapper.find("input[placeholder='optional boot command']");
    await basicCommand.setValue("npm run dev");
    (wrapper.find(".advanced-options").element as HTMLDetailsElement).open = true;
    await wrapper.find(".advanced-options").element.dispatchEvent(new Event("toggle"));
    const toggle = wrapper.find(".run-wsl-toggle input");
    await toggle.setValue(true);
    await wrapper.find("input[placeholder='/home/you']").setValue("/work");
    await toggle.setValue(false);
    expect((basicCommand.element as HTMLInputElement).value).toBe("npm run dev");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")![0][0]).toMatchObject({ command: "npm run dev" });
  });

  test("an empty command still opens a WSL shell", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.find(".title-input").setValue("WSL shell");
    (wrapper.find(".advanced-options").element as HTMLDetailsElement).open = true;
    await wrapper.find(".advanced-options").element.dispatchEvent(new Event("toggle"));
    await wrapper.find(".run-wsl-toggle input").setValue(true);
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")![0][0]).toMatchObject({ command: 'wsl -- bash -lic "exec bash"' });
  });

  test("editing a WSL tab (preset wsl wrapper command) re-opens with structured fields pre-filled", async () => {
    const wrapper = mountDialog({
      mode: "edit",
      title: "Existing WSL tab",
      command: `wsl -d Ubuntu-22.04 -- bash -lic "cd /home/me && claude; exec bash"`,
    });
    await flushPromises();
    expect(wrapper.find(".launch-environment-field").exists()).toBe(false);
    expect((wrapper.find("input[placeholder='optional boot command']").element as HTMLInputElement).value).toBe(
      "claude",
    );
    const cwdInput = wrapper.find("input[placeholder='/home/you']");
    expect((cwdInput.element as HTMLInputElement).value).toBe("/home/me");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")![0][0]).toMatchObject({
      command: `wsl -d Ubuntu-22.04 -- bash -lic "cd /home/me && claude; exec bash"`,
    });
  });

  test("unsupported raw WSL presets remain intact and do not show misleading fields", async () => {
    const raw = "wsl --distribution Ubuntu --user root -- bash -lc 'custom setup'";
    const wrapper = mountDialog({ mode: "edit", title: "Custom WSL", command: raw });
    await flushPromises();
    expect((wrapper.find("input[placeholder='optional boot command']").element as HTMLInputElement).value).toBe(raw);
    expect(wrapper.find(".advanced-fields").exists()).toBe(false);
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")![0][0]).toMatchObject({ command: raw });
  });

  test("authentication help opens on focus and hover, then Escape dismisses it", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.findAll('[role="tab"]')[1].trigger("click");
    await wrapper.findAll('[role="tab"]')[1].trigger("click");
    const help = wrapper.find(".auth-help");
    const tooltip = wrapper.find('[role="tooltip"]');
    expect(help.attributes("aria-describedby")).toBe(tooltip.attributes("id"));
    await help.trigger("focus");
    expect((tooltip.element as HTMLElement).style.display).not.toBe("none");
    await help.trigger("keydown.esc");
    expect((tooltip.element as HTMLElement).style.display).toBe("none");
    await help.trigger("mouseenter");
    expect((tooltip.element as HTMLElement).style.display).not.toBe("none");
  });

  test("icon picker replaces the leading emoji in the title", async () => {
    const wrapper = mountDialog({ mode: "new", title: "\u{1F4BB} Shell" });
    await flushPromises();
    await wrapper.find(".icon-btn").trigger("click");
    const iconButtons = wrapper.findAll(".icon-picker__btn");
    await iconButtons[0].trigger("click"); // first BADGE_ICONS entry
    const titleInput = wrapper.find(".title-input").element as HTMLInputElement;
    expect(titleInput.value.startsWith("Shell")).toBe(false);
    expect(titleInput.value.endsWith("Shell")).toBe(true);
  });

  test("toggling from Local to SSH clears the command field", async () => {
    const wrapper = mountDialog({ mode: "new", command: "htop" });
    await flushPromises();
    const sshTab = wrapper.findAll('[role="tab"]')[1];
    await sshTab.trigger("click");
    expect(wrapper.find(".edit-tab-dialog__form").text()).not.toContain("htop");
  });
});
