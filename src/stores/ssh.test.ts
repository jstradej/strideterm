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
});
