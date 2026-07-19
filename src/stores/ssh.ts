import { defineStore } from "pinia";
import type { Transport } from "../transport.js";
import type { SshHost, SshKey, SshCert, SshConnectionState } from "../../electron/shared/types/ssh.js";

// Injected via init(api) from the SAME transport main.ts/App.vue already
// created and provided — this store must not mint its own createTransport(),
// which used to open a second WebSocket (with its own reconnect loop and
// resume probe) on every remote client, never subscribed to terminals, and
// so doubled the server's pushed traffic per client.
let _api: Transport | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function t(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return _api as any;
}

/**
 * Surface a failed store action as a toast — actions here are invoked
 * fire-and-forget from several places (App.vue, bindEvents()'s onSshState
 * listener, dialog onMounted hooks), so catching only inside the store (not
 * at each call site) is the one place guaranteed to run. Mirrors
 * file-manager.ts's notifyOpError.
 */
async function notifyOpError(title: string, msg: string): Promise<void> {
  try {
    const { useNotificationStore } = await import("./notifications.js");
    useNotificationStore().showError(title, msg);
  } catch {
    // notifications store optional during isolated unit tests
  }
}

interface SshAuthPrompt {
  sessionId: string;
  name: string;
  prompts: unknown[];
  promptId?: string;
  [key: string]: unknown;
}

interface SshHostKeyWarning {
  sessionId: string;
  host: string;
  oldFp: string;
  newFp: string;
  promptId?: string;
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
    error: null as string | null,
  }),

  actions: {
    init(api: Transport): void {
      _api = api;
    },

    async load(): Promise<void> {
      if (!_api) return;
      this.error = null;
      try {
        const [hosts, keys, certs] = await Promise.all([t().sshHostsList(), t().sshKeysList(), t().sshCertsList()]);
        this.hosts = (hosts as SshHost[]) || [];
        this.keys = (keys as SshKey[]) || [];
        this.certificates = (certs as SshCert[]) || [];
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to load SSH data";
        this.error = msg;
        await notifyOpError("Load SSH data failed", msg);
      }
    },

    async saveHost(host: SshHost): Promise<void> {
      if (host.id) {
        await t().sshHostsUpdate({ id: host.id, patch: host });
      } else {
        await t().sshHostsCreate(host);
      }
      await this.load();
    },

    async deleteHost(id: string): Promise<void> {
      try {
        await t().sshHostsDelete({ id });
        await this.load();
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to delete SSH host";
        this.error = msg;
        await notifyOpError("Delete SSH host failed", msg);
      }
    },

    async importKey(file: string, label: string, passphrase: string): Promise<void> {
      await t().sshKeysImport({ label, privateKey: file, passphrase });
      await this.load();
    },

    async generateKey({
      kind,
      comment,
      passphrase,
    }: {
      kind: string;
      comment: string;
      passphrase: string;
    }): Promise<void> {
      await t().sshKeysGenerate({ kind, comment, passphrase });
      await this.load();
    },

    async deleteKey(id: string): Promise<void> {
      await t().sshKeysDelete({ id });
      await this.load();
    },

    async importCertificate(keyId: string, certificate: string): Promise<void> {
      await t().sshCertsImport({ keyId, certificate });
      await this.load();
    },

    async deleteCertificate(id: string): Promise<void> {
      try {
        await t().sshCertsDelete({ id });
        await this.load();
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to delete SSH certificate";
        this.error = msg;
        await notifyOpError("Delete SSH certificate failed", msg);
      }
    },

    async answerAuthPrompt(sessionId: string, answers: unknown[]): Promise<void> {
      // Echo the prompt's generation token so a stale dialog (this id was reused by
      // a reconnect) can't feed its answer into the newer connection.
      const promptId = this.authPrompt?.promptId;
      // Strip Vue reactive proxies — IPC structuredClone cannot clone them and
      // silently rejects, leaving the prompt dialog stuck open.
      const plainAnswers = JSON.parse(JSON.stringify(Array.from(answers || []))) as unknown[];
      try {
        await t().sshAuthAnswer({ sessionId, answers: plainAnswers, promptId });
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to submit SSH authentication";
        this.error = msg;
        await notifyOpError("SSH authentication failed", msg);
      } finally {
        this.authPrompt = null;
      }
    },

    async cancelAuthPrompt(sessionId: string): Promise<void> {
      const promptId = this.authPrompt?.promptId;
      try {
        await t().sshAuthCancel({ sessionId, promptId });
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to cancel SSH authentication";
        this.error = msg;
        await notifyOpError("Cancel SSH authentication failed", msg);
      } finally {
        this.authPrompt = null;
      }
    },

    async acceptHostKey(sessionId: string, mode = "permanent"): Promise<void> {
      const promptId = this.hostKeyWarning?.promptId;
      try {
        await t().sshHostKeyAccept({ sessionId, mode, promptId });
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to accept SSH host key";
        this.error = msg;
        await notifyOpError("Accept SSH host key failed", msg);
      } finally {
        this.hostKeyWarning = null;
      }
    },

    async rejectHostKey(sessionId: string): Promise<void> {
      const promptId = this.hostKeyWarning?.promptId;
      try {
        await t().sshHostKeyReject({ sessionId, promptId });
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to reject SSH host key";
        this.error = msg;
        await notifyOpError("Reject SSH host key failed", msg);
      } finally {
        this.hostKeyWarning = null;
      }
    },

    bindEvents(): void {
      if (!_api) return;
      t().onSshAuthPrompt((payload: unknown) => {
        this.authPrompt = payload as SshAuthPrompt;
      });

      t().onSshAuthPromptCancel((payload: { sessionId: string; promptId: string }) => {
        // The backend tore down (or another client answered/cancelled) the prompt
        // for THIS generation → close the matching dialog. Scoped by promptId so a
        // stale teardown can't dismiss a newer connection's prompt on this client.
        if (this.authPrompt?.promptId === payload.promptId) this.authPrompt = null;
        if (this.hostKeyWarning?.promptId === payload.promptId) this.hostKeyWarning = null;
      });

      t().onSshHostKeyChange((payload: unknown) => {
        this.hostKeyWarning = payload as SshHostKeyWarning;
      });

      t().onSshState(() => {
        void this.load();
      });

      t().onSshConnectionState((payload: SshConnectionState) => {
        const { sessionId, status } = payload;
        const newMap = new Map(this.pendingConnections);
        newMap.set(sessionId, status);
        this.pendingConnections = newMap;
      });
    },
  },
});
