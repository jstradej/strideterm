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
import { reactive } from "vue";
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
    onSshKeyTransferState: vi.fn((h: AnyObj) => {
      handlers.keyTransferState = h;
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

  it("keeps a terminal key-transfer event that arrives before the start reply", async () => {
    const { api, handlers } = makeFakeApi({
      sshKeysTransferStart: vi.fn(async () => {
        handlers.keyTransferState({
          operationId: "operation-1",
          hostId: "host-1",
          keyId: "key-1",
          status: "installed",
        });
        return { operationId: "operation-1", status: "connecting" };
      }),
      sshKeysTransferStop: vi.fn(async () => ({ ok: true })),
    });
    const store = useSshStore();
    store.init(api as never);
    store.bindEvents();

    await expect(store.startKeyTransfer({ profileId: "profile-1", hostId: "host-1", keyId: "key-1" })).resolves.toEqual(
      {
        operationId: "operation-1",
        status: "connecting",
      },
    );
    expect(store.keyTransferStates["operation-1"]).toMatchObject({ status: "installed", keyId: "key-1" });
    expect(api.sshKeysTransferStart).toHaveBeenCalledWith({
      profileId: "profile-1",
      hostId: "host-1",
      keyId: "key-1",
    });

    await store.stopKeyTransfer("operation-1");
    store.clearKeyTransferState("operation-1");
    expect(api.sshKeysTransferStop).toHaveBeenCalledWith({ operationId: "operation-1" });
    expect(store.keyTransferStates["operation-1"]).toBeUndefined();
  });

  it("passes a draft target without saving the host and keeps an early transfer event", async () => {
    const { api, handlers } = makeFakeApi({
      sshKeysTransferStart: vi.fn(async (payload: AnyObj) => {
        structuredClone(payload);
        handlers.keyTransferState({
          operationId: "draft-operation",
          hostId: "temporary-host-id",
          keyId: "key-1",
          status: "installed",
        });
        return { operationId: "draft-operation", status: "connecting" };
      }),
      sshKeysTransferStop: vi.fn(async () => ({ ok: true })),
    });
    const store = useSshStore();
    store.init(api as never);
    store.bindEvents();
    const payload = {
      profileId: "profile-1",
      keyId: "key-1",
      draft: {
        name: "new host",
        host: "mini.local",
        username: "dev",
        auth: { methods: ["publickey"], keyRef: "key-1" },
      },
    };

    await expect(store.startKeyTransfer(payload)).resolves.toEqual({
      operationId: "draft-operation",
      status: "connecting",
    });

    expect(api.sshKeysTransferStart).toHaveBeenCalledWith(payload);
    expect(api.sshHostsCreate).not.toHaveBeenCalled();
    expect(api.sshHostsList).not.toHaveBeenCalled();
    expect(store.keyTransferStates["draft-operation"]).toMatchObject({
      hostId: "temporary-host-id",
      keyId: "key-1",
      status: "installed",
    });
  });

  it("seeds transfer state with the saved target when no event arrives first", async () => {
    const { api } = makeFakeApi({
      sshKeysTransferStart: vi.fn(async () => ({ operationId: "saved-operation", status: "connecting" })),
    });
    const store = useSshStore();
    store.init(api as never);

    await store.startKeyTransfer({ profileId: "profile-1", hostId: "host-1", keyId: "key-1" });

    expect(store.keyTransferStates["saved-operation"]).toMatchObject({
      hostId: "host-1",
      keyId: "key-1",
      status: "connecting",
    });
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

  it("serializes a nested reactive test draft before IPC without changing the editor draft", async () => {
    const { api } = makeFakeApi({
      sshTestStart: vi.fn(async (payload: AnyObj) => {
        structuredClone(payload);
        return { sessionId: "ssh-test:clone-check", mode: "wsl", status: "process-running" };
      }),
    });
    const store = useSshStore();
    store.init(api as never);
    const draft = reactive({
      id: "saved-id-is-omitted",
      name: "staging",
      host: "prod-alias",
      username: "deploy",
      auth: { methods: ["publickey", "keyboard-interactive"], keyRef: "key-1", agent: "pageant" },
      jump: ["bastion-id"],
      advanced: {
        launchVia: "wsl",
        command: "must-not-run",
        env: { REGION: "eu-west" },
        wsl: { distro: "Ubuntu", user: "dev", exec: "/usr/bin/ssh" },
      },
    });

    await store.startTestConnection("profile-1", draft);

    expect(api.sshTestStart).toHaveBeenCalledWith({
      profileId: "profile-1",
      draft: {
        name: "staging",
        host: "prod-alias",
        username: "deploy",
        auth: { methods: ["publickey", "keyboard-interactive"], keyRef: "key-1", agent: "pageant" },
        jump: ["bastion-id"],
        advanced: {
          launchVia: "wsl",
          env: { REGION: "eu-west" },
          wsl: { distro: "Ubuntu", user: "dev", exec: "/usr/bin/ssh" },
        },
      },
    });
    expect(draft.advanced.command).toBe("must-not-run");
    expect(draft.id).toBe("saved-id-is-omitted");
  });

  it("bindEvents wires onSshAuthPrompt/onSshHostKeyChange/onSshConnectionState into store state", async () => {
    const { api, handlers } = makeFakeApi();
    const store = useSshStore();
    store.init(api as never);
    store.bindEvents();

    handlers.authPrompt({ sessionId: "s1", promptId: "p-auth", prompt: { name: "box", prompts: [] } });
    expect(store.authPrompt?.sessionId).toBe("s1");

    handlers.hostKeyChange({ sessionId: "s2", promptId: "p-key", host: { host: "box" }, fingerprint: "b" });
    expect(store.hostKeyWarning).toBeNull();
    expect(store.decisionQueue).toHaveLength(1);

    handlers.connectionState({ sessionId: "s1", status: "connecting" });
    expect(store.pendingConnections.get("s1")).toBe("connecting");
    handlers.connectionState({ sessionId: "ssh-test:transient", status: "process-running" });
    expect(store.pendingConnections.has("ssh-test:transient")).toBe(false);
    handlers.connectionState({ sessionId: "ssh-transfer:upload", status: "connecting" });
    handlers.connectionState({ sessionId: "ssh-transfer:upload:verify", status: "authenticated" });
    expect(store.pendingConnections.has("ssh-transfer:upload")).toBe(false);
    expect(store.pendingConnections.has("ssh-transfer:upload:verify")).toBe(false);

    // A cancel scoped to the SAME promptId clears both prompt dialogs.
    handlers.authPromptCancel({ sessionId: "s1", promptId: "p-auth" });
    expect(store.authPrompt).toBeNull();
    expect(store.hostKeyWarning?.host?.host).toBe("box");
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

    it("answerAuthPrompt failure sets store.error, toasts, and retains the prompt for retry", async () => {
      const { api } = makeFakeApi({
        sshAuthAnswer: vi.fn(async () => {
          throw new Error("session closed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.authPrompt = { sessionId: "s1", promptId: "p1", prompt: { name: "box", prompts: [] } };

      await store.answerAuthPrompt("s1", ["secret"]);
      expect(store.error).toBe("session closed");
      expect(store.authPrompt?.promptId).toBe("p1");
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("SSH authentication failed");
    });

    it("cancelAuthPrompt failure sets store.error, toasts, and retains the prompt for retry", async () => {
      const { api } = makeFakeApi({
        sshAuthCancel: vi.fn(async () => {
          throw new Error("session closed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.authPrompt = { sessionId: "s1", promptId: "p1", prompt: { name: "box", prompts: [] } };

      await store.cancelAuthPrompt("s1");
      expect(store.error).toBe("session closed");
      expect(store.authPrompt?.promptId).toBe("p1");
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Cancel SSH authentication failed");
    });

    it("acceptHostKey failure sets store.error, toasts, and retains the warning for retry", async () => {
      const { api } = makeFakeApi({
        sshHostKeyAccept: vi.fn(async () => {
          throw new Error("write failed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.hostKeyWarning = {
        sessionId: "s1",
        host: { host: "box" },
        previous: { fingerprint: "a" },
        fingerprint: "b",
        promptId: "p1",
      };

      await store.acceptHostKey("s1", "permanent");
      expect(store.error).toBe("write failed");
      expect(store.hostKeyWarning?.promptId).toBe("p1");
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Accept SSH host key failed");
    });

    it("rejectHostKey failure sets store.error, toasts, and retains the warning for retry", async () => {
      const { api } = makeFakeApi({
        sshHostKeyReject: vi.fn(async () => {
          throw new Error("session closed");
        }),
      });
      const store = useSshStore();
      store.init(api as never);
      store.hostKeyWarning = {
        sessionId: "s1",
        host: { host: "box" },
        previous: { fingerprint: "a" },
        fingerprint: "b",
        promptId: "p1",
      };

      await store.rejectHostKey("s1");
      expect(store.error).toBe("session closed");
      expect(store.hostKeyWarning?.promptId).toBe("p1");
      const notifications = useNotificationStore();
      expect(notifications.latestToast?.title).toBe("Reject SSH host key failed");
    });
  });
});
