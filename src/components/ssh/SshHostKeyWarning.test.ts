import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import SshHostKeyWarning from "./SshHostKeyWarning.vue";
import { useSshStore } from "../../stores/ssh.js";

function deferred<T>() {
  let resolve!: (_value: T) => void;
  let reject!: (_reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const handlers: { hostKey?: (_payload: unknown) => void } = {};
  const api = {
    sshHostKeyAccept: vi.fn(() => Promise.resolve({})),
    sshHostKeyReject: vi.fn(() => Promise.resolve({})),
    onSshAuthPrompt: (_handler: (_payload: unknown) => void) => undefined,
    onSshAuthPromptCancel: (_handler: (_payload: unknown) => void) => undefined,
    onSshHostKeyChange: (handler: (_payload: unknown) => void) => (handlers.hostKey = handler),
    onSshConnectionState: (_handler: (_payload: unknown) => void) => undefined,
    onSshState: (_handler: (_payload: unknown) => void) => undefined,
  };
  const store = useSshStore();
  store.init(api as never);
  store.bindEvents();
  const wrapper = mount(SshHostKeyWarning);
  return { api, handlers, store, wrapper };
}

function emitWarning(handlers: { hostKey?: (_payload: unknown) => void }, promptId: string) {
  handlers.hostKey?.({
    sessionId: "session-1",
    promptId,
    host: { name: "Production", host: "prod.example.com", port: 22 },
    keyType: "ssh-ed25519",
    fingerprint: "SHA256:presented",
  });
}

describe("SshHostKeyWarning", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("prevents duplicate acceptance while a decision is pending and sends the once token once", async () => {
    const { api, handlers, wrapper } = setup();
    const pending = deferred<object>();
    api.sshHostKeyAccept.mockReturnValue(pending.promise);
    emitWarning(handlers, "host-key:1");
    await nextTick();

    await wrapper.get(".dialog__footer button:nth-child(2)").trigger("click");
    expect(wrapper.get(".dialog__footer button:nth-child(2)").attributes("disabled")).toBeDefined();
    await wrapper.get(".dialog__footer button:nth-child(2)").trigger("click");
    expect(api.sshHostKeyAccept).toHaveBeenCalledTimes(1);
    expect(api.sshHostKeyAccept).toHaveBeenCalledWith({ sessionId: "session-1", mode: "once", promptId: "host-key:1" });

    pending.resolve({});
    await flushPromises();
    expect(wrapper.find(".ssh-host-key-warning").exists()).toBe(false);
  });

  test("passes the permanent decision token for a first-time fingerprint", async () => {
    const { api, handlers, wrapper } = setup();
    emitWarning(handlers, "host-key:1");
    await nextTick();
    await wrapper.get(".dialog__footer button:last-child").trigger("click");
    await flushPromises();

    expect(api.sshHostKeyAccept).toHaveBeenCalledWith({
      sessionId: "session-1",
      mode: "permanent",
      promptId: "host-key:1",
    });
    expect(wrapper.find(".ssh-host-key-warning").exists()).toBe(false);
  });

  test("keeps a failed trust decision open and usable for a retry", async () => {
    const { api, handlers, store, wrapper } = setup();
    api.sshHostKeyAccept.mockRejectedValueOnce(new Error("Temporary transport failure"));
    emitWarning(handlers, "host-key:1");
    await nextTick();
    await wrapper.get(".dialog__footer button:last-child").trigger("click");
    await flushPromises();

    expect(store.hostKeyWarning?.promptId).toBe("host-key:1");
    await vi.waitFor(() =>
      expect(wrapper.get(".dialog__footer button:last-child").attributes("disabled")).toBeUndefined(),
    );
    expect(wrapper.get(".dialog__footer button:last-child").attributes("disabled")).toBeUndefined();
    await wrapper.get(".dialog__footer button:last-child").trigger("click");
    await flushPromises();
    expect(api.sshHostKeyAccept).toHaveBeenCalledTimes(2);
    expect(api.sshHostKeyAccept).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      mode: "permanent",
      promptId: "host-key:1",
    });
    expect(store.hostKeyWarning).toBeNull();
  });
});
