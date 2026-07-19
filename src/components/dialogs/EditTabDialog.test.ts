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
    // Shell mode is the WslCommandFields default — its single command input.
    await wrapper.find(".edit-tab-dialog__form input[placeholder='optional boot command']").setValue("htop");
    await wrapper.find("form").trigger("submit");
    const submitted = wrapper.emitted("submit");
    expect(submitted).toBeTruthy();
    expect(submitted![0][0]).toMatchObject({ title: "My Shell", command: "htop" });
  });

  test("switching to WSL mode and filling structured fields submits the generated wrapper command", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.find(".title-input").setValue("WSL tab");
    await wrapper.findAll('[role="tab"]')[3].trigger("click"); // 🐧 WSL (index 2/3 are the launch-mode toggle's Shell/WSL)
    // Structured WSL fields: distro / cwd / command live inside WslCommandFields.
    const distroInput = wrapper.find("input[placeholder*='Ubuntu-22.04']");
    const cmdInput = wrapper.find("input[placeholder='claude --dangerously-skip-permissions']");
    await distroInput.setValue("Ubuntu-22.04");
    await cmdInput.setValue("claude");
    await wrapper.find("form").trigger("submit");
    const submitted = wrapper.emitted("submit");
    expect(submitted![0][0]).toMatchObject({
      title: "WSL tab",
      command: `wsl -d Ubuntu-22.04 -- bash -lic "claude; exec bash"`,
    });
  });

  test("editing a WSL tab (preset wsl wrapper command) re-opens with structured fields pre-filled", async () => {
    const wrapper = mountDialog({
      mode: "edit",
      title: "Existing WSL tab",
      command: `wsl -d Ubuntu-22.04 -- bash -lic "cd /home/me && claude; exec bash"`,
    });
    await flushPromises();
    expect(wrapper.find('[aria-selected="true"]').text()).toContain("WSL");
    const cwdInput = wrapper.find("input[placeholder='/home/you']");
    expect((cwdInput.element as HTMLInputElement).value).toBe("/home/me");
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
