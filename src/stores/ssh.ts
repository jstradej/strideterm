import { defineStore } from "pinia";
import { createTransport } from "../transport.js";
import type { SshHost, SshKey, SshCert, SshConnectionState } from "../../electron/shared/types/ssh.js";

const transport = createTransport();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = transport as any;

interface SshAuthPrompt {
  sessionId: string;
  name: string;
  prompts: unknown[];
  [key: string]: unknown;
}

interface SshHostKeyWarning {
  sessionId: string;
  host: string;
  oldFp: string;
  newFp: string;
  [key: string]: unknown;
}

export const useSshStore = defineStore("ssh", {
  state: () => ({
    hosts: [] as SshHost[],
    keys: [] as SshKey[],
    certificates: [] as SshCert[],
    authPrompt: null as SshAuthPrompt | null, // { sessionId, name, prompts, … }
    hostKeyWarning: null as SshHostKeyWarning | null, // { sessionId, host, oldFp, newFp }
    pendingConnections: new Map<string, string>(), // sessionId -> status
  }),

  actions: {
    async load(): Promise<void> {
      const [hosts, keys, certs] = await Promise.all([
        t.sshHostsList(),
        t.sshKeysList(),
        t.sshCertsList(),
      ]);
      this.hosts = (hosts as SshHost[]) || [];
      this.keys = (keys as SshKey[]) || [];
      this.certificates = (certs as SshCert[]) || [];
    },

    async saveHost(host: SshHost): Promise<void> {
      if (host.id) {
        await t.sshHostsUpdate({ id: host.id, patch: host });
      } else {
        await t.sshHostsCreate(host);
      }
      await this.load();
    },

    async deleteHost(id: string): Promise<void> {
      await t.sshHostsDelete({ id });
      await this.load();
    },

    async importKey(file: string, label: string, passphrase: string): Promise<void> {
      await t.sshKeysImport({ label, privateKey: file, passphrase });
      await this.load();
    },

    async generateKey({ kind, comment, passphrase }: { kind: string; comment: string; passphrase: string }): Promise<void> {
      await t.sshKeysGenerate({ kind, comment, passphrase });
      await this.load();
    },

    async deleteKey(id: string): Promise<void> {
      await t.sshKeysDelete({ id });
      await this.load();
    },

    async importCertificate(keyId: string, certificate: string): Promise<void> {
      await t.sshCertsImport({ keyId, certificate });
      await this.load();
    },

    async deleteCertificate(id: string): Promise<void> {
      await t.sshCertsDelete({ id });
      await this.load();
    },

    async answerAuthPrompt(sessionId: string, answers: unknown[]): Promise<void> {
      // Strip Vue reactive proxies — IPC structuredClone cannot clone them and
      // silently rejects, leaving the prompt dialog stuck open.
      const plainAnswers = JSON.parse(JSON.stringify(Array.from(answers || []))) as unknown[];
      try {
        await t.sshAuthAnswer({ sessionId, answers: plainAnswers });
      } finally {
        this.authPrompt = null;
      }
    },

    async cancelAuthPrompt(sessionId: string): Promise<void> {
      try {
        await t.sshAuthCancel({ sessionId });
      } finally {
        this.authPrompt = null;
      }
    },

    async acceptHostKey(sessionId: string, mode = "permanent"): Promise<void> {
      await t.sshHostKeyAccept({ sessionId, mode });
      this.hostKeyWarning = null;
    },

    async rejectHostKey(sessionId: string): Promise<void> {
      try {
        await t.sshHostKeyReject({ sessionId });
      } finally {
        this.hostKeyWarning = null;
      }
    },

    bindEvents(): void {
      t.onSshAuthPrompt((payload: unknown) => {
        this.authPrompt = payload as SshAuthPrompt;
      });

      t.onSshHostKeyChange((payload: unknown) => {
        this.hostKeyWarning = payload as SshHostKeyWarning;
      });

      t.onSshState(() => {
        void this.load();
      });

      t.onSshConnectionState((payload: SshConnectionState) => {
        const { sessionId, status } = payload;
        const newMap = new Map(this.pendingConnections);
        newMap.set(sessionId, status);
        this.pendingConnections = newMap;
      });
    },
  },
});
