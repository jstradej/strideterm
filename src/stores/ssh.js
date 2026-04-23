import { defineStore } from "pinia";
import { createTransport } from "../transport.js";

const transport = createTransport();

export const useSshStore = defineStore("ssh", {
  state: () => ({
    hosts: [],
    keys: [],
    certificates: [],
    authPrompt: null, // { sessionId, name, prompts, … }
    hostKeyWarning: null, // { sessionId, host, oldFp, newFp }
    pendingConnections: new Map(), // sessionId -> status
  }),

  actions: {
    async load() {
      const [hosts, keys, certs] = await Promise.all([
        transport.sshHostsList(),
        transport.sshKeysList(),
        transport.sshCertsList(),
      ]);
      this.hosts = hosts || [];
      this.keys = keys || [];
      this.certificates = certs || [];
    },

    async saveHost(host) {
      if (host.id) {
        await transport.sshHostsUpdate({ id: host.id, patch: host });
      } else {
        await transport.sshHostsCreate(host);
      }
      await this.load();
    },

    async deleteHost(id) {
      await transport.sshHostsDelete({ id });
      await this.load();
    },

    async importKey(file, label, passphrase) {
      await transport.sshKeysImport({ label, privateKey: file, passphrase });
      await this.load();
    },

    async generateKey({ kind, comment, passphrase }) {
      await transport.sshKeysGenerate({ kind, comment, passphrase });
      await this.load();
    },

    async deleteKey(id) {
      await transport.sshKeysDelete({ id });
      await this.load();
    },

    async importCertificate(keyId, certificate) {
      await transport.sshCertsImport({ keyId, certificate });
      await this.load();
    },

    async deleteCertificate(id) {
      await transport.sshCertsDelete({ id });
      await this.load();
    },

    async answerAuthPrompt(sessionId, answers) {
      // Strip Vue reactive proxies — IPC structuredClone cannot clone them and
      // silently rejects, leaving the prompt dialog stuck open.
      const plainAnswers = JSON.parse(JSON.stringify(Array.from(answers || [])));
      try {
        await transport.sshAuthAnswer({ sessionId, answers: plainAnswers });
      } finally {
        this.authPrompt = null;
      }
    },

    async cancelAuthPrompt(sessionId) {
      try {
        await transport.sshAuthCancel({ sessionId });
      } finally {
        this.authPrompt = null;
      }
    },

    async acceptHostKey(sessionId, mode = "permanent") {
      await transport.sshHostKeyAccept({ sessionId, mode });
      this.hostKeyWarning = null;
    },

    async rejectHostKey(sessionId) {
      try {
        await transport.sshHostKeyReject({ sessionId });
      } finally {
        this.hostKeyWarning = null;
      }
    },

    bindEvents() {
      transport.onSshAuthPrompt((payload) => {
        this.authPrompt = payload;
      });

      transport.onSshHostKeyChange((payload) => {
        this.hostKeyWarning = payload;
      });

      transport.onSshState(() => {
        this.load();
      });

      transport.onSshConnectionState((payload) => {
        const { sessionId, state } = payload;
        const newMap = new Map(this.pendingConnections);
        newMap.set(sessionId, state);
        this.pendingConnections = newMap;
      });
    },
  },
});
