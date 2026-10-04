import { defineStore } from "pinia";
import type { Transport } from "../transport.js";
import type {
  SshHost,
  SshKey,
  SshCert,
  SshConnectionState,
  SshKeyTransferState,
} from "../../electron/shared/types/ssh.js";
import type { SshRuntimeCapabilities } from "../../electron/shared/ssh-connection.js";
import type { SshTestStatePayload, SshTestStatus } from "../transport.js";
import type { SshKeyTransferStart } from "../../electron/backend/ipc-schemas.js";

export interface SshHostDraft {
  host: string;
  id?: string;
  [field: string]: unknown;
}

function isInUseResult(result: unknown): result is { ok: false; error: "in-use" } {
  return Boolean(result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false);
}

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
  promptId: string;
  prompt: { name?: string; instructions?: string; prompts: { prompt: string; echo: boolean }[] };
  [key: string]: unknown;
}

interface SshHostKeyWarning {
  sessionId: string;
  promptId: string;
  host?: { name?: string; host?: string; port?: number };
  previous?: { keyType?: string; fingerprint?: string };
  keyType?: string;
  fingerprint?: string;
  [key: string]: unknown;
}

type SshDecision = { kind: "auth"; prompt: SshAuthPrompt } | { kind: "host-key"; prompt: SshHostKeyWarning };

function promptIdOf(decision: SshDecision): string | undefined {
  return decision.prompt.promptId;
}

