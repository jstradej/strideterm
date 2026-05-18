import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetailShell from "./DockerDetailShell.vue";

/**
 * The Shell component talks to `window.strideterm` for bidirectional PTY I/O.
 * We mock that surface so the component can be exercised with synthetic data
 * without spinning up a real docker exec.
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

function installMockApi(): MockApi {
  let dataHandler: ((p: { sessionId: string; data: string }) => void) | null = null;
  let closeHandler: ((p: { sessionId: string; code: number | null }) => void) | null = null;
  const api: MockApi = {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).strideterm = api;
  return api;
}

describe("DockerDetailShell — visual + IPC integration with mocked API", () => {
  let api: MockApi;

  beforeEach(() => {
    setActivePinia(createPinia());
    api = installMockApi();
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).strideterm;
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

  it("calls dockerShellOpen with session + container on mount", async () => {
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

    expect(api.dockerShellOpen).toHaveBeenCalledTimes(1);
    const call = api.dockerShellOpen.mock.calls[0][0];
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

    api._emitData({ sessionId: "shell-3", data: "$ " });
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

    api._emitData({ sessionId: "shell-someone-else", data: "garbage" });
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

    api._emitClose({ sessionId: "shell-4", code: 137 });
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
    api._emitClose({ sessionId: "shell-5", code: 0 });
    await flushPromises();

    api.dockerShellOpen.mockClear();
    await wrapper.find(".detail-shell__exit-card button").trigger("click");
    await flushPromises();

    // A new session is opened. We don't assert the new sessionId is different
    // here because crypto.randomUUID() may not be available in test env; but
    // the open call must fire.
    expect(api.dockerShellOpen).toHaveBeenCalledTimes(1);
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
    expect(api.dockerShellClose).toHaveBeenCalled();
  });
});
