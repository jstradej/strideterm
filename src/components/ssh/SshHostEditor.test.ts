/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.9:
 * save() used to await sshStore.saveHost() with no busy/error tracking at
 * all — a rejection became an unhandled promise rejection with no feedback
 * to the user and no way to tell the Save action had failed. save() now
 * owns local busy/error state and shows the failure inline.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SshHostEditor from "./SshHostEditor.vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("SshHostEditor", () => {
  test("new host display name follows incremental host input", async () => {
    const saveHost = vi.fn(async () => ({}));
    useSshStore().saveHost = saveHost;
    const wrapper = mount(SshHostEditor);
    const hostInput = wrapper.get<HTMLInputElement>('input[placeholder="server.example.com or prod"]');
    const usernameInput = wrapper.get<HTMLInputElement>('.ssh-identity-fields input[placeholder="alice"]');
    const nameInput = wrapper.get<HTMLInputElement>('input[placeholder="Defaults to host or alias"]');

    await hostInput.setValue("m");
    expect(nameInput.element.value).toBe("m");
    await hostInput.setValue("mini.local");
    expect(nameInput.element.value).toBe("mini.local");
    await usernameInput.setValue("js");
    expect(nameInput.element.value).toBe("js@mini.local");
    await usernameInput.setValue("");
    expect(nameInput.element.value).toBe("mini.local");
    await hostInput.setValue("");
    expect(nameInput.element.value).toBe("");
    await hostInput.setValue("mini.local");
    await usernameInput.setValue("js");
    await wrapper
      .findAll(".ssh-host-editor__footer button")
      .find((button) => button.text() === "Save")!
      .trigger("click");
    await flushPromises();
    expect(saveHost).toHaveBeenCalledWith(expect.objectContaining({ host: "mini.local", name: "js@mini.local" }));

    wrapper.unmount();
  });

  test("new host keeps a manually entered display name as the address changes", async () => {
    const wrapper = mount(SshHostEditor);
    const hostInput = wrapper.get<HTMLInputElement>('input[placeholder="server.example.com or prod"]');
    const usernameInput = wrapper.get<HTMLInputElement>('.ssh-identity-fields input[placeholder="alice"]');
    const nameInput = wrapper.get<HTMLInputElement>('input[placeholder="Defaults to host or alias"]');

    await hostInput.setValue("mini.local");
    await nameInput.setValue("Home server");
    await usernameInput.setValue("js");
    await hostInput.setValue("mini.example.net");

    expect(nameInput.element.value).toBe("Home server");
    wrapper.unmount();
  });

  test("an explicit name matching the current suggestion still counts as manual", async () => {
    const wrapper = mount(SshHostEditor);
    const hostInput = wrapper.get<HTMLInputElement>('input[placeholder="server.example.com or prod"]');
    const nameInput = wrapper.get<HTMLInputElement>('input[placeholder="Defaults to host or alias"]');

    await hostInput.setValue("mini.local");
    await nameInput.setValue("mini.local");
    await hostInput.setValue("mini.example.net");

    expect(nameInput.element.value).toBe("mini.local");
    wrapper.unmount();
  });

  test("editing a saved host preserves its existing display name", async () => {
    const wrapper = mount(SshHostEditor, {
      props: {
        host: {
          id: "host-1",
          host: "mini.local",
          name: "Home server",
          auth: { methods: ["agent"] },
          advanced: { wsl: {} },
        } as never,
      },
    });
    const hostInput = wrapper.get<HTMLInputElement>('input[placeholder="server.example.com or prod"]');
    const nameInput = wrapper.get<HTMLInputElement>('input[placeholder="Defaults to host or alias"]');

    await hostInput.setValue("mini.example.net");

    expect(nameInput.element.value).toBe("Home server");
    wrapper.unmount();
  });

  test("embedded host actions stay beside the title with one Back action", async () => {
    const wrapper = mount(SshHostEditor, { props: { embedded: true } });
    expect(wrapper.get(".dialog__header").text()).toContain("Add host");
    expect(wrapper.get(".ssh-host-editor__heading-actions").text()).toContain("Back");
    expect(wrapper.get(".ssh-host-editor__heading-actions").text()).toContain("Test connection");
    expect(wrapper.get(".ssh-host-editor__heading-actions").text()).toContain("Save host");
    expect(wrapper.findAll(".ssh-host-editor__footer button")).toHaveLength(0);
    expect(
      wrapper.findAll(".ssh-host-editor__heading-actions button").filter((button) => button.text() === "Back"),
    ).toHaveLength(1);
    wrapper.unmount();
  });

  test("connection method help explains when to choose each client", async () => {
    const wrapper = mount(SshHostEditor);
    const help = wrapper.get('[aria-label="Connection method help"]');
    await help.trigger("focus");
    const tooltipId = help.attributes("aria-describedby");
    expect(tooltipId).toBeTruthy();
    const tooltip = document.getElementById(tooltipId!)!;
    expect(tooltip.textContent).toContain("Choose this when the ssh command, aliases or keys already work");
    expect(tooltip.textContent).toContain("Choose this to manage sign-in in strIDEterm");
    expect(tooltip.textContent).toContain(
      "Choose this when your SSH setup and keys live inside a Linux WSL distribution",
    );
    wrapper.unmount();
  });

  test("closes a clean new host draft immediately without a confirmation", async () => {
    const app = useAppStore();
    const confirmInApp = vi.spyOn(app, "confirmInApp");
    const wrapper = mount(SshHostEditor);
    expect(wrapper.find(".dialog__header button").exists()).toBe(false);
    await wrapper.get(".ssh-host-editor__footer button").trigger("click");
    expect(confirmInApp).not.toHaveBeenCalled();
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.unmount();
  });

  test("footer Cancel keeps a dirty host draft open when the discard confirmation is declined", async () => {
    const app = useAppStore();
    const confirmInApp = vi.spyOn(app, "confirmInApp").mockResolvedValue(false);
    const wrapper = mount(SshHostEditor);
    const hostInput = wrapper.get('input[placeholder="server.example.com or prod"]');
    await hostInput.setValue("unfinished.example.com");

    await wrapper.get(".ssh-host-editor__footer button").trigger("click");

    expect(confirmInApp).toHaveBeenCalledWith(
      expect.objectContaining({ cancelLabel: "Keep editing", confirmLabel: "Discard changes" }),
    );
    expect(wrapper.emitted("cancel")).toBeFalsy();
    expect((hostInput.element as HTMLInputElement).value).toBe("unfinished.example.com");
    wrapper.unmount();
  });

  test("opens a connection test with the unsaved host draft without saving it", async () => {
    const saveHost = vi.fn();
    const app = useAppStore();
    const openSubDialog = vi.spyOn(app, "openSubDialog");
    useSshStore().saveHost = saveHost;
    const wrapper = mount(SshHostEditor);
    await wrapper.get('input[placeholder="server.example.com or prod"]').setValue("test.example.com");
    await wrapper
      .findAll(".ssh-host-editor__footer button")
      .find((button) => button.text() === "Test connection")!
      .trigger("click");

    expect(saveHost).not.toHaveBeenCalled();
    expect(openSubDialog).toHaveBeenCalledWith(
      "SshConnectionTestDialog",
      expect.objectContaining({ draft: expect.objectContaining({ host: "test.example.com" }) }),
    );
    const props = openSubDialog.mock.calls[0][1] as { draft: Record<string, unknown> };
    expect((props.draft.advanced as Record<string, unknown>).command).toBeUndefined();
    wrapper.unmount();
  });

  test("on successful save: calls sshStore.saveHost and emits cancel (closes)", async () => {
    const saveHost = vi.fn(async () => {});
    const store = useSshStore();
    store.saveHost = saveHost;
    const app = useAppStore();
    const quickAddTemplateTab = vi.spyOn(app, "quickAddTemplateTab");

    const wrapper = mount(SshHostEditor);
    expect(wrapper.text()).not.toContain("Save & connect");
    await wrapper.get('input[placeholder="server.example.com or prod"]').setValue("server.example.com");
    await wrapper
      .findAll(".ssh-host-editor__footer button")
      .find((button) => button.text() === "Save")!
      .trigger("click");
    await flushPromises();

    expect(saveHost).toHaveBeenCalledTimes(1);
    expect(quickAddTemplateTab).not.toHaveBeenCalled();
    expect(wrapper.emitted("cancel")).toBeTruthy();
    // busy reset to false — Save button re-enabled and label restored.
    const saveBtn = wrapper.findAll(".ssh-host-editor__footer button").find((button) => button.text() === "Save")!;
    expect(saveBtn.text()).toBe("Save");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".dialog__error").exists()).toBe(false);
  });

  test("on rejected save: keeps the dialog open, resets busy, and shows the error inline", async () => {
    const store = useSshStore();
    store.saveHost = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const wrapper = mount(SshHostEditor);
    await wrapper.get('input[placeholder="server.example.com or prod"]').setValue("server.example.com");
    await wrapper
      .findAll(".ssh-host-editor__footer button")
      .find((button) => button.text() === "Save")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.emitted("cancel")).toBeFalsy();
    const saveBtn = wrapper.findAll(".ssh-host-editor__footer button").find((button) => button.text() === "Save")!;
    expect(saveBtn.text()).toBe("Save");
    expect(saveBtn.attributes("disabled")).toBeUndefined();
    expect(wrapper.find(".dialog__error-text").text()).toBe("connection refused");
  });
});