export const useSshStore = defineStore("ssh", {
  state: () => ({
    hosts: [] as SshHost[],
    keys: [] as SshKey[],
    certificates: [] as SshCert[],
    capabilities: null as SshRuntimeCapabilities | null,
    authPrompt: null as SshAuthPrompt | null, // { sessionId, name, prompts, … }
    hostKeyWarning: null as SshHostKeyWarning | null, // { sessionId, host, oldFp, newFp }
    decisionQueue: [] as SshDecision[],
    pendingConnections: new Map<string, string>(), // sessionId -> status
    sshTestStates: {} as Record<string, SshTestStatePayload>,
    keyTransferStates: {} as Record<string, SshKeyTransferState>,
    error: null as string | null,
  }),

  actions: {
    init(api: Transport): void {
      _api = api;
    },

    async load(refreshCapabilities = false): Promise<void> {
      if (!_api) return;
      this.error = null;
      try {
        const [capabilities, hosts, keys, certs] = await Promise.all([
          (refreshCapabilities || !this.capabilities) && typeof t().sshCapabilitiesGet === "function"
            ? t().sshCapabilitiesGet()
            : Promise.resolve(this.capabilities),
          t().sshHostsList(),
          t().sshKeysList(),
          t().sshCertsList(),
        ]);
        this.capabilities = capabilities;
        this.hosts = (hosts as SshHost[]) || [];
        this.keys = (keys as SshKey[]) || [];
        this.certificates = (certs as SshCert[]) || [];
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to load SSH data";
        this.error = msg;
        await notifyOpError("Load SSH data failed", msg);
      }
    },

    async saveHost(host: SshHostDraft): Promise<unknown> {
      let result: unknown;
      if (host.id) {
        result = await t().sshHostsUpdate({ id: host.id, patch: host });
      } else {
        result = await t().sshHostsCreate(host);
      }
      await this.load();
      return result;
    },

    async deleteHost(id: string): Promise<unknown> {
      try {
        const result = await t().sshHostsDelete({ id });
        if (isInUseResult(result)) return result;
        await this.load();
        return result;
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to delete SSH host";
        this.error = msg;
        await notifyOpError("Delete SSH host failed", msg);
      }
    },

    async importKey(file: string, label: string, passphrase: string): Promise<unknown> {
      const result = await t().sshKeysImport({ label, privateKey: file, passphrase });
      await this.load();
      return result;
    },

    async generateKey({
      kind,
      comment,
      passphrase,
    }: {
      kind: string;
      comment: string;
      passphrase: string;
    }): Promise<unknown> {
      const result = await t().sshKeysGenerate({ kind, comment, passphrase });
      await this.load();
      return result;
    },

    async deleteKey(id: string): Promise<unknown> {
      const result = await t().sshKeysDelete({ id });
      if (isInUseResult(result)) return result;
      await this.load();
      return result;
    },

    async renameKey(id: string, label: string): Promise<SshKey | null> {
      const result = (await t().sshKeysRename({ id, label })) as SshKey | null;
      if (result) await this.load();
      return result;
    },

    async startKeyTransfer(payload: SshKeyTransferStart): Promise<{ operationId: string; status: "connecting" }> {
      const safePayload = JSON.parse(JSON.stringify(payload)) as SshKeyTransferStart;
      const result = await t().sshKeysTransferStart(safePayload);
      const event = this.keyTransferStates[result.operationId];
      if (!event) {
        this.keyTransferStates = {
          ...this.keyTransferStates,
          [result.operationId]: {
            ...result,
            hostId: payload.hostId || "",
            keyId: payload.keyId,
            status: result.status,
          },
        };
      }
      return result;
    },

    async stopKeyTransfer(operationId: string): Promise<void> {
      const result = await t().sshKeysTransferStop({ operationId });
      if (!result.ok) throw new Error("Could not stop public-key transfer.");
    },

    clearKeyTransferState(operationId: string): void {
      const remaining = { ...this.keyTransferStates };
      delete remaining[operationId];
      this.keyTransferStates = remaining;
    },

    async importCertificate(keyId: string, certificate: string): Promise<unknown> {
      const result = await t().sshCertsImport({ keyId, certificate });
      await this.load();
      return result;
    },

    async deleteCertificate(id: string): Promise<unknown> {
      try {
        const result = await t().sshCertsDelete({ id });
        if (isInUseResult(result)) return result;
        await this.load();
        return result;
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to delete SSH certificate";
        this.error = msg;
        await notifyOpError("Delete SSH certificate failed", msg);
      }
    },

    async answerAuthPrompt(sessionId: string, answers: unknown[], requestedPromptId?: string): Promise<void> {
      // Echo the prompt's generation token so a stale dialog (this id was reused by
      // a reconnect) can't feed its answer into the newer connection.
      const activePrompt =
        this.authPrompt?.sessionId === sessionId &&
        (!requestedPromptId || this.authPrompt.promptId === requestedPromptId)
          ? this.authPrompt
          : null;
      const promptId = activePrompt?.promptId;
      if (!activePrompt) return;
      // Strip Vue reactive proxies — IPC structuredClone cannot clone them and
      // silently rejects, leaving the prompt dialog stuck open.
      const plainAnswers = JSON.parse(JSON.stringify(Array.from(answers || []))) as unknown[];
      try {
        await t().sshAuthAnswer({ sessionId, answers: plainAnswers, promptId });
        this.dismissDecision(promptId);
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to submit SSH authentication";
        this.error = msg;
        await notifyOpError("SSH authentication failed", msg);
      }
    },

    async cancelAuthPrompt(sessionId: string, requestedPromptId?: string): Promise<void> {
      const activePrompt =
        this.authPrompt?.sessionId === sessionId &&
        (!requestedPromptId || this.authPrompt.promptId === requestedPromptId)
          ? this.authPrompt
          : null;
      const promptId = activePrompt?.promptId;
      if (!activePrompt) return;
      try {
        await t().sshAuthCancel({ sessionId, promptId });
        this.dismissDecision(promptId);
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to cancel SSH authentication";
        this.error = msg;
        await notifyOpError("Cancel SSH authentication failed", msg);
      }
    },

    async acceptHostKey(sessionId: string, mode = "permanent", requestedPromptId?: string): Promise<void> {
      const activeWarning =
        this.hostKeyWarning?.sessionId === sessionId &&
        (!requestedPromptId || this.hostKeyWarning.promptId === requestedPromptId)
          ? this.hostKeyWarning
          : null;
      const promptId = activeWarning?.promptId;
      if (!activeWarning) return;
      try {
        await t().sshHostKeyAccept({ sessionId, mode, promptId });
        this.dismissDecision(promptId);
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to accept SSH host key";
        this.error = msg;
        await notifyOpError("Accept SSH host key failed", msg);
      }
    },

    async rejectHostKey(sessionId: string, requestedPromptId?: string): Promise<void> {
      const activeWarning =
        this.hostKeyWarning?.sessionId === sessionId &&
        (!requestedPromptId || this.hostKeyWarning.promptId === requestedPromptId)
          ? this.hostKeyWarning
          : null;
      const promptId = activeWarning?.promptId;
      if (!activeWarning) return;
      try {
        await t().sshHostKeyReject({ sessionId, promptId });
        this.dismissDecision(promptId);
      } catch (err) {
        const msg = (err as Error)?.message || "Failed to reject SSH host key";
        this.error = msg;
        await notifyOpError("Reject SSH host key failed", msg);
      }
    },

    bindEvents(): void {
      if (!_api) return;
      t().onSshAuthPrompt((payload: unknown) => {
        const prompt = payload as SshAuthPrompt;
        this.enqueueDecision({ kind: "auth", prompt });
      });

      t().onSshAuthPromptCancel((payload: { sessionId: string; promptId: string }) => {
        // The backend tore down (or another client answered/cancelled) the prompt
        // for THIS generation → close the matching dialog. Scoped by promptId so a
        // stale teardown can't dismiss a newer connection's prompt on this client.
        this.dismissDecision(payload.promptId);
      });

      t().onSshHostKeyChange((payload: unknown) => {
        const warning = payload as SshHostKeyWarning;
        this.enqueueDecision({ kind: "host-key", prompt: warning });
      });

      t().onSshState(() => {
        void this.load();
      });

      t().onSshConnectionState((payload: SshConnectionState) => {
        const { sessionId, status } = payload;
        if (sessionId.startsWith("ssh-test:") || sessionId.startsWith("ssh-transfer:")) return;
        const newMap = new Map(this.pendingConnections);
        newMap.set(sessionId, status);
        this.pendingConnections = newMap;
      });

      t().onSshTestState?.((payload: SshTestStatePayload) => {
        if (!payload.sessionId) return;
        this.sshTestStates = { ...this.sshTestStates, [payload.sessionId]: payload };
      });

      t().onSshKeyTransferState?.((payload: SshKeyTransferState) => {
        if (!payload.operationId) return;
        this.keyTransferStates = { ...this.keyTransferStates, [payload.operationId]: payload };
      });
    },

    async startTestConnection(
      profileId: string,
      draft: Record<string, unknown>,
    ): Promise<{ sessionId: string; mode: SshTestStatePayload["mode"]; status: SshTestStatus }> {
      if (!t().sshTestStart) throw new Error("SSH connection testing is available in the desktop app.");
      // Dialog props and nested form fields are reactive proxies. IPC uses
      // structuredClone, so serialize the whole draft before touching fields.
      const safeDraft = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
      delete safeDraft.id;
      delete safeDraft.createdAt;
      delete safeDraft.updatedAt;
      delete safeDraft.lastConnectedAt;
      if (typeof safeDraft.name !== "string") delete safeDraft.name;
      const advanced = { ...((safeDraft.advanced as Record<string, unknown> | undefined) || {}) };
      delete advanced.command;
      safeDraft.advanced = advanced;
      const result = await t().sshTestStart!({ profileId, draft: safeDraft });
      const eventState = this.sshTestStates[result.sessionId];
      if (!eventState) {
        this.sshTestStates = {
          ...this.sshTestStates,
          [result.sessionId]: { ...result, sessionId: result.sessionId },
        };
      }
      return { ...result, status: eventState?.status || result.status };
    },

    async stopTestConnection(sessionId: string): Promise<void> {
      if (!t().sshTestStop) throw new Error("SSH connection testing is available in the desktop app.");
      const result = await t().sshTestStop!({ sessionId });
      if (!result.ok) throw new Error("Could not stop the SSH connection test.");
    },

    clearTestConnectionState(sessionId: string): void {
      const remaining = { ...this.sshTestStates };
      delete remaining[sessionId];
      this.sshTestStates = remaining;
    },

    dismissAuthPrompt(promptId?: string): void {
      this.dismissDecision(promptId);
    },

    dismissHostKeyWarning(promptId?: string): void {
      this.dismissDecision(promptId);
    },

    enqueueDecision(decision: SshDecision): void {
      if (promptIdOf(decision) && this.decisionQueue.some((item) => promptIdOf(item) === promptIdOf(decision))) return;
      if (this.authPrompt?.promptId === promptIdOf(decision) || this.hostKeyWarning?.promptId === promptIdOf(decision))
        return;
      if (this.authPrompt || this.hostKeyWarning) {
        this.decisionQueue.push(decision);
      } else {
        this.activateDecision(decision);
        window.dispatchEvent(new Event("ssh-modal-open"));
      }
    },

    activateDecision(decision: SshDecision | undefined): void {
      this.authPrompt = decision?.kind === "auth" ? decision.prompt : null;
      this.hostKeyWarning = decision?.kind === "host-key" ? decision.prompt : null;
      if (decision) window.dispatchEvent(new Event("ssh-modal-open"));
    },

    dismissDecision(promptId?: string): void {
      if (this.authPrompt?.promptId === promptId || this.hostKeyWarning?.promptId === promptId) {
        this.activateDecision(this.decisionQueue.shift());
        return;
      }
      const index = this.decisionQueue.findIndex((item) => promptIdOf(item) === promptId);
      if (index >= 0) this.decisionQueue.splice(index, 1);
      this.activateDecision(
        this.authPrompt
          ? { kind: "auth", prompt: this.authPrompt }
          : this.hostKeyWarning
            ? { kind: "host-key", prompt: this.hostKeyWarning }
            : undefined,
      );
    },
  },
});
