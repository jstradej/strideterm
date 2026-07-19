/**
 * Regression coverage for review-code-quality-2026-07.md finding 1.5: the ssh
 * store used to call `createTransport()` at module scope, opening a SECOND
 * WebSocket (own reconnect loop, own resume probe, never subscribed to
 * terminals) on every remote client in addition to the one main.ts/App.vue
 * already create and inject. The store now takes its transport via init(api)
 * like git-ui/azure-pipelines, and does nothing until init() is called.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useSshStore } from "./ssh.js";
import { useNotificationStore } from "./notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

function makeFakeApi(overrides: AnyObj = {}) {
  const handlers: AnyObj = {};
  const api: AnyObj = {
    sshHostsList: vi.fn(async () => [{ id: "h1", name: "box" }]),
    sshKeysList: vi.fn(async () => [{ id: "k1", label: "laptop" }]),
    sshCertsList: vi.fn(async () => [{ id: "c1" }]),
    sshHostsUpdate: vi.fn(async () => ({})),
    sshHostsCreate: vi.fn(async () => ({})),
    sshHostsDelete: vi.fn(async () => ({})),
    sshKeysImport: vi.fn(async () => ({})),
    sshKeysGenerate: vi.fn(async () => ({})),
    sshKeysDelete: vi.fn(async () => ({})),
    sshCertsImport: vi.fn(async () => ({})),
    sshCertsDelete: vi.fn(async () => ({})),
    sshAuthAnswer: vi.fn(async () => ({})),
    sshAuthCancel: vi.fn(async () => ({})),
    sshHostKeyAccept: vi.fn(async () => ({})),
    sshHostKeyReject: vi.fn(async () => ({})),
    onSshAuthPrompt: vi.fn((h: AnyObj) => {
      handlers.authPrompt = h;
    }),
    onSshAuthPromptCancel: vi.fn((h: AnyObj) => {
      handlers.authPromptCancel = h;
    }),
    onSshHostKeyChange: vi.fn((h: AnyObj) => {
      handlers.hostKeyChange = h;
    }),
    onSshState: vi.fn((h: AnyObj) => {
      handlers.state = h;
    }),
    onSshConnectionState: vi.fn((h: AnyObj) => {
      handlers.connectionState = h;
    }),
    ...overrides,
  };
  return { api, handlers };
}

describe("ssh store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("does nothing before init(api) is called — no module-level transport, load()/bindEvents() are safe no-ops", async () => {
    const store = useSshStore();
    await expect(store.load()).resolves.toBeUndefined();
    expect(() => store.bindEvents()).not.toThrow();
    expect(store.hosts).toEqual([]);
    expect(store.keys).toEqual([]);
    expect(store.certificates).toEqual([]);
  });

  it("init(api) + load() populates hosts/keys/certificates from the injected transport", async () => {
    const { api } = makeFakeApi();
    const store = useSshStore();
    store.init(api as never);
    await store.load();
    expect(api.sshHostsList).toHaveBeenCalled();
    expect(api.sshKeysList).toHaveBeenCalled();
    expect(api.sshCertsList).toHaveBeenCalled();
    expect(store.hosts).toEqual([{ id: "h1", name: "box" }]);
    expect(store.keys).toEqual([{ id: "k1", label: "laptop" }]);
    expect(store.certificates).toEqual([{ id: "c1" }]);
  });

  it("importKey forwards label/privateKey/passphrase and reloads", async () => {
    const { api } = makeFakeApi();
    const store = useSshStore();
    store.init(api as never);
    await store.importKey("-----BEGIN...", "laptop-ed25519", "s3cr3t");
    expect(api.sshKeysImport).toHaveBeenCalledWith({
      label: "laptop-ed25519",
      privateKey: "-----BEGIN...",
      passphrase: "s3cr3t",
    });
    expect(api.sshKeysList).toHaveBeenCalled(); // reload triggered
  });

  it("importCertificate forwards keyId/certificate and reloads", async () => {
    const { api } = makeFakeApi();
    const store = useSshStore();
    store.init(api as never);
    await store.importCertificate("k1", "ssh-ed25519-cert-v01@openssh.com AAAA...");
    expect(api.sshCertsImport).toHaveBeenCalledWith({
      keyId: "k1",
      certificate: "ssh-ed25519-cert-v01@openssh.com AAAA...",
    });
    expect(api.sshCertsList).toHaveBeenCalled();
  });

  it("bindEvents wires onSshAuthPrompt/onSshHostKeyChange/onSshConnectionState into store state", async () => {
    const { api, handlers } = makeFakeApi();
    const store = useSshStore();
    store.init(api as never);
    store.bindEvents();

    handlers.authPrompt({ sessionId: "s1", name: "box", prompts: [] });
    expect(store.authPrompt?.sessionId).toBe("s1");

    handlers.hostKeyChange({ sessionId: "s1", host: "box", oldFp: "a", newFp: "b" });
    expect(store.hostKeyWarning?.host).toBe("box");

    handlers.connectionState({ sessionId: "s1", status: "connecting" });
    expect(store.pendingConnections.get("s1")).toBe("connecting");

    // A cancel scoped to the SAME promptId clears both prompt dialogs.
    handlers.authPromptCancel({ sessionId: "s1", promptId: undefined });
    expect(store.authPrompt).toBeNull();
  });

  it("onSshState triggers a reload", async () => {
    const { api, handlers } = makeFakeApi();
    const store = useSshStore();
    store.init(api as never);
    store.bindEvents();
    api.sshHostsList.mockClear();

    handlers.state();
    await Promise.resolve();
    await Promise.resolve();
    expect(api.sshHostsList).toHaveBeenCalled();
  });

  // Regression coverage for review-code-quality-2026-07.md finding 1: load()
  // and the store's other mutating actions had no error handling at all —
  // a rejected /api/ssh/* call left hosts/keys/certs permanently empty with
  // zero explanation anywhere (load() is invoked fire-and-forget from
  // App.vue, onSshState, and several dialog onMounted hooks). The store now
  // catches internally, records `error`, and surfaces a notification toast.
  describe("error handling", () => {
    it("load() failure sets store.error and surfaces a notification toast", async () => {
      const { api } = makeFakeApi({
        sshHostsList: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      const store = useSshStore();
      store.init(api as never);

      await store.load();
      expect(store.error).toBe("ECONNREFUSED");
      expect(store.hosts).toEqual([]);
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.category).toBe("error");
      expect(notifications.latestToast?.title).toBe("Load SSH data failed");
      expect(notifications.latestToast?.body).toBe("ECONNREFUSED");
    });

    it("deleteHost failure sets store.error and surfaces a notification toast", async () => {
      const { api } = makeFakeApi({
        sshHostsDelete: vi.fn(async () => {
          throw new Error("host not found");
        }),
      });
      const store = useSshStore();
      store.init(api as never);

      await store.deleteHost("h1");
      expect(store.error).toBe("host not found");
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Delete SSH host failed");
    });

    it("deleteCertificate failure sets store.error and surfaces a notification toast", async () => {
      const { api } = makeFakeApi({
        sshCertsDelete: vi.fn(async () => {
          throw new Error("cert not found");
        }),
      });
      const store = useSshStore();
      store.init(api as never);

      await store.deleteCertificate("c1");
      expect(store.error).toBe("cert not found");
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Delete SSH certificate failed");
    });

    it("answerAuthPrompt failure sets store.error, toasts, and still clears the prompt", async () => {
      const { api } = makeFakeApi({
        sshAuthAnswer: vi.fn(async () => {
          throw new Error("session closed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.authPrompt = { sessionId: "s1", name: "box", prompts: [], promptId: "p1" };

      await store.answerAuthPrompt("s1", ["secret"]);
      expect(store.error).toBe("session closed");
      expect(store.authPrompt).toBeNull();
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("SSH authentication failed");
    });

    it("cancelAuthPrompt failure sets store.error, toasts, and still clears the prompt", async () => {
      const { api } = makeFakeApi({
        sshAuthCancel: vi.fn(async () => {
          throw new Error("session closed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.authPrompt = { sessionId: "s1", name: "box", prompts: [], promptId: "p1" };

      await store.cancelAuthPrompt("s1");
      expect(store.error).toBe("session closed");
      expect(store.authPrompt).toBeNull();
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Cancel SSH authentication failed");
    });

    it("acceptHostKey failure sets store.error, toasts, and still clears the warning", async () => {
      const { api } = makeFakeApi({
        sshHostKeyAccept: vi.fn(async () => {
          throw new Error("write failed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.hostKeyWarning = { sessionId: "s1", host: "box", oldFp: "a", newFp: "b", promptId: "p1" };

      await store.acceptHostKey("s1", "permanent");
      expect(store.error).toBe("write failed");
      expect(store.hostKeyWarning).toBeNull();
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Accept SSH host key failed");
    });

    it("rejectHostKey failure sets store.error, toasts, and still clears the warning", async () => {
      const { api } = makeFakeApi({
        sshHostKeyReject: vi.fn(async () => {
          throw new Error("session closed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.hostKeyWarning = { sessionId: "s1", host: "box", oldFp: "a", newFp: "b", promptId: "p1" };

      await store.rejectHostKey("s1");
      expect(store.error).toBe("session closed");
      expect(store.hostKeyWarning).toBeNull();
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Reject SSH host key failed");
    });
  });
});
