import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SshAuthPrompt from "./SshAuthPrompt.vue";
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
  const handlers: {
    auth?: (_payload: unknown) => void;
    dismiss?: (_payload: { sessionId: string; promptId: string }) => void;
  } = {};
  const api = {
    sshAuthAnswer: vi.fn(() => Promise.resolve({})),
    onSshAuthPrompt: (handler: (_payload: unknown) => void) => (handlers.auth = handler),
    onSshAuthPromptCancel: (handler: (_payload: { sessionId: string; promptId: string }) => void) =>
      (handlers.dismiss = handler),
    onSshHostKeyChange: (_handler: (_payload: unknown) => void) => undefined,
    onSshConnectionState: (_handler: (_payload: unknown) => void) => undefined,
    onSshState: (_handler: (_payload: unknown) => void) => undefined,
  };
  const store = useSshStore();
  store.init(api as never);
  store.bindEvents();
  const wrapper = mount(SshAuthPrompt);
  return { api, handlers, store, wrapper };
}

function emitPrompt(
  handlers: { auth?: (_payload: unknown) => void },
  promptId: string,
  prompts: { prompt: string; echo: boolean }[],
) {
  handlers.auth?.({ sessionId: "session-1", promptId, prompt: { prompts } });
}

describe("SshAuthPrompt", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("shows echoed responses as text and secrets as password fields", async () => {
    const { handlers, wrapper } = setup();
    emitPrompt(handlers, "auth:1", [
      { prompt: "Account name", echo: true },
      { prompt: "One-time code", echo: false },
    ]);
    await nextTick();

    const inputs = wrapper.findAll("input");
    expect(inputs.map((input) => input.attributes("type"))).toEqual(["text", "password"]);
    expect(wrapper.text()).toContain("Account name");
    expect(wrapper.text()).toContain("One-time code");
  });

  test("clears answer values between MFA rounds and submits the current round", async () => {
    const { api, handlers, wrapper } = setup();
    emitPrompt(handlers, "auth:1", [{ prompt: "Password", echo: false }]);
    await nextTick();
    await wrapper.get("input").setValue("first-secret");
    await wrapper.get(".actions button:last-child").trigger("click");
    await flushPromises();
    expect(api.sshAuthAnswer).toHaveBeenCalledWith({
      sessionId: "session-1",
      promptId: "auth:1",
      answers: ["first-secret"],
    });

    emitPrompt(handlers, "auth:2", [
      { prompt: "Token", echo: true },
      { prompt: "Token PIN", echo: false },
    ]);
    await nextTick();
    expect(wrapper.findAll("input").map((input) => (input.element as HTMLInputElement).value)).toEqual(["", ""]);
    await wrapper.findAll("input")[0].setValue("123456");
    await wrapper.findAll("input")[1].setValue("pin");
    await wrapper.get(".actions button:last-child").trigger("click");
    await flushPromises();
    expect(api.sshAuthAnswer).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      promptId: "auth:2",
      answers: ["123456", "pin"],
    });
  });

  test("does not submit twice or send the old answer into a new round while a response is pending", async () => {
    const { api, handlers, wrapper } = setup();
    const answerPending = deferred<object>();
    api.sshAuthAnswer.mockReturnValue(answerPending.promise);
    emitPrompt(handlers, "auth:1", [{ prompt: "Password", echo: false }]);
    await nextTick();
    await wrapper.get("input").setValue("first-secret");

    await wrapper.get(".actions button:last-child").trigger("click");
    expect(wrapper.get(".actions button:last-child").text()).toBe("Sending…");
    expect(wrapper.get("input").attributes("disabled")).toBeDefined();
    await wrapper.get(".actions button:last-child").trigger("click");
    expect(api.sshAuthAnswer).toHaveBeenCalledTimes(1);

    handlers.dismiss?.({ sessionId: "session-1", promptId: "auth:1" });
    await nextTick();
    emitPrompt(handlers, "auth:2", [{ prompt: "Verification code", echo: true }]);
    await nextTick();
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
    answerPending.resolve({});
    await flushPromises();
    expect(api.sshAuthAnswer).toHaveBeenCalledTimes(1);
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("");
    expect(wrapper.get(".actions button:last-child").text()).toBe("Submit");
  });

  test("ignores a stale prompt id when the visible prompt changes before submit", async () => {
    const { api, handlers, store, wrapper } = setup();
    emitPrompt(handlers, "auth:1", [{ prompt: "Password", echo: false }]);
    await nextTick();
    await wrapper.get("input").setValue("stale-secret");
    store.dismissAuthPrompt("auth:1");
    await nextTick();
    emitPrompt(handlers, "auth:2", [{ prompt: "New code", echo: true }]);
    await nextTick();
    await wrapper.get("input").setValue("fresh-code");
    await wrapper.get(".actions button:last-child").trigger("click");
    await flushPromises();
    expect(api.sshAuthAnswer).toHaveBeenCalledTimes(1);
    expect(api.sshAuthAnswer).toHaveBeenCalledWith({
      sessionId: "session-1",
      promptId: "auth:2",
      answers: ["fresh-code"],
    });
  });

  test("keeps a failed prompt available for a corrected retry", async () => {
    const { api, handlers, store, wrapper } = setup();
    api.sshAuthAnswer.mockRejectedValueOnce(new Error("Temporary transport failure"));
    emitPrompt(handlers, "auth:1", [{ prompt: "Code", echo: true }]);
    await nextTick();
    await wrapper.get("input").setValue("bad-code");
    await wrapper.get(".actions button:last-child").trigger("click");
    await flushPromises();

    expect(store.authPrompt?.promptId).toBe("auth:1");
    expect((wrapper.get("input").element as HTMLInputElement).value).toBe("bad-code");
    await vi.waitFor(() => expect(wrapper.get(".actions button:last-child").attributes("disabled")).toBeUndefined());
    await wrapper.get("input").setValue("correct-code");
    await wrapper.get(".actions button:last-child").trigger("click");
    await flushPromises();
    expect(api.sshAuthAnswer).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      promptId: "auth:1",
      answers: ["correct-code"],
    });
    expect(store.authPrompt).toBeNull();
  });
});
