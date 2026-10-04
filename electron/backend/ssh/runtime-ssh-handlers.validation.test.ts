import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import ssh2 from "ssh2";
import { createSshHandlers } from "./runtime-ssh-handlers.js";

const { utils } = ssh2;

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({
    type: "pkcs1",
    format: "pem",
  })
  .toString();

function fixture() {
  const state = {
    settings: { ssh: { defaultLaunchVia: "system-ssh", requireEncryptedStorage: true } },
    ssh: {
      hosts: [] as {
        id: string;
        name: string;
        auth: { keyRef?: string; certRef?: string };
        advanced?: { launchVia: string; command?: string };
      }[],
      keys: [] as { id: string; publicKey?: string; fingerprint?: string }[],
      certificates: [] as { id: string; keyId: string }[],
    },
  };
  const credentialStore = {
    setSecret: vi.fn(async () => {}),
    deleteSecret: vi.fn(async () => {}),
    isEncryptionAvailable: () => true,
  };
  const sshManager = {
    getHost: vi.fn((id: string) => state.ssh.hosts.find((host) => host.id === id)),
    createSession: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const handlers = createSshHandlers({
    store: { getState: () => state, mutate: async (change: (_state: typeof state) => void) => change(state) },
    credentialStore,
    sshManager,
    broadcastState: vi.fn(),
  });
  return { state, credentialStore, sshManager, handlers };
}

describe("SSH management boundaries", () => {
  test("rejects invalid private-key material before persisting any secret or metadata", async () => {
    const { handlers, credentialStore, state } = fixture();
    await expect(handlers["ssh:keys:import"]({ privateKey: "not a private key", label: "invalid" })).rejects.toThrow();
    expect(credentialStore.setSecret).not.toHaveBeenCalled();
    expect(state.ssh.keys).toEqual([]);
  });

  test("records a public key and fingerprint derived from the actual imported key", async () => {
    const { handlers } = fixture();
    const imported = await handlers["ssh:keys:import"]({ privateKey, label: "valid" });
    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("Invalid test key");
    const publicBytes = parsed.getPublicSSH();
    const expectedFingerprint = `SHA256:${createHash("sha256").update(publicBytes).digest("base64").replace(/=+$/, "")}`;
    expect(imported).toMatchObject({ fingerprint: expectedFingerprint });
    const publicKey = utils.parseKey((imported as { publicKey?: string }).publicKey || "");
    if (publicKey instanceof Error || Array.isArray(publicKey))
      throw new Error("Imported public key is missing or invalid");
    expect(publicKey.getPublicSSH()).toEqual(publicBytes);
  });

  test("rejects an incorrect encrypted-key passphrase before writing secrets", async () => {
    const sshpk = await import("sshpk");
    const encrypted = sshpk.parsePrivateKey(privateKey).toString("ssh-private", { passphrase: "correct" });
    const { handlers, credentialStore } = fixture();
    await expect(
      handlers["ssh:keys:import"]({ privateKey: encrypted, passphrase: "incorrect", label: "encrypted" }),
    ).rejects.toThrow();
    expect(credentialStore.setSecret).not.toHaveBeenCalled();
  });

  test("applies the current encrypted-storage setting to every private-key and passphrase write", async () => {
    const { handlers, credentialStore, state } = fixture();
    state.settings.ssh.requireEncryptedStorage = false;
    await handlers["ssh:keys:import"]({ privateKey, passphrase: "stored-passphrase", label: "policy" });
    expect(credentialStore.setSecret).toHaveBeenCalledTimes(2);
    for (const call of credentialStore.setSecret.mock.calls) expect(call).toHaveLength(3);
    expect(credentialStore.setSecret).toHaveBeenNthCalledWith(1, expect.any(String), privateKey, {
      requireEncryptedStorage: false,
    });
    expect(credentialStore.setSecret).toHaveBeenNthCalledWith(2, expect.any(String), "stored-passphrase", {
      requireEncryptedStorage: false,
    });
  });

  test("refuses key deletion with host or certificate dependencies even when cascade is requested", async () => {
    const { handlers, credentialStore, state } = fixture();
    state.ssh.hosts.push({ id: "host", name: "production", auth: { keyRef: "key" } });
    state.ssh.certificates.push({ id: "cert", keyId: "key" });
    const result = await handlers["ssh:keys:delete"]({ id: "key", cascade: true });
    expect(result).toMatchObject({ ok: false, error: "in-use", hosts: [{ id: "host" }], certs: [{ id: "cert" }] });
    expect(credentialStore.deleteSecret).not.toHaveBeenCalled();
    expect(state.ssh.hosts[0].auth.keyRef).toBe("key");
  });

  test("a failed passphrase write rolls back the private key without adding metadata", async () => {
    const { handlers, credentialStore, state } = fixture();
    credentialStore.setSecret.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Keychain unavailable"));
    await expect(handlers["ssh:keys:import"]({ privateKey, passphrase: "secret", label: "rollback" })).rejects.toThrow(
      "Keychain unavailable",
    );
    expect(state.ssh.keys).toEqual([]);
    expect(credentialStore.deleteSecret).toHaveBeenCalledTimes(2);
  });

  test("does not substitute Built-in SSH for a host inheriting system SSH during a connection test", async () => {
    const { handlers, sshManager, state } = fixture();
    state.ssh.hosts.push({
      id: "host",
      name: "system",
      auth: {},
      advanced: { launchVia: "default", command: "dangerous-startup" },
    });
    const result = await handlers["ssh:hosts:test"]({ id: "host" });
    expect(result).toMatchObject({ ok: false });
    expect(sshManager.createSession).not.toHaveBeenCalled();
  });

  test("a Built-in connection test never executes the host startup command", async () => {
    const { handlers, sshManager, state } = fixture();
    state.ssh.hosts.push({
      id: "host",
      name: "built-in",
      auth: {},
      advanced: { launchVia: "ssh2", command: "dangerous-startup" },
    });
    expect(await handlers["ssh:hosts:test"]({ id: "host" })).toMatchObject({ ok: true });
    expect(sshManager.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        inlineHost: expect.objectContaining({ advanced: expect.objectContaining({ command: undefined }) }),
      }),
    );
    expect(sshManager.stop).toHaveBeenCalledTimes(1);
  });
});
