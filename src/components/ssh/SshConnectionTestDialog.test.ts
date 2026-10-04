import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import SshConnectionTestDialog from "./SshConnectionTestDialog.vue";
import { useSshStore } from "../../stores/ssh.js";
import { useTerminalStore } from "../../stores/terminal.js";
import { useAppStore } from "../../stores/app.js";

vi.mock("../workspace/TerminalPane.vue", () => ({ default: { template: "<div class='terminal-pane-stub' />" } }));

function setup(apiOverrides: Record<string, unknown> = {}) {
  const api = {
    sshTestStart: vi.fn(async () => ({ sessionId: "ssh-test:test-1", mode: "system-ssh", status: "process-running" })),
    sshTestStop: vi.fn(async () => ({ ok: true })),
    onSshTestState: vi.fn(),
    ...apiOverrides,
  };
  const ssh = useSshStore();
  ssh.init(api as never);
  return { api, ssh };
}

describe("SshConnectionTestDialog", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("embedded mode puts return actions in the header and keeps inline footer behavior separate", async () => {
    setup();
    const wrapper = mount(SshConnectionTestDialog, {
      props: { profileId: "default", draft: { host: "prod" }, embedded: true },
    });
    await flushPromises();

    expect(wrapper.get(".ssh-embedded-header").text()).toContain("Stop and return");
    expect(wrapper.find(".dialog__footer").exists()).toBe(false);
    wrapper.unmount();
  });

  test("keeps process-running neutral and stops the temporary terminal on return", async () => {
    const { api, ssh } = setup();
    const wrapper = mount(SshConnectionTestDialog, {
      props: { profileId: "default", draft: { host: "server.example.com", advanced: { command: "must not run" } } },
    });
    await flushPromises();

    expect(wrapper.get('[role="status"]').text()).toContain("verification is pending");
    expect(wrapper.find(".success").exists()).toBe(false);
    expect(wrapper.find(".terminal-pane-stub").exists()).toBe(true);
    expect(api.sshTestStart).toHaveBeenCalledWith({
      profileId: "default",
      draft: expect.objectContaining({ host: "server.example.com", advanced: {} }),
    });

    await wrapper.get(".dialog__footer .button").trigger("click");
    await flushPromises();
    expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:test-1" });
    expect(ssh.sshTestStates["ssh-test:test-1"]).toBeUndefined();
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.unmount();
  });

  test("retries with the new session ID and waits for a pending retry before closing", async () => {
    let finishRetry!: (_result: { sessionId: string; mode: "wsl"; status: "process-running" }) => void;
    const { api } = setup({
      sshTestStart: vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "ssh-test:failed", mode: "wsl", status: "error" })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => (finishRetry = resolve)) as Promise<{
              sessionId: string;
              mode: "wsl";
              status: "process-running";
            }>,
        ),
    });
    const wrapper = mount(SshConnectionTestDialog, { props: { profileId: "default", draft: { host: "prod" } } });
    await flushPromises();
    expect(api.sshTestStart).toHaveBeenCalled();
    const retrying = wrapper.get(".dialog__footer .button--ghost").trigger("click");
    await flushPromises();
    expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:failed" });
    const closing = (wrapper.vm as unknown as { requestClose: () => Promise<void> }).requestClose();
    expect(wrapper.emitted("cancel")).toBeFalsy();
    finishRetry({ sessionId: "ssh-test:retry", mode: "wsl", status: "process-running" });
    await Promise.all([retrying, closing]);
    await flushPromises();

    expect(api.sshTestStop).toHaveBeenLastCalledWith({ sessionId: "ssh-test:retry" });
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.unmount();
  });

  test("clears an authenticated built-in result when returning", async () => {
    const { api, ssh } = setup({
      sshTestStart: vi.fn(async () => ({ sessionId: "ssh-test:builtin", mode: "ssh2", status: "authenticated" })),
    });
    const wrapper = mount(SshConnectionTestDialog, { props: { profileId: "default", draft: { host: "prod" } } });
    await flushPromises();
    expect(wrapper.get(".success").text()).toContain("Authentication succeeded");
    await wrapper.get(".dialog__footer .button").trigger("click");
    await flushPromises();
    expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:builtin" });
    expect(ssh.sshTestStates["ssh-test:builtin"]).toBeUndefined();
    wrapper.unmount();
  });

  test("releases the renderer terminal view on unmount even if backend stop fails", async () => {
    const { api } = setup({ sshTestStop: vi.fn(async () => Promise.reject(new Error("stop failed"))) });
    const terminal = useTerminalStore();
    const release = vi.spyOn(terminal, "releaseTestSession");
    const wrapper = mount(SshConnectionTestDialog, { props: { profileId: "default", draft: { host: "prod" } } });
    await flushPromises();
    wrapper.unmount();
    await flushPromises();
    expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:test-1" });
    expect(release).toHaveBeenCalledWith("ssh-test:test-1");
  });

  test("keeps an inline authenticated result open after stop failure and retries cleanup once", async () => {
    const { api } = setup({
      sshTestStart: vi.fn(async () => ({
        sessionId: "ssh-test:inline-stop-retry",
        mode: "ssh2",
        status: "authenticated",
      })),
    });
    api.sshTestStop.mockRejectedValueOnce(new Error("stop failed")).mockResolvedValueOnce({ ok: true });
    const onResult = vi.fn();
    const wrapper = mount(SshConnectionTestDialog, {
      props: { profileId: "default", draft: { host: "prod" }, inline: true, onResult },
    });
    await vi.waitFor(() => expect(wrapper.get('[role="alert"]').text()).toContain("stop failed"));

    expect(api.sshTestStop).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".ssh-connection-test").exists()).toBe(true);
    expect(wrapper.emitted("cancel")).toBeFalsy();
    expect(onResult).not.toHaveBeenCalled();

    await wrapper.get(".dialog__footer .button").trigger("click");
    await flushPromises();
    expect(api.sshTestStop).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith({ mode: "ssh2", status: "authenticated", error: "" });
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.unmount();
  });

  test("stops a pending native test after profile change using the original test profile", async () => {
    Object.defineProperty(window, "strideterm", {
      configurable: true,
      value: { startupFlags: { windowId: "window-test" } },
    });
    const app = useAppStore();
    const payloadFor = (profileId: string) =>
      ({
        appState: {
          profiles: [{ id: "profile-one" }, { id: "profile-two" }],
          windowSlots: [{ id: "window-test", profileId }],
        },
      }) as never;
    app.payload = payloadFor("profile-one");

    let finishStart!: (result: { sessionId: string; mode: "wsl"; status: "connecting" }) => void;
    const { api } = setup({
      sshTestStart: vi.fn(
        () =>
          new Promise((resolve) => (finishStart = resolve)) as Promise<{
            sessionId: string;
            mode: "wsl";
            status: "connecting";
          }>,
      ),
    });
    const onResult = vi.fn();
    const wrapper = mount(SshConnectionTestDialog, {
      props: { profileId: "profile-one", draft: { host: "prod" }, inline: true, onResult },
    });
    await vi.waitFor(() => expect(api.sshTestStart).toHaveBeenCalled());

    app.payload = payloadFor("profile-two");
    await nextTick();
    expect(api.sshTestStop).not.toHaveBeenCalled();
    finishStart({ sessionId: "ssh-test:pending-profile-change", mode: "wsl", status: "connecting" });
    await vi.waitFor(() =>
      expect(api.sshTestStop).toHaveBeenCalledWith({ sessionId: "ssh-test:pending-profile-change" }),
    );
    await flushPromises();

    expect(api.sshTestStart).toHaveBeenCalledWith({
      profileId: "profile-one",
      draft: expect.objectContaining({ host: "prod" }),
    });
    expect(onResult).toHaveBeenCalledWith({ mode: "wsl", status: "connecting", error: "" });
    expect(wrapper.emitted("cancel")).toBeTruthy();
    wrapper.unmount();
  });
});
