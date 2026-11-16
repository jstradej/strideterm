import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCredentialStore } from "./credential-store.js";
import { createRuntimeCredentials } from "./runtime-credentials.js";
import type { CredentialOwnerState } from "./credential-classifier.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const fakeSafeStorage = {
  encryptString: (value: string) => Buffer.from(`enc:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^enc:/u, ""),
  isEncryptionAvailable: () => true,
};

const state: CredentialOwnerState = {
  profiles: [{ id: "default", name: "Work" }],
  ssh: { hosts: [], keys: [{ id: "ssh:key:k1", label: "Laptop key" }], certificates: [] },
  settings: {
    integrations: {
      azureDevops: { connections: [{ id: "ado-1", label: "Corp ADO", tokenRef: "cred:ado-1", profileId: "default" }] },
      registry: { connections: [{ id: "reg-1", label: "Corp Maven", profileId: "default", authKind: "basic" }] },
    },
  },
};

const SECRETS = {
  "cred:ado-1": "ado-pat-VALUE-1",
  "cred:orphan": "orphan-VALUE-2",
  "registry:reg-1:secret": "registry-VALUE-3",
  "ssh:key:k1": "-----BEGIN KEY-----VALUE-4",
  "ssh:key:stray": "stray-key-VALUE-5",
  "mobile:desktop-device-private-key": "mobile-VALUE-6",
  "remote:access-token": "remote-VALUE-7",
  "account:owner-email": "account-VALUE-8",
  "unknown:thing": "unknown-VALUE-9",
};

async function setup(options: { encrypted?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-overview-"));
  tempDirs.push(dir);
  const credentialStore = await createCredentialStore(path.join(dir, "credentials.json"), {
    safeStorage: options.encrypted === false ? null : fakeSafeStorage,
  });
  for (const [ref, value] of Object.entries(SECRETS)) {
    if (options.encrypted === false && ref.startsWith("mobile:")) continue;
    await credentialStore.setSecret(ref, value, {
      forcePlaintext: ref.startsWith("ssh:") && options.encrypted === false,
    });
  }
  const broadcastState = vi.fn();
  const runtime = createRuntimeCredentials({ getState: () => state, credentialStore, broadcastState });
  return { credentialStore, broadcastState, runtime };
}

describe("runtime credentials", () => {
  test("lists metadata for in-scope secrets only, and the serialised result holds no stored value", async () => {
    const { runtime } = await setup();
    const overview = runtime.list();
    expect(overview.rows.map((row) => row.ref).sort()).toEqual(
      ["cred:ado-1", "cred:orphan", "registry:reg-1:secret", "ssh:key:k1", "ssh:key:stray"].sort(),
    );
    const text = JSON.stringify(overview);
    for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
    for (const hidden of ["mobile:", "remote:", "account:", "unknown:"]) expect(text).not.toContain(hidden);
    expect(overview.rows.find((row) => row.ref === "cred:orphan")?.orphan).toBe(true);
    expect(overview.rows.find((row) => row.ref === "cred:ado-1")).toMatchObject({
      ownerLabel: "Corp ADO",
      profileName: "Work",
      orphan: false,
    });
  });

  test("reports per-entry storage: encrypted with a keychain, plaintext without one", async () => {
    const encrypted = await setup();
    expect(encrypted.runtime.list()).toMatchObject({ encryptionAvailable: true });
    expect(new Set(encrypted.runtime.list().rows.map((row) => row.storage))).toEqual(new Set(["encrypted"]));

    const plain = await setup({ encrypted: false });
    expect(plain.runtime.list().encryptionAvailable).toBe(false);
    expect(new Set(plain.runtime.list().rows.map((row) => row.storage))).toEqual(new Set(["plain"]));
  });

  test("removal deletes exactly the named reference and tells the UI to refresh", async () => {
    const { runtime, credentialStore, broadcastState } = await setup();
    expect(await runtime.remove("cred:ado-1")).toEqual({ removed: 1 });
    expect(credentialStore.hasSecret("cred:ado-1")).toBe(false);
    for (const ref of Object.keys(SECRETS).filter((item) => item !== "cred:ado-1")) {
      expect(credentialStore.hasSecret(ref), ref).toBe(true);
    }
    expect(broadcastState).toHaveBeenCalledTimes(1);
  });

  test("an out-of-scope or unknown reference is refused and nothing changes", async () => {
    const { runtime, credentialStore, broadcastState } = await setup();
    for (const ref of [
      "mobile:desktop-device-private-key",
      "remote:access-token",
      "account:owner-email",
      "unknown:thing",
      "nope",
    ]) {
      await expect(runtime.remove(ref), ref).rejects.toThrow(/not one strIDEterm lets you remove/);
    }
    expect(credentialStore.listRefs().sort()).toEqual(Object.keys(SECRETS).sort());
    expect(broadcastState).not.toHaveBeenCalled();
  });

  test("remove orphans deletes unreferenced secrets only, never a referenced or out-of-scope one", async () => {
    const { runtime, credentialStore } = await setup();
    expect(await runtime.removeOrphans()).toEqual({ removed: 2 });
    expect(credentialStore.hasSecret("cred:orphan")).toBe(false);
    expect(credentialStore.hasSecret("ssh:key:stray")).toBe(false);
    for (const ref of [
      "cred:ado-1",
      "registry:reg-1:secret",
      "ssh:key:k1",
      "mobile:desktop-device-private-key",
      "remote:access-token",
      "account:owner-email",
      "unknown:thing",
    ]) {
      expect(credentialStore.hasSecret(ref), ref).toBe(true);
    }
    expect(await runtime.removeOrphans()).toEqual({ removed: 0 });
  });

  test("a failing delete reaches the caller, and the orphans that could be removed still are", async () => {
    const { credentialStore, broadcastState } = await setup();
    const original = credentialStore.deleteSecret.bind(credentialStore);
    const failing = {
      ...credentialStore,
      listRefs: credentialStore.listRefs,
      deleteSecret: async (ref: string) => {
        if (ref === "cred:orphan") throw new Error("disk is full");
        await original(ref);
      },
    };
    const runtime = createRuntimeCredentials({ getState: () => state, credentialStore: failing, broadcastState });
    await expect(runtime.removeOrphans()).rejects.toThrow(/Removed 1 of 2.*disk is full/);
    expect(credentialStore.hasSecret("ssh:key:stray")).toBe(false);
    expect(credentialStore.hasSecret("cred:orphan")).toBe(true);
    await expect(runtime.remove("cred:orphan")).rejects.toThrow(/disk is full/);
  });
});
