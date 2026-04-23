import { randomBytes } from "node:crypto";
import {
  sshHostCreateSchema,
  sshHostUpdateSchema,
  sshHostDeleteSchema,
  sshKeyImportSchema,
  sshKeyGenerateSchema,
  sshCertImportSchema,
  sshAuthAnswerSchema,
  sshAcceptHostKeySchema,
  sshConfigImportSchema,
  sshKnownHostsImportSchema,
} from "../ipc-schemas.js";
import { generateKey } from "./ssh-keygen.js";
import { parseCertificate } from "./ssh-cert.js";

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function createSshHandlers({ sshManager, store, credentialStore, broadcastState }) {
  function countReferences(keyId) {
    const state = store.getState();
    const hosts = (state.ssh?.hosts || []).filter((h) => h.auth?.keyRef === keyId);
    const certs = (state.ssh?.certificates || []).filter((c) => c.keyId === keyId);
    return { hosts, certs };
  }

  return {
    async "ssh:hosts:list"() {
      return sshManager.listHosts();
    },

    async "ssh:hosts:create"(payload) {
      const parsed = sshHostCreateSchema.parse(payload);
      const host = await sshManager.createHost(parsed);
      broadcastState();
      return host;
    },

    async "ssh:hosts:update"(payload) {
      const parsed = sshHostUpdateSchema.parse(payload);
      const host = await sshManager.updateHost(parsed.id, parsed.patch);
      broadcastState();
      return host;
    },

    async "ssh:hosts:delete"(payload) {
      const parsed = sshHostDeleteSchema.parse(payload);
      await sshManager.deleteHost(parsed.id);
      broadcastState();
      return { ok: true };
    },

    async "ssh:hosts:duplicate"(payload) {
      const host = sshManager.getHost(payload?.id);
      if (!host) throw new Error("Host not found");
      const copy = { ...host, name: `${host.name} (copy)` };
      delete copy.id;
      delete copy.createdAt;
      delete copy.updatedAt;
      delete copy.lastConnectedAt;
      const newHost = await sshManager.createHost(copy);
      broadcastState();
      return newHost;
    },

    async "ssh:hosts:test"(payload) {
      const host = sshManager.getHost(payload?.id);
      if (!host) throw new Error("Host not found");

      const sessionId = `ssh-test-${Date.now()}-${randomBytes(3).toString("hex")}`;
      try {
        await sshManager.createSession({
          sessionId,
          hostId: host.id,
          cols: 80,
          rows: 24,
          onData: () => {},
          onExit: () => {},
        });
      } catch (err) {
        return { ok: false, error: err.message };
      }

      try {
        await sshManager.stop(sessionId);
      } catch {
        // best effort cleanup
      }
      return { ok: true, message: "Connected and disconnected cleanly" };
    },

    async "ssh:keys:list"() {
      return store.getState().ssh?.keys || [];
    },

    async "ssh:keys:import"(payload) {
      const parsed = sshKeyImportSchema.parse(payload);
      const id = newId("ssh:key:");
      const keyMeta = {
        id,
        label: parsed.label || "Imported key",
        kind: inferKeyKind(parsed.privateKey),
        hasPassphrase: Boolean(parsed.passphrase),
        createdAt: new Date().toISOString(),
      };

      await credentialStore.setSecret(id, parsed.privateKey);
      if (parsed.passphrase) {
        await credentialStore.setSecret(`ssh:passphrase:${id}`, parsed.passphrase);
      }

      await store.mutate((state) => {
        if (!state.ssh) state.ssh = { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} };
        if (!Array.isArray(state.ssh.keys)) state.ssh.keys = [];
        state.ssh.keys.push(keyMeta);
      });
      broadcastState();
      return keyMeta;
    },

    async "ssh:keys:generate"(payload) {
      const parsed = sshKeyGenerateSchema.parse(payload);
      const { privateKey, publicKey, source } = await generateKey({
        kind: parsed.kind,
        comment: parsed.comment || "",
        passphrase: parsed.passphrase || "",
      });

      const id = newId("ssh:key:");
      const keyMeta = {
        id,
        label: parsed.comment || `${parsed.kind} key`,
        kind: parsed.kind,
        publicKey: publicKey.trim(),
        hasPassphrase: Boolean(parsed.passphrase),
        source,
        createdAt: new Date().toISOString(),
      };

      await credentialStore.setSecret(id, privateKey);
      if (parsed.passphrase) {
        await credentialStore.setSecret(`ssh:passphrase:${id}`, parsed.passphrase);
      }

      await store.mutate((state) => {
        if (!state.ssh) state.ssh = { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} };
        if (!Array.isArray(state.ssh.keys)) state.ssh.keys = [];
        state.ssh.keys.push(keyMeta);
      });
      broadcastState();
      return keyMeta;
    },

    async "ssh:keys:delete"(payload) {
      const id = payload?.id;
      if (!id) throw new Error("Missing key id");
      const { hosts, certs } = countReferences(id);
      const cascade = payload?.cascade === true;

      if ((hosts.length > 0 || certs.length > 0) && !cascade) {
        return {
          ok: false,
          error: "in-use",
          hosts: hosts.map((h) => ({ id: h.id, name: h.name })),
          certs: certs.map((c) => ({ id: c.id, keyIdString: c.keyIdString || c.id })),
        };
      }

      await credentialStore.deleteSecret(id);
      await credentialStore.deleteSecret(`ssh:passphrase:${id}`);

      await store.mutate((state) => {
        if (!state.ssh) return;
        state.ssh.keys = (state.ssh.keys || []).filter((k) => k.id !== id);
        state.ssh.certificates = (state.ssh.certificates || []).filter((c) => c.keyId !== id);
        state.ssh.hosts = (state.ssh.hosts || []).map((h) =>
          h.auth?.keyRef === id ? { ...h, auth: { ...h.auth, keyRef: "", certRef: h.auth.certRef } } : h,
        );
      });
      broadcastState();
      return { ok: true };
    },

    async "ssh:certs:list"() {
      return store.getState().ssh?.certificates || [];
    },

    async "ssh:certs:import"(payload) {
      const parsed = sshCertImportSchema.parse(payload);
      const decoded = parseCertificate(parsed.certificate);
      const id = newId("ssh:cert:");
      const cert = {
        id,
        keyId: parsed.keyId || "",
        publicCert: parsed.certificate.trim(),
        createdAt: new Date().toISOString(),
        ...decoded,
      };
      await credentialStore.setSecret(id, parsed.certificate);
      await store.mutate((state) => {
        if (!state.ssh) state.ssh = { hosts: [], keys: [], certificates: [], knownHosts: {}, settings: {} };
        if (!Array.isArray(state.ssh.certificates)) state.ssh.certificates = [];
        state.ssh.certificates.push(cert);
      });
      broadcastState();
      return cert;
    },

    async "ssh:certs:delete"(payload) {
      const id = payload?.id;
      if (!id) throw new Error("Missing cert id");
      await credentialStore.deleteSecret(id);
      await store.mutate((state) => {
        if (!state.ssh) return;
        state.ssh.certificates = (state.ssh.certificates || []).filter((c) => c.id !== id);
        state.ssh.hosts = (state.ssh.hosts || []).map((h) =>
          h.auth?.certRef === id ? { ...h, auth: { ...h.auth, certRef: "" } } : h,
        );
      });
      broadcastState();
      return { ok: true };
    },

    async "ssh:auth:answer"(payload) {
      const parsed = sshAuthAnswerSchema.parse(payload);
      sshManager.answerAuthPrompt(parsed.sessionId, parsed.answers);
      return { ok: true };
    },

    async "ssh:auth:cancel"(payload) {
      const sessionId = payload?.sessionId;
      if (!sessionId) throw new Error("Missing sessionId");
      sshManager.cancelAuthPrompt(sessionId);
      return { ok: true };
    },

    async "ssh:host-key:accept"(payload) {
      const parsed = sshAcceptHostKeySchema.parse(payload);
      await sshManager.acceptHostKey(parsed.sessionId, parsed.mode);
      return { ok: true };
    },

    async "ssh:host-key:reject"(payload) {
      const sessionId = payload?.sessionId;
      if (!sessionId) throw new Error("Missing sessionId");
      sshManager.rejectHostKey(sessionId);
      return { ok: true };
    },

    async "ssh:config:preview"(payload) {
      const { parseSshConfig } = await import("./ssh-config-parser.js");
      const parsed = sshConfigImportSchema.parse(payload || {});
      return parseSshConfig(parsed.path);
    },

    async "ssh:config:import"(payload) {
      const { parseSshConfig } = await import("./ssh-config-parser.js");
      const parsed = sshConfigImportSchema.parse(payload || {});
      const hosts = await parseSshConfig(parsed.path);
      const selected =
        parsed.hostIds && parsed.hostIds.length > 0 ? hosts.filter((h) => parsed.hostIds.includes(h.name)) : hosts;

      const created = [];
      for (const h of selected) {
        // Drop the parser's private _identityFile marker — it isn't valid state.
        const clean = { ...h };
        delete clean._identityFile;
        if (!clean.auth) clean.auth = { methods: ["publickey"], agent: "auto" };
        created.push(await sshManager.createHost(clean));
      }
      broadcastState();
      return created;
    },

    async "ssh:known-hosts:import"(payload) {
      // V1 scope: read-only scaffold — full parsing of ~/.ssh/known_hosts is
      // deferred to a follow-up PR. See plan §9 for the format details.
      sshKnownHostsImportSchema.parse(payload || {});
      return { ok: true, imported: 0, skipped: "not-implemented" };
    },
  };
}

function inferKeyKind(pem) {
  if (!pem) return "unknown";
  const head = pem.slice(0, 512);
  if (/BEGIN OPENSSH PRIVATE KEY/.test(head)) return "openssh";
  if (/BEGIN RSA PRIVATE KEY/.test(head)) return "rsa";
  if (/BEGIN EC PRIVATE KEY/.test(head)) return "ecdsa";
  if (/BEGIN (ENCRYPTED )?PRIVATE KEY/.test(head)) return "pkcs8";
  return "unknown";
}
