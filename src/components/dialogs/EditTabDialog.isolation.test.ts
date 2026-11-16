import { describe, test, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import EditTabDialog from "./EditTabDialog.vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

function agentStatus(agents: Array<{ id: string; ok: boolean }>, platform = "linux") {
  return { platform, ready: true, prerequisites: [], agents, notes: [] };
}

async function mountDialog(props: Record<string, unknown>, status = agentStatus([{ id: "claude", ok: true }])) {
  const getSandboxStatus = vi.fn(async () => status);
  const wrapper = mount(EditTabDialog, {
    props: { mode: "new", title: "Tab", ...props },
    global: { provide: { [apiKey]: { getSandboxStatus } } },
  });
  await flushPromises();
  return { wrapper, getSandboxStatus };
}

const hintText = (wrapper: Awaited<ReturnType<typeof mountDialog>>["wrapper"]) =>
  wrapper.find("[data-testid='isolation-hint']").text();

describe("EditTabDialog isolation hints", () => {
  test("an agent tab of an isolated workspace says it runs isolated", async () => {
    const { wrapper } = await mountDialog({ workspaceIsolation: "isolated", command: "claude" });
    expect(hintText(wrapper)).toBe("Runs isolated (workspace setting).");
    expect(wrapper.find("[data-testid='isolation-hint']").classes()).not.toContain("warning-box");
    expect(wrapper.find("[data-testid='sandbox-shell-option']").exists()).toBe(false);
  });

  test("Run in WSL, or a tab with its own launcher, warns that the tab runs without isolation", async () => {
    const { wrapper } = await mountDialog({ workspaceIsolation: "isolated", command: "claude" });
    await wrapper.get(".run-wsl-toggle input").setValue(true);
    expect(hintText(wrapper)).toContain("WITHOUT isolation");
    expect(wrapper.get("[data-testid='isolation-hint']").classes()).toContain("warning-box");
    wrapper.unmount();

    const custom = await mountDialog({
      mode: "edit",
      workspaceIsolation: "isolated",
      command: "claude",
      hasCustomLaunch: true,
    });
    expect(hintText(custom.wrapper)).toContain("WITHOUT isolation");
  });

  test("an agent whose CLI is missing where the sandbox runs is named in a warning", async () => {
    const { wrapper } = await mountDialog(
      { workspaceIsolation: "isolated", command: "codex" },
      agentStatus(
        [
          { id: "claude", ok: true },
          { id: "codex", ok: false },
        ],
        "win32",
      ),
    );
    const hint = hintText(wrapper);
    expect(hint).toContain("codex CLI was not found");
    expect(hint).toContain("inside WSL");
    expect(wrapper.get("[data-testid='isolation-hint']").classes()).toContain("warning-box");
  });

  test("an agent tab of a workspace that is not isolated gets a muted note", async () => {
    const { wrapper, getSandboxStatus } = await mountDialog({ workspaceIsolation: "plain", command: "claude" });
    expect(hintText(wrapper)).toBe("Agents in this workspace run without isolation.");
    expect(wrapper.get("[data-testid='isolation-hint']").classes()).not.toContain("warning-box");
    expect(getSandboxStatus).not.toHaveBeenCalled();
  });

  test("says nothing for a shell tab, for workspace kinds the dialog does not judge, or on a remote client", async () => {
    expect(
      (await mountDialog({ workspaceIsolation: "isolated", command: "npm test" })).wrapper
        .find("[data-testid='isolation-hint']")
        .exists(),
    ).toBe(false);
    expect(
      (await mountDialog({ workspaceIsolation: "n/a", command: "claude" })).wrapper
        .find("[data-testid='isolation-hint']")
        .exists(),
    ).toBe(false);
    useAppStore().isRemoteTransport = true;
    const remote = await mountDialog({ workspaceIsolation: "isolated", command: "claude" });
    expect(remote.wrapper.find("[data-testid='isolation-hint']").exists()).toBe(false);
    expect(remote.getSandboxStatus).not.toHaveBeenCalled();
  });
});

describe("EditTabDialog isolated shell option", () => {
  test("is offered for a plain local shell in an isolated workspace and submits the choice", async () => {
    const { wrapper } = await mountDialog({ workspaceIsolation: "isolated", command: "" });
    const box = wrapper.get("[data-testid='sandbox-shell-checkbox']");
    expect((box.element as HTMLInputElement).checked).toBe(false);
    await box.setValue(true);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sandboxShell: true });
  });

  test("is preselected from the tab and can be turned off", async () => {
    const { wrapper } = await mountDialog({
      mode: "edit",
      workspaceIsolation: "isolated",
      command: "",
      sandboxShell: true,
    });
    const box = wrapper.get("[data-testid='sandbox-shell-checkbox']");
    expect((box.element as HTMLInputElement).checked).toBe(true);
    await box.setValue(false);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sandboxShell: false });
  });

  test.each([
    ["a workspace that is not isolated", { workspaceIsolation: "plain", command: "" }],
    ["a workspace kind it does not apply to", { workspaceIsolation: "n/a", command: "" }],
    ["an agent command", { workspaceIsolation: "isolated", command: "claude" }],
    ["a tab with its own launcher", { workspaceIsolation: "isolated", command: "", hasCustomLaunch: true }],
  ])("is not offered for %s", async (_label, props) => {
    const { wrapper } = await mountDialog(props);
    expect(wrapper.find("[data-testid='sandbox-shell-option']").exists()).toBe(false);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sandboxShell: false });
  });

  test("is not offered on a remote client, and its stored value is sent back unchanged", async () => {
    useAppStore().isRemoteTransport = true;
    const { wrapper } = await mountDialog({
      mode: "edit",
      workspaceIsolation: "isolated",
      command: "",
      sandboxShell: true,
    });
    expect(wrapper.find("[data-testid='sandbox-shell-option']").exists()).toBe(false);
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sandboxShell: true });
  });

  test("a workspace that stopped being isolated keeps the tab's stored choice when the tab is saved", async () => {
    const { wrapper } = await mountDialog({
      mode: "edit",
      workspaceIsolation: "plain",
      command: "",
      sandboxShell: true,
    });
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")?.[0][0]).toMatchObject({ sandboxShell: true });
  });
});
