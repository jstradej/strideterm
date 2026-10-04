/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStore } from "../store.js";
import { SshManager } from "./ssh-manager.js";
import { verifyHostKey, recordHostKey } from "./ssh-known-hosts.js";
import { buildAuth } from "./ssh-auth.js";
import { sshHostUpdateSchema } from "../ipc-schemas.js";
import { normalizeState } from "../default-state.js";
import type { CredentialStore } from "../shared/credential-store.js";

const tempDirs: string[] = [];

beforeEach(async () => {
  const { SshSession } = await import("./ssh-session.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double needs access to the session's negotiated auth fixture
  vi.spyOn(SshSession.prototype, "start").mockImplementation(async function (this: any) {
    if (!this.auth.promptPassword) return;
    await new Promise<void>((resolve, reject) => {
      this.onPasswordPrompt?.((password: string | null) =>
        password === null ? reject(new Error("Authentication cancelled")) : resolve(),
      );
    });
  });
});

async function freshStore(): Promise<Awaited<ReturnType<typeof createStore>>> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-ssh-test-"));
  tempDirs.push(dir);
  return createStore(path.join(dir, "state.json"));
}

function fakeCredentialStore(initial: Record<string, string> = {}): CredentialStore {
  const secrets = new Map(Object.entries(initial));
  return {
    async setSecret(ref: string, value: string) {
      secrets.set(ref, value);
    },
    getSecret(ref: string) {
      return secrets.get(ref) || "";
    },
    hasSecret(ref: string) {
      return secrets.has(ref);
    },
    async deleteSecret(ref: string) {
      secrets.delete(ref);
    },
    listRefs() {
      return [...secrets.keys()];
    },
    isEncryptionAvailable() {
      return true;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
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

  test("a host created without auth inherits the global agent mode", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });
    const created = await mgr.createHost({ name: "inherits-agent", host: "agent.example.com" });

    expect(created.auth).toEqual({ methods: ["publickey"] });
    const auth = await buildAuth({ ...created, auth: { methods: ["agent"] } }, fakeCredentialStore(), {
      defaultAgentMode: "off",
    });
    expect(auth.agent).toBeUndefined();
  });

  test("a name-only patch preserves hidden auth, jump, and advanced settings", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });
    const host = await mgr.createHost({
      name: "before",
      host: "target.example.com",
      auth: { methods: ["publickey", "password"], keyRef: "ssh:key:one", passwordRef: "ssh:password:one" },
      jump: ["bastion-id"],
      advanced: {
        launchVia: "system-ssh",
        portOverride: false,
        keepaliveIntervalMs: 15000,
        env: { TERM: "xterm-256color" },
        wsl: { distro: "Ubuntu", user: "dev", exec: "/usr/bin/ssh" },
      },
      tags: ["prod"],
    });

    const patch = sshHostUpdateSchema.parse({ id: host.id, patch: { name: "after" } }).patch;
    const updated = await mgr.updateHost(host.id, patch);
    expect(updated).toMatchObject({
      name: "after",
      auth: { methods: ["publickey", "password"], keyRef: "ssh:key:one", passwordRef: "ssh:password:one" },
      jump: ["bastion-id"],
      advanced: {
        launchVia: "system-ssh",
        portOverride: false,
        keepaliveIntervalMs: 15000,
        env: { TERM: "xterm-256color" },
        wsl: { distro: "Ubuntu", user: "dev", exec: "/usr/bin/ssh" },
      },
      tags: ["prod"],
    });
  });

  test("null port and WSL overrides clear saved overrides without losing sibling settings", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });
    const host = await mgr.createHost({
      name: "target",
      host: "target.example.com",
      port: 22,
      advanced: { launchVia: "wsl", portOverride: true, wsl: { distro: "Ubuntu", user: "dev" }, keepaliveCountMax: 3 },
    });
    const updated = await mgr.updateHost(host.id, {
      port: null,
      advanced: { portOverride: false, wsl: { distro: null } },
    } as never);
    expect(updated?.port).toBeUndefined();
    expect(updated?.advanced).toMatchObject({ launchVia: "wsl", portOverride: false, keepaliveCountMax: 3 });
    expect(updated?.advanced?.wsl).toEqual({ distro: null, user: "dev" });
  });

  test("deleteHost reports jump and launch dependencies without changing references", async () => {
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: test fixture adds a workspace to the persisted state
    await store.mutate((state: any) => {
      state.workspaces.push({
        id: "workspace-1",
        name: "SSH workspace",
        profileId: "default",
        panels: [{ id: "panel-1", title: "SSH target", launch: { kind: "ssh", sshHostId: bastion.id } }],
      });
    });

    const result = await mgr.deleteHost(bastion.id);
    expect(result).toMatchObject({
      ok: false,
      error: "in-use",
      hosts: [{ name: "target" }],
      workspaces: [
        { workspaceId: "workspace-1", workspaceName: "SSH workspace", panelId: "panel-1", panelTitle: "SSH target" },
      ],
    });
    expect(mgr.listHosts()).toHaveLength(2);
    expect(mgr.listHosts().find((host) => host.name === "target")?.jump).toEqual([bastion.id]);
  });
});

