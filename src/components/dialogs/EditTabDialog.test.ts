import { describe, test, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import EditTabDialog from "./EditTabDialog.vue";
import { useAppStore } from "../../stores/app.js";
import { useSshStore } from "../../stores/ssh.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(EditTabDialog, { props });
}

describe("EditTabDialog", () => {
  test("an untouched new tab closes without a discard prompt", async () => {
    const app = useAppStore();
    const confirm = vi.spyOn(app, "confirmInApp");
    const wrapper = mountDialog({ mode: "new", title: "💻 Shell" });
    await flushPromises();
    await wrapper.get("button.button--ghost").trigger("click");
    expect(confirm).not.toHaveBeenCalled();
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  test("the initial snapshot is captured before SSH-store loading and does not swallow edits made while loading", async () => {
    const app = useAppStore();
    const confirm = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    let finishLoad!: () => void;
    vi.spyOn(useSshStore(), "load").mockReturnValue(new Promise<void>((resolve) => (finishLoad = resolve)));
    const wrapper = mountDialog({ mode: "new", title: "💻 Shell" });
    await wrapper.get(".title-input").setValue("Edited during load");
    await wrapper.get("button.button--ghost").trigger("click");
    expect(confirm).toHaveBeenCalledTimes(1);
    finishLoad();
    await flushPromises();
  });

  test("a changed value prompts on cancel, but reverting it closes without a prompt", async () => {
    const app = useAppStore();
    const confirm = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const wrapper = mountDialog({ mode: "new", title: "💻 Shell" });
    await flushPromises();
    const title = wrapper.get(".title-input");
    await title.setValue("Temporary");
    await title.setValue("💻 Shell");
    await wrapper.get("button.button--ghost").trigger("click");
    expect(confirm).not.toHaveBeenCalled();
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  test("cancel asks before discarding actual edits", async () => {
    const app = useAppStore();
    const confirm = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const wrapper = mountDialog({ mode: "new", title: "💻 Shell" });
    await flushPromises();
    await wrapper.get(".title-input").setValue("Changed shell");
    await wrapper.get("button.button--ghost").trigger("click");
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Discard unsaved tab changes?" }));
    expect(wrapper.emitted("cancel")).toBeFalsy();
  });

  test("SSH tools opt-in is available only for direct Claude/Codex local launches and submits its default-off value", async () => {
    const wrapper = mountDialog({ mode: "new", title: "Claude Code" });
    await flushPromises();
    const advanced = wrapper.get(".advanced-options");
    (advanced.element as HTMLDetailsElement).open = true;
    await advanced.trigger("toggle");
    const command = wrapper.get("input[placeholder='optional boot command']");
    await command.setValue("claude");
    expect(wrapper.text()).toContain("SSH tools for this tab");
    expect((wrapper.get(".ssh-tools-toggle input").element as HTMLInputElement).checked).toBe(false);
    expect((wrapper.get(".ssh-tools-toggle input").element as HTMLInputElement).disabled).toBe(false);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sshMcpEnabled: false });
    wrapper.unmount();

    const unsupported = mountDialog({ mode: "new", title: "Shell" });
    await flushPromises();
    (unsupported.get(".advanced-options").element as HTMLDetailsElement).open = true;
    await unsupported.get(".advanced-options").trigger("toggle");
    await unsupported.get("input[placeholder='optional boot command']").setValue("npm run dev");
    expect(unsupported.text()).toContain("SSH tools for this tab");
    expect((unsupported.get(".ssh-tools-toggle input").element as HTMLInputElement).disabled).toBe(true);
    expect(unsupported.text()).toContain("Set Command to claude or codex to enable SSH tools.");
  });

  test("SSH tools explain and disable the option for WSL and hide it in remote sessions", async () => {
    const local = mountDialog({ mode: "new", title: "Claude Code", command: "claude" });
    await flushPromises();
    (local.get(".advanced-options").element as HTMLDetailsElement).open = true;
    await local.get(".advanced-options").trigger("toggle");
    await local.get(".run-wsl-toggle input").setValue(true);
    expect((local.get(".ssh-tools-toggle input").element as HTMLInputElement).disabled).toBe(true);
    expect(local.text()).toContain("Available for local Claude Code / Codex tabs; WSL is not supported yet.");
    local.unmount();

    useAppStore().isRemoteTransport = true;
    const remote = mountDialog({ mode: "new", title: "Claude Code", command: "claude" });
    await flushPromises();
    (remote.get(".advanced-options").element as HTMLDetailsElement).open = true;
    await remote.get(".advanced-options").trigger("toggle");
    expect(remote.text()).not.toContain("SSH tools for this tab");
  });

  test("remote editing preserves an existing opt-in without exposing controls, and remote creation defaults off", async () => {
    const app = useAppStore();
    app.isRemoteTransport = true;
    const existing = mountDialog({ mode: "edit", title: "Claude Code", command: "claude", sshMcpEnabled: true });
    await flushPromises();
    expect(existing.text()).not.toContain("SSH tools for this tab");
    await existing.get(".title-input").setValue("Remote edit");
    await existing.get("form").trigger("submit");
    expect(existing.emitted("submit")?.[0][0]).toMatchObject({ sshMcpEnabled: true });

    const created = mountDialog({ mode: "new", title: "Claude Code", command: "claude" });
    await flushPromises();
    await created.get("form").trigger("submit");
    expect(created.text()).not.toContain("SSH tools for this tab");
    expect(created.emitted("submit")?.[0][0]).toMatchObject({ sshMcpEnabled: false });
  });

  test("SSH tools opt-in is submitted only when selected for a supported local launch", async () => {
    const wrapper = mountDialog({ mode: "new", title: "Claude Code" });
    await flushPromises();
    (wrapper.get(".advanced-options").element as HTMLDetailsElement).open = true;
    await wrapper.get(".advanced-options").trigger("toggle");
    await wrapper.get("input[placeholder='optional boot command']").setValue("codex --full-auto");
    await wrapper.get(".ssh-tools-toggle input").setValue(true);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sshMcpEnabled: true });
  });

  test("a checked opt-in blocks unsupported command changes until explicitly turned off", async () => {
    const wrapper = mountDialog({ mode: "edit", title: "Claude Code", command: "claude", sshMcpEnabled: true });
    await flushPromises();
    await wrapper.get("input[placeholder='optional boot command']").setValue("npm run dev");
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeFalsy();
    expect(wrapper.text()).toContain("SSH tools require a direct local Claude Code or Codex command.");

    await wrapper.get(".ssh-tools-toggle input").setValue(false);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sshMcpEnabled: false });
  });

  test("custom launch configuration explains why SSH tools are unavailable", async () => {
    const wrapper = mountDialog({ mode: "edit", title: "Claude Code", command: "claude", hasCustomLaunch: true });
    await flushPromises();
    (wrapper.get(".advanced-options").element as HTMLDetailsElement).open = true;
    await wrapper.get(".advanced-options").trigger("toggle");
    expect((wrapper.get(".ssh-tools-toggle input").element as HTMLInputElement).disabled).toBe(true);
    expect(wrapper.text()).toContain("Custom launch settings are not supported.");
  });

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

  test("quick-connect test uses current details, omits the startup command, and does not save a host", async () => {
    const app = useAppStore();
    const openSubDialog = vi.spyOn(app, "openSubDialog");
    const saveHost = vi.fn();
    useSshStore().saveHost = saveHost;
    const wrapper = mountDialog({ mode: "new", presetTabType: "ssh", presetSshMode: "quick" });
    await flushPromises();
    await wrapper.find('input[placeholder="bastion.example.com"]').setValue("test.example.com");
    await wrapper.find('input[placeholder="e.g. hostname"]').setValue("should-not-run");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");

    expect(saveHost).not.toHaveBeenCalled();
    expect(openSubDialog).toHaveBeenCalledWith(
      "SshConnectionTestDialog",
      expect.objectContaining({ draft: expect.objectContaining({ host: "test.example.com" }) }),
    );
    const props = openSubDialog.mock.calls[0][1] as { draft: Record<string, unknown> };
    expect((props.draft.advanced as Record<string, unknown>).command).toBeUndefined();
    expect(wrapper.emitted("cancel")).toBeFalsy();
    wrapper.unmount();
  });

  test("SSH target stays visible outside Advanced while local settings remain disclosed", async () => {
    const ssh = mountDialog({ mode: "new", presetTabType: "ssh", presetSshMode: "quick" });
    await flushPromises();
    expect(ssh.find(".ssh-connection-content").exists()).toBe(true);
    expect(ssh.find(".advanced-options").exists()).toBe(false);
    expect(ssh.find('input[placeholder="bastion.example.com"]').exists()).toBe(true);
    expect(ssh.find(".quick-advanced summary").text()).toBe("Advanced connection options");
    ssh.unmount();

    const local = mountDialog({ mode: "new" });
    await flushPromises();
    expect(local.find(".advanced-options summary").text()).toContain("Advanced");
    expect(local.find(".ssh-connection-content").exists()).toBe(false);
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

  test("connection method help opens on focus and click, then Escape dismisses it", async () => {
    const wrapper = mountDialog({ mode: "new" });
    await flushPromises();
    await wrapper.get('[aria-label="New tab type"] button:nth-child(2)').trigger("click");
    const help = wrapper.get('[aria-label="Connection method help"]');
    await help.trigger("focus");
    const describedBy = help.attributes("aria-describedby");
    if (!describedBy) throw new Error("Expected the help button to reference its tooltip");
    const tooltip = document.getElementById(describedBy)!;
    expect(tooltip.getAttribute("data-open")).toBe("true");
    await help.trigger("click");
    expect(tooltip.getAttribute("data-open")).toBe("true");
    await help.trigger("keydown", { key: "Escape" });
    expect(tooltip.getAttribute("data-open")).toBe("false");
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
    const sshTab = wrapper.get('[aria-label="New tab type"] button:nth-child(2)');
    await sshTab.trigger("click");
    expect(wrapper.find(".edit-tab-dialog__form").text()).not.toContain("htop");
  });
});
