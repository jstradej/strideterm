import { describe, test, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PanelEditor from "./PanelEditor.vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";

function makePanel(overrides: Partial<{ id: string; title: string; command: string }> = {}) {
  return { id: "panel-1", title: "Shell", command: "", shell: true, startup: "default", ...overrides };
}

describe("PanelEditor", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("adding a template panel emits update:panels with the new entry appended", async () => {
    const wrapper = mount(PanelEditor, { props: { panels: [makePanel()] } });
    await wrapper.find("button.template-btn").trigger("click"); // first built-in template
    const emitted = wrapper.emitted("update:panels");
    expect(emitted).toBeTruthy();
    const nextPanels = emitted![0][0] as Array<{ command: string }>;
    expect(nextPanels).toHaveLength(2);
  });

  test("removing a panel emits update:panels without that entry", async () => {
    const panels = [makePanel({ id: "a" }), makePanel({ id: "b" })];
    const wrapper = mount(PanelEditor, { props: { panels } });
    const removeButtons = wrapper.findAll("button").filter((b) => b.text() === "Remove");
    await removeButtons[0].trigger("click");
    const emitted = wrapper.emitted("update:panels");
    const nextPanels = emitted![0][0] as Array<{ id: string }>;
    expect(nextPanels.map((p) => p.id)).toEqual(["b"]);
  });

  test("picking a badge icon prefixes the panel title with it", async () => {
    const panels = [makePanel({ title: "Shell" })];
    const wrapper = mount(PanelEditor, { props: { panels } });
    await wrapper.find(".panel-icon-btn").trigger("click");
    const iconButtons = wrapper.findAll(".panel-icon-picker__btn");
    await iconButtons[0].trigger("click");
    // Direct nested-prop mutation (matches the existing panel.title/alertsForceOn convention).
    expect(panels[0].title.endsWith("Shell")).toBe(true);
    expect(panels[0].title.startsWith("Shell")).toBe(false);
  });

  test("filling WSL structured fields (via the shared WslCommandFields) updates panel.command", async () => {
    const panels = [makePanel()];
    const wrapper = mount(PanelEditor, { props: { panels } });
    await flushPromises();
    await wrapper.findAll('[role="tab"]')[1].trigger("click"); // Shell -> WSL
    await wrapper.find("input[placeholder*='Ubuntu-22.04']").setValue("Ubuntu-22.04");
    await wrapper.find("input[placeholder='claude --dangerously-skip-permissions']").setValue("claude");
    expect(panels[0].command).toBe(`wsl -d Ubuntu-22.04 -- bash -lic "claude; exec bash"`);
  });

  test("uses the compact segmented-control sizing (distinct from EditTabDialog's default)", () => {
    const wrapper = mount(PanelEditor, { props: { panels: [makePanel()] } });
    expect(wrapper.find(".segmented").classes()).toContain("segmented--compact");
  });

  test("offers no SSH button unless the workspace allows SSH tabs", () => {
    const wrapper = mount(PanelEditor, { props: { panels: [] } });
    expect(wrapper.find('[data-testid="panel-editor-ssh"]').exists()).toBe(false);
  });

  test("adds a tab bound to the picked saved SSH host", async () => {
    useSshStore().hosts = [{ id: "host-mini", host: "mini.local", name: "mini", username: "me" }] as never;
    const wrapper = mount(PanelEditor, { props: { panels: [], allowSsh: true } });
    await wrapper.find('[data-testid="panel-editor-ssh"]').trigger("click");
    const hostButton = wrapper.find('[data-testid="panel-editor-ssh-hosts"] button');
    expect(hostButton.attributes("title")).toContain("mini (me@mini.local)");
    await hostButton.trigger("click");
    const nextPanels = wrapper.emitted("update:panels")![0][0] as Array<Record<string, unknown>>;
    expect(nextPanels).toHaveLength(1);
    expect(nextPanels[0]).toMatchObject({
      title: "🔐 mini",
      command: "",
      launch: { kind: "ssh", sshHostId: "host-mini" },
    });
    expect(wrapper.find('[data-testid="panel-editor-ssh-hosts"]').exists()).toBe(false);
  });

  test("says where to add a host when none is saved", async () => {
    const ssh = useSshStore();
    ssh.load = async () => {};
    const wrapper = mount(PanelEditor, { props: { panels: [], allowSsh: true } });
    await wrapper.find('[data-testid="panel-editor-ssh"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="panel-editor-ssh-hosts"]').text()).toContain("Settings → SSH");
  });

  test("an SSH tab shows its host and an initial command field instead of the local command fields", async () => {
    useSshStore().hosts = [{ id: "host-mini", host: "mini.local", name: "mini" }] as never;
    const panels = [{ ...makePanel(), launch: { kind: "ssh", sshHostId: "host-mini" } }];
    const wrapper = mount(PanelEditor, { props: { panels, allowSsh: true } });
    expect(wrapper.find(".panel-card__ssh-host").text()).toContain("mini (mini.local)");
    expect(wrapper.find(".segmented").exists()).toBe(false);
    await wrapper.find("input[placeholder='e.g. claude']").setValue("claude");
    expect(panels[0].command).toBe("claude");
    await wrapper.find('[data-testid="panel-editor-remote-cwd"]').setValue("~/projects/app");
    expect(panels[0].launch).toEqual({ kind: "ssh", sshHostId: "host-mini", remoteCwd: "~/projects/app" });
  });

  function setPlatform(platform: string) {
    useAppStore().payload = { meta: { platform } } as never;
  }

  test("the WSL launch mode is offered only on Windows", async () => {
    setPlatform("darwin");
    const mac = mount(PanelEditor, { props: { panels: [makePanel()] } });
    expect(mac.find('[aria-label="Launch mode"]').exists()).toBe(false);

    setActivePinia(createPinia());
    setPlatform("win32");
    const win = mount(PanelEditor, { props: { panels: [makePanel()] } });
    expect(win.find('[aria-label="Launch mode"]').exists()).toBe(true);
  });

  test("outside Windows a tab that already holds a WSL command keeps the switch back to Shell", async () => {
    setPlatform("linux");
    const wrapper = mount(PanelEditor, {
      props: { panels: [makePanel({ command: 'wsl -- bash -lic "claude; exec bash"' })] },
    });
    expect(wrapper.find('[aria-label="Launch mode"]').exists()).toBe(true);
  });

  test("a Files tab explains itself instead of showing its internal command", async () => {
    setPlatform("darwin");
    const wrapper = mount(PanelEditor, { props: { panels: [makePanel({ title: "Files", command: "__files__" })] } });
    expect(wrapper.text()).toContain("Files tab");
    expect(wrapper.text()).not.toContain("Always notify");
    expect(wrapper.findAll("input").some((i) => (i.element as HTMLInputElement).value === "__files__")).toBe(false);
  });

  test("a browser tab edits its address, not a shell command", async () => {
    const panels = [makePanel({ title: "Browser", command: "https://example.test" })];
    const wrapper = mount(PanelEditor, { props: { panels } });
    expect(wrapper.find('[aria-label="Launch mode"]').exists()).toBe(false);
    const address = wrapper.find('input[placeholder="https://"]');
    await address.setValue("http://localhost:5173");
    expect(panels[0].command).toBe("http://localhost:5173");
  });

  test("template buttons describe what the added tab does", () => {
    const wrapper = mount(PanelEditor, { props: { panels: [] } });
    const titles = Object.fromEntries(
      wrapper.findAll("button.template-btn").map((b) => [b.text().replace(/^\S+\s/, ""), b.attributes("title")]),
    );
    expect(titles["Shell"]).toBe("Add a Shell tab with a plain shell.");
    expect(titles["Codex"]).toBe("Add a Codex tab that runs 'codex' when it starts.");
    expect(titles["Files"]).toBe("Add a Files tab that browses this workspace's folder.");
    expect(titles["Browser"]).toBe("Add a tab with strIDEterm's built-in browser.");
  });

  test("configured templates for another platform are not offered", () => {
    setPlatform("darwin");
    const wrapper = mount(PanelEditor, {
      props: {
        panels: [],
        tabTemplates: [
          { title: "PowerShell", command: "powershell", platforms: ["win32"] },
          { title: "Zsh", command: "zsh", platforms: ["darwin", "linux"] },
        ],
      },
    });
    const labels = wrapper.findAll("button.template-btn").map((b) => b.text());
    expect(labels.some((l) => l.includes("PowerShell"))).toBe(false);
    expect(labels.some((l) => l.includes("Zsh"))).toBe(true);
  });
});
