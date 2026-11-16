import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import WorkspaceSandboxSection from "./WorkspaceSandboxSection.vue";
import { apiKey } from "../../types/keys.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { SandboxStatus } from "../../../electron/shared/sandbox.js";

const missing: SandboxStatus = {
  platform: "linux",
  ready: false,
  prerequisites: [
    { id: "node", label: "Node.js", ok: true, installable: false },
    { id: "bubblewrap", label: "bubblewrap", ok: false, installable: true },
  ],
  notes: ["Agents run inside WSL2."],
  gateway: "available",
  agents: [],
};
const ready: SandboxStatus = {
  ...missing,
  ready: true,
  prerequisites: missing.prerequisites.map((item) => ({ ...item, ok: true })),
};

function mountSection(api: Record<string, unknown>, props: Record<string, unknown> = {}) {
  return mount(WorkspaceSandboxSection, {
    props: { locked: false, enabled: true, allowedDomains: [], ...props } as never,
    global: { provide: { [apiKey]: api } },
  });
}

describe("WorkspaceSandboxSection", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("says what isolation does not protect, and never calls it safe", async () => {
    const wrapper = mountSection({ getSandboxStatus: vi.fn(async () => ready) });
    await flushPromises();
    const text = wrapper.get('[data-testid="sandbox-not-protected"]').text();
    expect(text).toContain("workspace contents");
    expect(text).toContain("sign-in");
    expect(text).toContain("not a virtual machine");
    expect(wrapper.text().toLowerCase()).not.toMatch(/\bsafe\b|\bsecure\b/u);
  });

  test("shows the prerequisites and offers to install what is missing", async () => {
    const getSandboxStatus = vi.fn(async () => missing);
    const wrapper = mountSection({ getSandboxStatus });
    await flushPromises();
    expect(wrapper.get('[data-testid="sandbox-status"]').text()).toContain("bubblewrap");
    expect(wrapper.find('[data-testid="sandbox-ready"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sandbox-install"]').exists()).toBe(true);
  });

  test("installs only when the user presses the button, then shows the new status, the log and the manual commands", async () => {
    const installSandboxPrerequisites = vi.fn(async () => ({
      status: ready,
      log: ["> Install bubblewrap", "done"],
      manual: ["sudo apt-get install bubblewrap"],
      failed: false,
    }));
    const wrapper = mountSection({ getSandboxStatus: vi.fn(async () => missing), installSandboxPrerequisites });
    await flushPromises();
    expect(installSandboxPrerequisites).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="sandbox-install"]').trigger("click");
    await flushPromises();
    expect(installSandboxPrerequisites).toHaveBeenCalledTimes(1);
    expect(wrapper.get('[data-testid="sandbox-install-log"]').text()).toContain("Install bubblewrap");
    expect(wrapper.get('[data-testid="sandbox-manual"]').text()).toContain("sudo apt-get install bubblewrap");
    expect(wrapper.find('[data-testid="sandbox-ready"]').exists()).toBe(true);
  });

  test("a failed install reaches the user as an error toast", async () => {
    const wrapper = mountSection({
      getSandboxStatus: vi.fn(async () => missing),
      installSandboxPrerequisites: vi.fn(async () => {
        throw new Error("wsl.exe failed");
      }),
    });
    const showError = vi.spyOn(useNotificationStore(), "showError");
    await flushPromises();
    await wrapper.get('[data-testid="sandbox-install"]').trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalled();
  });

  test("a failed status check reaches the user as an error toast", async () => {
    const showError = vi.spyOn(useNotificationStore(), "showError");
    mountSection({
      getSandboxStatus: vi.fn(async () => {
        throw new Error("probe failed");
      }),
    });
    await flushPromises();
    expect(showError).toHaveBeenCalled();
  });

  test("checks the machine when isolation is switched on, not before", async () => {
    const getSandboxStatus = vi.fn(async () => ready);
    const wrapper = mountSection({ getSandboxStatus }, { enabled: false });
    await flushPromises();
    expect(getSandboxStatus).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="sandbox-checkbox"]').setValue(true);
    await flushPromises();
    expect(getSandboxStatus).toHaveBeenCalledTimes(1);
  });

  test("a remote client sees the switch disabled with a desktop-only hint and never asks the machine", async () => {
    const getSandboxStatus = vi.fn();
    const wrapper = mountSection({ getSandboxStatus }, { locked: true });
    await flushPromises();
    expect(wrapper.get('[data-testid="sandbox-checkbox"]').attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Desktop only");
    expect(wrapper.find('[data-testid="sandbox-status"]').exists()).toBe(false);
    expect(getSandboxStatus).not.toHaveBeenCalled();
  });

  test("lists the destinations allowed for the workspace and lets the desktop remove one", async () => {
    const wrapper = mountSection(
      { getSandboxStatus: vi.fn(async () => ready) },
      { allowedDomains: ["a.example.com", "b.example.com"] },
    );
    await flushPromises();
    expect(wrapper.get('[data-testid="sandbox-domains"]').text()).toContain("a.example.com");
    await wrapper.get('button[aria-label="Remove a.example.com"]').trigger("click");
    expect(wrapper.emitted("update:allowedDomains")?.[0]).toEqual([["b.example.com"]]);
  });

  test("on Windows, a workspace on a drive is told it is slower than one inside WSL", async () => {
    const win: SandboxStatus = { ...ready, platform: "win32" };
    const wrapper = mountSection({ getSandboxStatus: vi.fn(async () => win) }, { workspacePath: "C:/work/app" });
    await flushPromises();
    expect(wrapper.get('[data-testid="sandbox-slow-drive"]').text()).toContain("slower file system");
    const linux = mountSection({ getSandboxStatus: vi.fn(async () => ready) }, { workspacePath: "C:/work/app" });
    await flushPromises();
    expect(linux.find('[data-testid="sandbox-slow-drive"]').exists()).toBe(false);
  });

  test("offers to move a Windows-drive workspace into WSL: the picker starts in the distro's home and the choice replaces the path", async () => {
    const win: SandboxStatus = { ...ready, platform: "win32", wslHome: "\\\\wsl.localhost\\Ubuntu\\home\\me" };
    const wslFolder = "\\\\wsl.localhost\\Ubuntu\\home\\me\\app";
    const browseDirectory = vi.fn(async (_initial?: string) => wslFolder);
    const getSandboxStatus = vi.fn(async () => win);
    const wrapper = mountSection({ getSandboxStatus, browseDirectory }, { workspacePath: "C:/work/app" });
    await flushPromises();
    await wrapper.get('[data-testid="sandbox-choose-wsl"]').trigger("click");
    await flushPromises();
    expect(browseDirectory).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu\\home\\me");
    expect(wrapper.emitted("update:workspacePath")?.[0]).toEqual([wslFolder]);
    // The prerequisites are checked again, in the distro the new folder lives in, once the dialog has taken the path.
    await wrapper.setProps({ workspacePath: wslFolder } as never);
    await flushPromises();
    expect(getSandboxStatus).toHaveBeenLastCalledWith({ force: true, distro: "Ubuntu" });
  });

  test("refuses a folder outside WSL with a visible error, and changes nothing when the picker is cancelled", async () => {
    const win: SandboxStatus = { ...ready, platform: "win32" };
    const showError = vi.spyOn(useNotificationStore(), "showError");
    const browseDirectory = vi.fn(async () => "D:\\other");
    const wrapper = mountSection(
      { getSandboxStatus: vi.fn(async () => win), browseDirectory },
      { workspacePath: "C:/work/app" },
    );
    await flushPromises();
    await wrapper.get('[data-testid="sandbox-choose-wsl"]').trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("That folder is not inside WSL", expect.stringContaining("WSL"));
    expect(wrapper.emitted("update:workspacePath")).toBeUndefined();
    browseDirectory.mockResolvedValueOnce(null as never);
    await wrapper.get('[data-testid="sandbox-choose-wsl"]').trigger("click");
    await flushPromises();
    expect(wrapper.emitted("update:workspacePath")).toBeUndefined();
  });

  test("lists which agent CLIs were found, with the reason for one that was not", async () => {
    const status: SandboxStatus = {
      ...ready,
      agents: [
        { id: "claude", ok: true },
        {
          id: "gemini",
          ok: false,
          detail: "Installed on Windows only. Isolated tabs run inside WSL — install it there.",
        },
      ],
    };
    const wrapper = mountSection({ getSandboxStatus: vi.fn(async () => status) });
    await flushPromises();
    const text = wrapper.get('[data-testid="sandbox-agents"]').text();
    expect(text).toContain("✓ claude");
    expect(text).toContain("✗ gemini");
    expect(text).toContain("Installed on Windows only");
    expect(wrapper.find('[data-testid="sandbox-ready"]').exists()).toBe(true);
  });

  test("shows no agent list when none was probed", async () => {
    const wrapper = mountSection({ getSandboxStatus: vi.fn(async () => ready) });
    await flushPromises();
    expect(wrapper.find('[data-testid="sandbox-agents"]').exists()).toBe(false);
  });

  test("shows no WSL offer without a folder picker (a remote client)", async () => {
    const win: SandboxStatus = { ...ready, platform: "win32" };
    const wrapper = mountSection({ getSandboxStatus: vi.fn(async () => win) }, { workspacePath: "C:/work/app" });
    await flushPromises();
    expect(wrapper.find('[data-testid="sandbox-choose-wsl"]').exists()).toBe(false);
  });

  test("asks about, and installs into, the distro a WSL workspace lives in", async () => {
    const getSandboxStatus = vi.fn(async () => missing);
    const installSandboxPrerequisites = vi.fn(async () => ({ status: ready, log: [], manual: [], failed: false }));
    const wrapper = mountSection(
      { getSandboxStatus, installSandboxPrerequisites },
      { workspacePath: String.raw`\\wsl$\Debian\home\me\app` },
    );
    await flushPromises();
    expect(getSandboxStatus).toHaveBeenCalledWith({ force: false, distro: "Debian" });
    await wrapper.get('[data-testid="sandbox-install"]').trigger("click");
    await flushPromises();
    expect(installSandboxPrerequisites).toHaveBeenCalledWith({ distro: "Debian" });
  });
});