describe("SshManager key metadata", () => {
  test("renames only the key label and preserves host/certificate references and secret refs", async () => {
    const store = await freshStore();
    const credentials = fakeCredentialStore({
      "ssh:key:stable": "private-key-material",
      "ssh:passphrase:ssh:key:stable": "private-key-passphrase",
    });
    const mgr = new SshManager({ store, credentialStore: credentials, logger: console });
    const createdAt = "2025-04-03T12:00:00.000Z";
    const key = {
      id: "ssh:key:stable",
      label: "Old label",
      kind: "ssh-ed25519",
      publicKey: "ssh-ed25519 AAAA",
      fingerprint: "SHA256:test",
      hasPassphrase: true,
      createdAt,
    };
    await store.mutate((state) => {
      state.ssh!.keys!.push(key);
      state.ssh!.certificates!.push({ id: "cert:one", keyId: key.id, keyIdString: "workstation", createdAt });
    });
    const host = await mgr.createHost({
      name: "uses-key",
      host: "example.test",
      auth: { methods: ["publickey"], keyRef: key.id },
    });
    const stateEvents = vi.fn();
    mgr.on("ssh:state", stateEvents);

    const renamed = await mgr.renameKey({ id: key.id, label: "  New label  " });

    expect(renamed).toEqual({ ...key, label: "New label" });
    expect(store.getState().ssh.keys).toEqual([{ ...key, label: "New label" }]);
    expect(mgr.getHost(host.id)?.auth?.keyRef).toBe(key.id);
    expect(store.getState().ssh.certificates).toEqual([
      { id: "cert:one", keyId: key.id, keyIdString: "workstation", createdAt },
    ]);
    expect(credentials.listRefs()).toEqual([key.id, `ssh:passphrase:${key.id}`]);
    expect(stateEvents).toHaveBeenCalledTimes(1);
  });

  test("rejects blank and oversized labels without changing metadata", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });
    const key = {
      id: "ssh:key:stable",
      label: "Original",
      kind: "ssh-ed25519",
      hasPassphrase: false,
      createdAt: "2025-04-03T12:00:00.000Z",
    };
    await store.mutate((state) => {
      state.ssh!.keys!.push(key);
    });

    await expect(mgr.renameKey({ id: key.id, label: "  \t " })).rejects.toThrow("between 1 and 60 characters");
    await expect(mgr.renameKey({ id: key.id, label: "x".repeat(61) })).rejects.toThrow("between 1 and 60 characters");
    expect(store.getState().ssh.keys).toEqual([key]);
  });

  test("returns null for an unknown key id without emitting state", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });
    const stateEvents = vi.fn();
    mgr.on("ssh:state", stateEvents);

    await expect(mgr.renameKey({ id: "missing", label: "Renamed" })).resolves.toBeNull();
    expect(stateEvents).not.toHaveBeenCalled();
  });
});

