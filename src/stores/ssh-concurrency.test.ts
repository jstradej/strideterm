import { beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSshStore } from "./ssh.js";

function fixture() {
  const handlers: Record<string, (_payload: unknown) => void> = {};
  const api = {
    sshHostsList: vi.fn(async () => []),
    sshKeysList: vi.fn(async () => []),
    sshCertsList: vi.fn(async () => []),
    sshAuthAnswer: vi.fn(async (_payload: unknown) => ({})),
    sshAuthCancel: vi.fn(async (_payload: unknown) => ({})),
    sshHostKeyAccept: vi.fn(async (_payload: unknown) => ({})),
    sshHostKeyReject: vi.fn(async (_payload: unknown) => ({})),
    onSshAuthPrompt: (handler: (_payload: unknown) => void) => (handlers.auth = handler),
    onSshAuthPromptCancel: (handler: (_payload: unknown) => void) => (handlers.dismiss = handler),
    onSshHostKeyChange: (handler: (_payload: unknown) => void) => (handlers.hostKey = handler),
    onSshConnectionState: (handler: (_payload: unknown) => void) => (handlers.connection = handler),
    onSshState: (handler: (_payload: unknown) => void) => (handlers.state = handler),
  };
  const store = useSshStore();
  store.init(api as never);
  store.bindEvents();
  return { store, api, handlers };
}

function prompt(sessionId: string, promptId: string) {
  return { sessionId, promptId, prompt: { prompts: [{ prompt: "Code:", echo: false }] } };
}

describe("SSH prompt concurrency", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("auth and host-key decisions share one visible queue and retain arrival order", () => {
    const { store, handlers } = fixture();
    handlers.auth!(prompt("one", "one:1"));
    handlers.hostKey!({ sessionId: "two", promptId: "key:1", host: { host: "server" }, fingerprint: "SHA256:test" });
    handlers.auth!(prompt("three", "three:1"));
    expect(store.authPrompt?.sessionId).toBe("one");
    expect(store.hostKeyWarning).toBeNull();
    handlers.dismiss!({ sessionId: "one", promptId: "one:1" });
    expect(store.authPrompt).toBeNull();
    expect(store.hostKeyWarning?.sessionId).toBe("two");
    handlers.dismiss!({ sessionId: "two", promptId: "key:1" });
    expect(store.hostKeyWarning).toBeNull();
    expect(store.authPrompt?.sessionId).toBe("three");
  });

  test("an answer finishing after backend dismissal preserves another session's queued prompt", async () => {
    const { store, api, handlers } = fixture();
    let finish!: (_value: object) => void;
    api.sshAuthAnswer.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    handlers.auth!(prompt("one", "one:1"));
    handlers.auth!(prompt("two", "two:1"));
    const answering = store.answerAuthPrompt("one", ["first-answer"]);
    handlers.dismiss!({ sessionId: "one", promptId: "one:1" });
    expect(store.authPrompt?.sessionId).toBe("two");
    finish({});
    await answering;
    expect(store.authPrompt?.sessionId).toBe("two");
    expect(api.sshAuthAnswer).toHaveBeenCalledWith({ sessionId: "one", promptId: "one:1", answers: ["first-answer"] });
  });

  test("a delayed first-round answer cannot dismiss the next MFA round of the same session", async () => {
    const { store, api, handlers } = fixture();
    let finish!: (_value: object) => void;
    api.sshAuthAnswer.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    handlers.auth!(prompt("one", "one:1"));
    const answering = store.answerAuthPrompt("one", ["first-answer"]);
    handlers.dismiss!({ sessionId: "one", promptId: "one:1" });
    handlers.auth!(prompt("one", "one:2"));
    finish({});
    await answering;
    expect(store.authPrompt?.promptId).toBe("one:2");
  });

  test("a failed answer transport preserves the live prompt for retry", async () => {
    const { store, api, handlers } = fixture();
    api.sshAuthAnswer.mockRejectedValue(new Error("Connection unavailable"));
    handlers.auth!(prompt("one", "one:1"));
    await store.answerAuthPrompt("one", ["answer"]);
    expect(store.authPrompt?.promptId).toBe("one:1");
    expect(store.error).toContain("Connection unavailable");
  });

  test("a failed host-key acceptance transport preserves the live decision for retry", async () => {
    const { store, api, handlers } = fixture();
    api.sshHostKeyAccept.mockRejectedValue(new Error("Connection unavailable"));
    handlers.hostKey!({ sessionId: "one", promptId: "key:1", host: { host: "server" }, fingerprint: "SHA256:test" });
    await store.acceptHostKey("one", "once");
    expect(store.hostKeyWarning?.promptId).toBe("key:1");
    expect(store.error).toContain("Connection unavailable");
  });
});
