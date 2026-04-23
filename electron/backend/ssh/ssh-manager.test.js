import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { createStore } from "../store.js";
import { SshManager } from "./ssh-manager.js";
import { verifyHostKey, recordHostKey } from "./ssh-known-hosts.js";
import { buildAuth } from "./ssh-auth.js";
import { normalizeState } from "../default-state.js";

const tempDirs = [];

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-ssh-test-"));
  tempDirs.push(dir);
  return createStore(path.join(dir, "state.json"));
}

function fakeCredentialStore(initial = {}) {
  const secrets = new Map(Object.entries(initial));
  return {
    setSecret(ref, value) {
      secrets.set(ref, value);
    },
    getSecret(ref) {
      return secrets.get(ref) || "";
    },
    hasSecret(ref) {
      return secrets.has(ref);
    },
    async deleteSecret(ref) {
      secrets.delete(ref);
    },
    listRefs() {
      return [...secrets.keys()];
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("SshManager host CRUD", () => {
  test("createHost persists a normalized entry readable via listHosts", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const created = await mgr.createHost({
      name: "prod-bastion",
      host: "bastion.example.com",
      port: 22,
      username: "alice",
      auth: { methods: ["publickey"], keyRef: "ssh:key:demo", agent: "auto" },
      jump: [],
      hostKeyPolicy: "warn",
      advanced: { launchVia: "ssh2" },
      tags: ["prod"],
    });

    expect(created.id).toMatch(/^h_/);
    expect(created.createdAt).toBeDefined();

    // Regression: the old implementation read `store.state.ssh.hosts` which
    // crashed because `state` is not exposed. listHosts must work.
    const listed = mgr.listHosts();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("prod-bastion");
  });

  test("deleteHost scrubs jump references from other hosts", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const bastion = await mgr.createHost({
      name: "bastion",
      host: "b.example.com",
      port: 22,
      username: "u",
      auth: { methods: ["agent"], agent: "auto" },
      jump: [],
      hostKeyPolicy: "warn",
      advanced: {},
      tags: [],
    });
    await mgr.createHost({
      name: "target",
      host: "t.example.com",
      port: 22,
      username: "u",
      auth: { methods: ["agent"], agent: "auto" },
      jump: [bastion.id],
      hostKeyPolicy: "warn",
      advanced: {},
      tags: [],
    });

    await mgr.deleteHost(bastion.id);
    const remaining = mgr.listHosts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].jump).toEqual([]);
  });
});

describe("verifyHostKey TOFU logic", () => {
  const host = { host: "example.com", port: 22, hostKeyPolicy: "warn" };
  const keyBlob = Buffer.from("0000000b7373682d65643235353139" + "ff".repeat(32), "hex");

  test("returns ok+first for a brand-new host under accept-new/warn policy", async () => {
    const store = await freshStore();
    const result = verifyHostKey(store, host, { key: keyBlob });
    expect(result.ok).toBe(true);
    expect(result.first).toBe(true);
    expect(result.fingerprint).toMatch(/^SHA256:/);
  });

  test("rejects an unknown host under strict policy", async () => {
    const store = await freshStore();
    const result = verifyHostKey(store, { ...host, hostKeyPolicy: "strict" }, { key: keyBlob });
    expect(result.ok).toBe(false);
    expect(result.mismatch).toBe(false);
  });

  test("flags mismatch when fingerprint changed", async () => {
    const store = await freshStore();
    await recordHostKey(store, host, { fingerprint: "SHA256:old", keyType: "ssh-ed25519" });
    const result = verifyHostKey(store, host, { key: keyBlob });
    expect(result.ok).toBe(false);
    expect(result.mismatch).toBe(true);
    expect(result.previous.fingerprint).toBe("SHA256:old");
  });

  test("accepts a matching fingerprint", async () => {
    const store = await freshStore();
    const first = verifyHostKey(store, host, { key: keyBlob });
    await recordHostKey(store, host, first);
    const second = verifyHostKey(store, host, { key: keyBlob });
    expect(second.ok).toBe(true);
    expect(second.first).toBeUndefined();
  });
});