describe("verifyHostKey TOFU logic", () => {
  const host = { host: "example.com", port: 22, hostKeyPolicy: "warn" };
  const keyBlob = Buffer.from("0000000b7373682d65643235353139" + "ff".repeat(32), "hex");

  test("returns ok+first for a brand-new host under accept-new/warn policy", async () => {
    const store = await freshStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = verifyHostKey(store, host, { key: keyBlob }) as any;
    expect(result.ok).toBe(true);
    expect(result.first).toBe(true);
    expect(result.fingerprint).toMatch(/^SHA256:/);
  });

  test("rejects an unknown host under strict policy", async () => {
    const store = await freshStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = verifyHostKey(store, { ...host, hostKeyPolicy: "strict" }, { key: keyBlob }) as any;
    expect(result.ok).toBe(false);
    expect(result.mismatch).toBe(false);
  });

  test("flags mismatch when fingerprint changed", async () => {
    const store = await freshStore();
    await recordHostKey(store, host, { fingerprint: "SHA256:old", keyType: "ssh-ed25519" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = verifyHostKey(store, host, { key: keyBlob }) as any;
    expect(result.ok).toBe(false);
    expect(result.mismatch).toBe(true);
    expect(result.previous.fingerprint).toBe("SHA256:old");
  });

  test("accepts a matching fingerprint", async () => {
    const store = await freshStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = verifyHostKey(store, host, { key: keyBlob }) as any;
    await recordHostKey(store, host, first);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = verifyHostKey(store, host, { key: keyBlob }) as any;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inline: any = normalized.workspaces[0].panels[0].launch!.sshInline;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inline: any = normalized.workspaces[0].panels[0].launch!.sshInline;
    expect(inline.port).toBeUndefined();
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let observed: any = null;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SshSession.prototype.start = async function mockStart(this: any) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      observed = { id: this.host.id, host: this.host.host, auth: this.auth as any };
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

    expect(observed!.host).toBe("quick.example.com");
    expect(observed!.id).toBe("inline:w1:p1");
    expect(observed!.auth.privateKey).toBe("priv");
  });
});

describe("SshManager generation guard (late exit)", () => {
  const inlineHost = {
    host: "h.example.com",
    port: 22,
    username: "u",
    hostKeyPolicy: "warn",
    auth: { methods: ["agent"], agent: "auto" },
    advanced: { launchVia: "ssh2" },
  };

  test("a late exit from a superseded generation leaves the reconnect intact", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const states: Array<{ sessionId: string; status: string }> = [];
    mgr.on("ssh:connection-state", (e: { sessionId: string; status: string }) => states.push(e));

    // Capture each generation's INTERNAL onExit (the manager's own closure) by
    // stubbing start() to resolve as "ready" and record `this.onExit`.
    const captured: Array<(_e: { exitCode: number; signal: string | null }) => void> = [];
    const { SshSession } = await import("./ssh-session.js");
    const origStart = SshSession.prototype.start;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SshSession.prototype.start = async function mockStart(this: any) {
      captured.push(this.onExit);
    };

    const gen2CallerExits: unknown[] = [];
    try {
      // Generation 1 connects.
      await mgr.createSession({
        sessionId: "w:p",
        inlineHost,
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: () => {},
      });
      const gen1 = mgr.activeSessions.get("w:p");

      // Reconnect: generation 2 takes over the SAME id (restart reuses it).
      await mgr.createSession({
        sessionId: "w:p",
        inlineHost,
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: (e) => gen2CallerExits.push(e),
      });
      const gen2 = mgr.activeSessions.get("w:p");
      expect(gen2).not.toBe(gen1);

      states.length = 0; // ignore the connecting churn from setup

      // Generation 1's socket finally closes — its onExit fires LATE, after
      // generation 2 is already established under the same id.
      captured[0]!({ exitCode: 0, signal: null });
    } finally {
      SshSession.prototype.start = origStart;
    }

    // The superseded exit was dropped: gen2 stays registered, no disconnect is
    // emitted for it, and its caller onExit was never invoked by the old close.
    expect(mgr.activeSessions.get("w:p")).not.toBeUndefined();
    expect(mgr.pendingPrompts.get("w:p")).not.toBeUndefined();
    expect(states).toEqual([]);
    expect(gen2CallerExits).toEqual([]);
  });

  test("a normal exit (no successor) still reports disconnected", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const states: Array<{ sessionId: string; status: string }> = [];
    mgr.on("ssh:connection-state", (e: { sessionId: string; status: string }) => states.push(e));

    let captured: ((_e: { exitCode: number; signal: string | null }) => void) | undefined;
    const { SshSession } = await import("./ssh-session.js");
    const origStart = SshSession.prototype.start;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SshSession.prototype.start = async function mockStart(this: any) {
      captured = this.onExit;
    };

    const callerExits: unknown[] = [];
    try {
      await mgr.createSession({
        sessionId: "w:p",
        inlineHost,
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: (e) => callerExits.push(e),
      });
      states.length = 0;
      captured!({ exitCode: 0, signal: null });
    } finally {
      SshSession.prototype.start = origStart;
    }

    // The guard must not over-suppress: a single-generation exit still tears the
    // session down and reports disconnected.
    expect(states).toContainEqual(
      expect.objectContaining({ sessionId: "w:p", status: "disconnected", connected: false }),
    );
    expect(callerExits).toEqual([{ exitCode: 0, signal: null }]);
    expect(mgr.activeSessions.has("w:p")).toBe(false);
    expect(mgr.pendingPrompts.has("w:p")).toBe(false);
  });
});

