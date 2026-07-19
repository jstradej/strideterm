import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

/**
 * The Shell component talks to the transport (Transport, via `appStore.getApi()`)
 * for bidirectional PTY I/O — NOT `window.strideterm` directly, since that global
 * only exists in the Electron renderer and is `undefined` on a remote/mobile
 * client. We mock `useAppStore`/`useNotificationStore` so the component can be
 * exercised with synthetic data without spinning up a real docker exec, and so a
 * failed open surfaces through `notifications.showError` instead of a silently
 * swallowed error.
 */
interface MockApi {
  dockerShellOpen: ReturnType<typeof vi.fn>;
  dockerShellWrite: ReturnType<typeof vi.fn>;
  dockerShellResize: ReturnType<typeof vi.fn>;
  dockerShellClose: ReturnType<typeof vi.fn>;
  onDockerShellData: (handler: (payload: { sessionId: string; data: string }) => void) => void;
  onDockerShellClose: (handler: (payload: { sessionId: string; code: number | null }) => void) => void;
  _emitData: (payload: { sessionId: string; data: string }) => void;
  _emitClose: (payload: { sessionId: string; code: number | null }) => void;
}

let dataHandler: ((p: { sessionId: string; data: string }) => void) | null = null;
let closeHandler: ((p: { sessionId: string; code: number | null }) => void) | null = null;
const mockApi: MockApi = {
  dockerShellOpen: vi.fn().mockResolvedValue({ ok: true }),
  dockerShellWrite: vi.fn().mockResolvedValue({ ok: true }),
  dockerShellResize: vi.fn().mockResolvedValue({ ok: true }),
  dockerShellClose: vi.fn().mockResolvedValue({ ok: true }),
  onDockerShellData: (h) => {
    dataHandler = h;
  },
  onDockerShellClose: (h) => {
    closeHandler = h;
  },
  _emitData: (p) => dataHandler?.(p),
  _emitClose: (p) => closeHandler?.(p),
};
const showError = vi.fn();

vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({ getApi: () => mockApi }),
}));
vi.mock("../../../stores/notifications.js", () => ({
  useNotificationStore: () => ({ showError }),
}));

import DockerDetailShell from "./DockerDetailShell.vue";