describe("normalizeState preserves SSH launch data", () => {
  test("round-trips panel.launch with saved-host reference", () => {
    const raw = {
      activeWorkspaceId: "w1",
      workspaces: [
        {
          id: "w1",
          name: "ws",
          panels: [
            {
              id: "p1",
              title: "ssh",
              command: "",
              launch: { kind: "ssh", sshHostId: "h_abc", extraField: "dropped" },
            },
          ],
          activePanelId: "p1",
        },
      ],
    };
    const normalized = normalizeState(raw);
    const panel = normalized.workspaces[0].panels[0];
    expect(panel.launch).toEqual({ kind: "ssh", sshHostId: "h_abc" });
  });

  test("round-trips panel.launch with inline ad-hoc host", () => {
    const raw = {
      activeWorkspaceId: "w1",
      workspaces: [
        {
          id: "w1",
          name: "ws",
          panels: [
            {
              id: "p1",
              title: "ssh",
              launch: {
                kind: "ssh",
                sshInline: {
                  host: "bastion.example.com",
                  port: 2222,
                  username: "alice",
                  hostKeyPolicy: "warn",
                  auth: { methods: ["agent"], agent: "auto" },
                  advanced: { launchVia: "ssh2" },
                },
              },
            },
          ],
          activePanelId: "p1",
        },
      ],
    };
    const normalized = normalizeState(raw);
    const inline = normalized.workspaces[0].panels[0].launch.sshInline;
    expect(inline.host).toBe("bastion.example.com");
    expect(inline.port).toBe(2222);
    expect(inline.username).toBe("alice");
    expect(inline.auth.methods).toEqual(["agent"]);
    expect(inline.advanced.launchVia).toBe("ssh2");
  });

  test("defaults invalid launchVia and missing fields safely", () => {
    const raw = {
      activeWorkspaceId: "w1",
      workspaces: [
        {
          id: "w1",
          name: "ws",
          panels: [
            {
              id: "p1",
              title: "ssh",
              launch: {
                kind: "ssh",
                sshInline: {
                  host: "h",
                  username: "u",
                  advanced: { launchVia: "evil-mode" },
                  auth: {},
                },
              },
            },
          ],
          activePanelId: "p1",
        },
      ],
    };
    const normalized = normalizeState(raw);
    const inline = normalized.workspaces[0].panels[0].launch.sshInline;
    expect(inline.port).toBe(22);
    expect(inline.advanced.launchVia).toBe("ssh2");
    expect(inline.auth.methods).toEqual(["publickey"]);
    expect(inline.hostKeyPolicy).toBe("warn");
  });
});

describe("SshManager.createSession inline host", () => {
  test("passes the inline host object through to SshSession (no lookup)", async () => {
    const store = await freshStore();
    const mgr = new SshManager({
      store,
      credentialStore: fakeCredentialStore({ "ssh:key:one": "priv" }),
      logger: console,
    });

    // Capture what buildAuth saw without actually starting ssh2.
    let observed = null;
    const inlineHost = {
      host: "quick.example.com",
      port: 22,
      username: "bob",
      hostKeyPolicy: "warn",
      auth: { methods: ["publickey"], keyRef: "ssh:key:one", agent: "auto" },
      advanced: { launchVia: "ssh2" },
    };

    // Stub SshSession.start to capture the host passed in without touching TCP.
    const { SshSession } = await import("./ssh-session.js");
    const origStart = SshSession.prototype.start;
    SshSession.prototype.start = async function mockStart() {
      observed = { id: this.host.id, host: this.host.host, auth: this.auth };
      // Simulate successful ready so the caller's promise resolves.
      setTimeout(() => this.onExit?.({ exitCode: 0, signal: null }), 0);
      return undefined;
    };

    try {
      await mgr.createSession({
        sessionId: "w1:p1",
        inlineHost,
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: () => {},
      });
    } finally {
      SshSession.prototype.start = origStart;
    }

    expect(observed.host).toBe("quick.example.com");
    expect(observed.id).toBe("inline:w1:p1");
    expect(observed.auth.privateKey).toBe("priv");
  });
});

describe("buildAuth", () => {
  test("auto-resolves passphrase from derived ref when key is encrypted", async () => {
    const creds = fakeCredentialStore({
      "ssh:key:abc": "-----BEGIN OPENSSH PRIVATE KEY-----\n…",
      "ssh:passphrase:ssh:key:abc": "hunter2",
    });
    const cfg = await buildAuth(
      {
        auth: { methods: ["publickey"], keyRef: "ssh:key:abc" },
      },
      creds,
    );
    expect(cfg.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(cfg.passphrase).toBe("hunter2");
  });

  test("combines multiple methods without dropping any", async () => {
    const creds = fakeCredentialStore({ "ssh:key:x": "priv" });
    const cfg = await buildAuth(
      {
        auth: {
          methods: ["publickey", "keyboard-interactive"],
          keyRef: "ssh:key:x",
        },
      },
      creds,
    );
    expect(cfg.privateKey).toBe("priv");
    expect(cfg.tryKeyboard).toBe(true);
  });
});