describe("SshManager.stop cancels a pending connect", () => {
  test("rejects a connect blocked on the up-front password prompt", async () => {
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const inlineHost = {
      host: "h.example.com",
      port: 22,
      username: "u",
      hostKeyPolicy: "warn",
      // keyboard-interactive with no key/agent → createSession parks on the
      // up-front password prompt before it ever builds an SshSession.
      auth: { methods: ["keyboard-interactive"] },
      advanced: { launchVia: "ssh2" },
    };

    const promptSeen = new Promise<void>((resolve) => mgr.once("ssh:auth-prompt", () => resolve()));
    const connect = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });

    await promptSeen;
    // The connect is parked on the pre-auth promise; its decision is live.
    expect(mgr.pendingPrompts.get("w:p")?.finishPassword).toBeTypeOf("function");

    await mgr.stop("w:p");

    // Cancelling rejects the pre-auth promise → the connect rejects instead of
    // hanging forever, and nothing is left behind in the maps.
    await expect(connect).rejects.toThrow(/cancel/i);
    expect(mgr.pendingPrompts.has("w:p")).toBe(false);
    expect(mgr.activeSessions.has("w:p")).toBe(false);
  });

  test("cancels a connect torn down during the pre-registration auth window", async () => {
    // A stop() landing WHILE buildAuth / jump-host auth is still resolving — before
    // the connect ever registers its prompt — must still cancel it. The pending
    // record is registered up-front, so stop() removes it, and the post-await abort
    // check rejects the connect. Without this the connect would sail past the
    // teardown and park on a prompt/handshake nothing could reach.
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const inlineHost = {
      host: "h.example.com",
      port: 22,
      username: "u",
      hostKeyPolicy: "warn",
      auth: { methods: ["keyboard-interactive"] },
      advanced: { launchVia: "ssh2" },
    };

    let promptEmitted = false;
    mgr.on("ssh:auth-prompt", () => {
      promptEmitted = true;
    });

    // stop() runs synchronously, before the connect awaits past buildAuth and
    // shows its prompt — the exact window this fix closes.
    const connect = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    await mgr.stop("w:p");

    await expect(connect).rejects.toThrow(/cancel/i);
    // The abort fired before any prompt was shown, and nothing is left behind.
    expect(promptEmitted).toBe(false);
    expect(mgr.pendingPrompts.has("w:p")).toBe(false);
    expect(mgr.activeSessions.has("w:p")).toBe(false);
  });
});