describe("DockerDetailShell — visual + transport integration with a mocked Transport", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    dataHandler = null;
    closeHandler = null;
    mockApi.dockerShellOpen.mockClear().mockResolvedValue({ ok: true });
    mockApi.dockerShellWrite.mockClear().mockResolvedValue({ ok: true });
    mockApi.dockerShellResize.mockClear().mockResolvedValue({ ok: true });
    mockApi.dockerShellClose.mockClear().mockResolvedValue({ ok: true });
    showError.mockClear();
  });

  it("renders the term host and shows connecting overlay on mount", async () => {
    const wrapper = mount(DockerDetailShell, {
      props: {
        sessionId: "shell-1",
        containerId: "abc",
        containerName: "myapp",
        backendId: "host",
        contextName: "default",
      },
    });
    await flushPromises();

    expect(wrapper.find(".detail-shell__term").exists()).toBe(true);
    expect(wrapper.find(".detail-shell__overlay").exists()).toBe(true);
    expect(wrapper.text()).toContain("Starting shell in myapp");
  });

  it("calls dockerShellOpen (via the transport, not window.strideterm) with session + container on mount", async () => {
    mount(DockerDetailShell, {
      props: {
        sessionId: "shell-2",
        containerId: "cnt-xyz",
        containerName: "x",
        backendId: "wsl",
        contextName: "default",
      },
    });
    await flushPromises();

    // window.strideterm is never installed in this suite — if the component
    // still reached for it directly, dockerShellOpen would never be called.
    expect((window as unknown as { strideterm?: unknown }).strideterm).toBeUndefined();
    expect(mockApi.dockerShellOpen).toHaveBeenCalledTimes(1);
    const call = mockApi.dockerShellOpen.mock.calls[0][0];
    expect(call.sessionId).toBe("shell-2");
    expect(call.containerId).toBe("cnt-xyz");
    expect(call.backendId).toBe("wsl");
    expect(call.contextName).toBe("default");
  });

  it("dismisses connecting overlay once first data chunk arrives", async () => {
    const wrapper = mount(DockerDetailShell, {
      props: {
        sessionId: "shell-3",
        containerId: "abc",
        containerName: "myapp",
        backendId: "host",
        contextName: "default",
      },
    });
    await flushPromises();
    expect(wrapper.find(".detail-shell__overlay").exists()).toBe(true);

    mockApi._emitData({ sessionId: "shell-3", data: "$ " });
    await flushPromises();

    expect(wrapper.find(".detail-shell__overlay").exists()).toBe(false);
  });

  it("ignores data for a foreign session", async () => {
    const wrapper = mount(DockerDetailShell, {
      props: {
        sessionId: "shell-mine",
        containerId: "abc",
        containerName: "myapp",
        backendId: "host",
        contextName: "default",
      },
    });
    await flushPromises();

    mockApi._emitData({ sessionId: "shell-someone-else", data: "garbage" });
    await flushPromises();
    // Overlay should still be visible — no data for our session yet.
    expect(wrapper.find(".detail-shell__overlay").exists()).toBe(true);
  });

  it("shows exit card with restart button when session closes", async () => {
    const wrapper = mount(DockerDetailShell, {
      props: {
        sessionId: "shell-4",
        containerId: "abc",
        containerName: "myapp",
        backendId: "host",
        contextName: "default",
      },
    });
    await flushPromises();

    mockApi._emitClose({ sessionId: "shell-4", code: 137 });
    await flushPromises();

    const exitCard = wrapper.find(".detail-shell__exit-card");
    expect(exitCard.exists()).toBe(true);
    expect(exitCard.text()).toContain("Shell session ended");
    expect(exitCard.text()).toContain("137");
    expect(exitCard.find("button").text()).toContain("Restart shell");
  });

  it("restart button re-opens a new shell session", async () => {
    const wrapper = mount(DockerDetailShell, {
      props: {
        sessionId: "shell-5",
        containerId: "abc",
        containerName: "myapp",
        backendId: "host",
        contextName: "default",
      },
    });
    await flushPromises();
    mockApi._emitClose({ sessionId: "shell-5", code: 0 });
    await flushPromises();

    mockApi.dockerShellOpen.mockClear();
    await wrapper.find(".detail-shell__exit-card button").trigger("click");
    await flushPromises();

    // A new session is opened. We don't assert the new sessionId is different
    // here because crypto.randomUUID() may not be available in test env; but
    // the open call must fire.
    expect(mockApi.dockerShellOpen).toHaveBeenCalledTimes(1);
  });

  it("closes the session when the component unmounts", async () => {
    const wrapper = mount(DockerDetailShell, {
      props: {
        sessionId: "shell-6",
        containerId: "abc",
        containerName: "myapp",
        backendId: "host",
        contextName: "default",
      },
    });
    await flushPromises();

    wrapper.unmount();
    expect(mockApi.dockerShellClose).toHaveBeenCalled();
  });

  it("surfaces a failed shell open via notifications.showError with the real error message, instead of swallowing it", async () => {
    mockApi.dockerShellOpen.mockRejectedValueOnce(new Error("no such container"));
    const wrapper = mount(DockerDetailShell, {
      props: {
        sessionId: "shell-7",
        containerId: "gone",
        containerName: "ghost",
        backendId: "host",
        contextName: "default",
      },
    });
    await flushPromises();

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith("Shell session failed", expect.stringContaining("no such container"));
    // connecting flips false and the exit card (not the connecting spinner) takes over.
    expect(wrapper.find(".detail-shell__exit-card").exists()).toBe(true);
    expect(wrapper.find(".detail-shell__exit-card small").exists()).toBe(false); // no exit code — code stays null
  });
});