describe("SshManager prompt generation scoping", () => {
  const inlineHost = {
    host: "h.example.com",
    port: 22,
    username: "u",
    hostKeyPolicy: "warn",
    auth: { methods: ["keyboard-interactive"] },
    advanced: { launchVia: "ssh2" },
  };

  test("a disconnected pre-auth prompt does not delete the reconnect's pending record", async () => {
    // Gen1 parks on the up-front password prompt; a Disconnect rejects it, then an
    // immediate reconnect registers gen2's pending under the same id. Gen1's
    // DEFERRED pre-auth catch must not delete gen2's record (identity-guarded), or
    // gen2 would fail its own abort check and never connect.
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const seen = new Promise<void>((r) => mgr.once("ssh:auth-prompt", () => r()));
    const gen1 = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    await seen;
    const gen1Pending = mgr.pendingPrompts.get("w:p");

    // Disconnect gen1 (rejects its pre-auth; the catch runs on a later microtask),
    // then IMMEDIATELY reconnect — gen2 registers its own pending synchronously.
    // Cancel carries gen1's promptId (the guard is now unconditional).
    mgr.cancelAuthPrompt("w:p", gen1Pending!.activePromptId);
    const gen2 = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    const gen2Pending = mgr.pendingPrompts.get("w:p");
    expect(gen2Pending).not.toBe(gen1Pending);

    // Gen1's deferred pre-auth catch must NOT delete gen2's record.
    await expect(gen1).rejects.toThrow(/cancel/i);
    expect(mgr.pendingPrompts.get("w:p")).toBe(gen2Pending);

    await mgr.stop("w:p");
    await expect(gen2).rejects.toThrow();
  });

  test("answerAuthPrompt ignores an answer scoped to a superseded prompt generation", async () => {
    // A stale dialog left open on another client after a reconnect must not feed
    // its answer into the NEW connection: answers carry the generation's promptId.
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    // Gen1 parks on the password prompt, then is torn down.
    const seen1 = new Promise<void>((r) => mgr.once("ssh:auth-prompt", () => r()));
    const gen1 = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    await seen1;
    const promptId1 = mgr.pendingPrompts.get("w:p")!.activePromptId;
    await mgr.stop("w:p");
    await expect(gen1).rejects.toThrow();

    // Gen2 (reconnect) parks on its own prompt with a DIFFERENT promptId.
    const seen2 = new Promise<void>((r) => mgr.once("ssh:auth-prompt", () => r()));
    const gen2 = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    await seen2;
    const promptId2 = mgr.pendingPrompts.get("w:p")!.activePromptId;
    expect(promptId2).not.toBe(promptId1);

    // An answer aimed at gen1's promptId is IGNORED — gen2 stays parked.
    mgr.answerAuthPrompt("w:p", ["stale"], promptId1);
    expect(mgr.pendingPrompts.get("w:p")?.finishPassword).toBeTypeOf("function");

    await mgr.stop("w:p");
    await expect(gen2).rejects.toThrow();
  });

  test("answerAuthPrompt without a promptId no longer bypasses the generation guard", async () => {
    // Finding 5: promptId was optional and the guard only ran when the client
    // sent it, so a stale/spoofed client could feed an answer into the CURRENT
    // prompt with just the sessionId. The guard is now unconditional (and the IPC
    // schema requires promptId), so a tokenless answer is ignored — the prompt
    // stays parked instead of resolving with the caller's input.
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const seen = new Promise<void>((r) => mgr.once("ssh:auth-prompt", () => r()));
    const connect = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    await seen;
    expect(mgr.pendingPrompts.get("w:p")?.finishPassword).toBeTypeOf("function");

    // No promptId → ignored; the pre-auth prompt is NOT resolved.
    mgr.answerAuthPrompt("w:p", ["secret"]);
    expect(mgr.pendingPrompts.get("w:p")?.finishPassword).toBeTypeOf("function");

    await mgr.stop("w:p");
    await expect(connect).rejects.toThrow();
  });

  test("cancelAuthPrompt without a promptId no longer bypasses the generation guard", async () => {
    // Finding 2: symmetric to answerAuthPrompt. Cancel's guard used to run only
    // when the client sent a promptId, so a stale/spoofed client could dismiss
    // the CURRENT prompt with just the sessionId. The guard is now unconditional
    // (and the IPC schema requires promptId), so a tokenless cancel is ignored —
    // the pre-auth prompt stays parked instead of being rejected out from under a
    // live connect.
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const seen = new Promise<void>((r) => mgr.once("ssh:auth-prompt", () => r()));
    const connect = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    await seen;
    expect(mgr.pendingPrompts.get("w:p")?.finishPassword).toBeTypeOf("function");

    // No promptId → ignored; the pre-auth prompt is NOT cancelled.
    mgr.cancelAuthPrompt("w:p");
    expect(mgr.pendingPrompts.get("w:p")?.finishPassword).toBeTypeOf("function");

    await mgr.stop("w:p");
    await expect(connect).rejects.toThrow();
  });

  test("rejectHostKey without a promptId no longer bypasses the generation guard", async () => {
    // Finding 2: symmetric to acceptHostKey. Reject's guard used to run only when
    // the client sent a promptId, so a stale/spoofed client could reject the
    // CURRENT host-key decision with just the sessionId, aborting a newer
    // connection. The guard is now unconditional (and the IPC schema requires
    // promptId). Seed a pending decision directly — a live TOFU mismatch is
    // awkward to drive in a unit test and the guard only reads promptId + the cb.
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    let decided: boolean | null = null;
    mgr.pendingPrompts.set("w:p", {
      promptId: "w:p#7",
      activePromptId: "w:p#7",
      finishKeyboard: null,
      finishPassword: null,
      acceptHostKeyCb: (accept: boolean) => {
        decided = accept;
      },
      hostKeyInfo: null,
      resolvePreAuth: null,
      rejectPreAuth: null,
    });

    // Tokenless reject → ignored; the decision cb is NOT invoked and stays pending.
    mgr.rejectHostKey("w:p");
    expect(decided).toBeNull();
    expect(mgr.pendingPrompts.get("w:p")?.acceptHostKeyCb).toBeTypeOf("function");

    // A superseded token → still ignored.
    mgr.rejectHostKey("w:p", "w:p#6");
    expect(decided).toBeNull();

    // The matching token → the decision fires (rejected) and the cb is cleared.
    mgr.rejectHostKey("w:p", "w:p#7");
    expect(decided).toBe(false);
    expect(mgr.pendingPrompts.get("w:p")?.acceptHostKeyCb).toBeNull();
  });

  test("stop() emits ssh:auth-prompt-cancel scoped to the prompt generation", async () => {
    // Teardown must tell clients to dismiss the open dialog (multi-client: another
    // client's stale password/host-key dialog would otherwise linger).
    const store = await freshStore();
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: console });

    const dismissed: Array<{ sessionId: string; promptId: string }> = [];
    mgr.on("ssh:auth-prompt-cancel", (e: { sessionId: string; promptId: string }) => dismissed.push(e));

    const seen = new Promise<void>((r) => mgr.once("ssh:auth-prompt", () => r()));
    const connect = mgr.createSession({
      sessionId: "w:p",
      inlineHost,
      cols: 80,
      rows: 24,
      onData: () => {},
      onExit: () => {},
    });
    await seen;
    const promptId = mgr.pendingPrompts.get("w:p")!.activePromptId;

    await mgr.stop("w:p");
    await expect(connect).rejects.toThrow();

    expect(dismissed).toContainEqual({ sessionId: "w:p", promptId });
  });
});

describe("SshManager onReady host-key persistence failure", () => {
  test("warns with the host id and error when recordHostKey's store write rejects", async () => {
    // Security-relevant: TOFU pinning silently failing to persist means a later
    // MITM host-key swap looks identical to a normal first connection (no
    // baseline was ever recorded). The write failure must at least be surfaced
    // via the logger instead of swallowed by an empty .catch(() => {}).
    const warn = vi.fn();
    const fakeLogger = { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn(), trace: vi.fn() };
    const mutateError = new Error("disk full");
    const store = {
      getState: () => ({ ssh: { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} } }),
      mutate: vi.fn(() => Promise.reject(mutateError)),
    };
    const mgr = new SshManager({ store, credentialStore: fakeCredentialStore(), logger: fakeLogger });

    const inlineHost = {
      host: "h.example.com",
      port: 22,
      username: "u",
      hostKeyPolicy: "warn",
      auth: { methods: ["agent"], agent: "auto" },
      advanced: { launchVia: "ssh2" },
    };

    const { SshSession } = await import("./ssh-session.js");
    const origStart = SshSession.prototype.start;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SshSession.prototype.start = async function mockStart(this: any) {
      // Simulate a first-time TOFU accept: onReady fires with verifiedHostKey.first set,
      // which is what triggers the manager's fire-and-forget recordHostKey() call.
      this.verifiedHostKey = { first: true, fingerprint: "SHA256:abc", keyType: "ssh-ed25519" };
      this.onReady?.();
    };

    try {
      await mgr.createSession({
        sessionId: "w:p",
        inlineHost,
        cols: 80,
        rows: 24,
        onData: () => {},
        onExit: () => {},
      });
    } finally {
      SshSession.prototype.start = origStart;
    }

    // Let the fire-and-forget .catch() microtask run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith(
      "failed to persist host key",
      expect.objectContaining({ hostId: "inline:w:p", err: mutateError }),
    );
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
