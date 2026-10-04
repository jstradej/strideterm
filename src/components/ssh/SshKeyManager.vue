<template>
  <div :class="embedded ? 'ssh-key-manager ssh-key-manager--embedded' : 'dialog ssh-key-manager'">
    <header v-if="!embedded" class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Keys &amp; Certificates</h2>
      </div>
    </header>
    <div v-if="managerError" class="dialog__error" role="alert">{{ managerError }}</div>

    <section class="manager-section">
      <div class="section-header">
        <h3>
          Private keys
          <HelpTooltip
            text="This list contains private keys imported or generated in strIDEterm. Built-in SSH can use these keys or keys from an SSH agent. Each private key has a matching public key that must be authorized on the server. SSH on this computer and WSL use keys from their own OpenSSH setup; strIDEterm does not scan those key folders. The fingerprint is a short identifier for checking which key you selected."
            label="App-managed private keys help"
          />
        </h3>
        <div class="actions">
          <button
            type="button"
            class="button button--small"
            :disabled="!canManage"
            title="Generate a new app-managed private key for Built-in SSH hosts. The private key is stored in the strIDEterm credential store."
            @click="openKeyGenerate()"
          >
            Generate
          </button>
          <button
            type="button"
            class="button button--small button--ghost"
            :disabled="!canManage"
            title="Import a private key into the strIDEterm credential store. Only keys imported here are available to Built-in SSH."
            @click="pasteKey"
          >
            Import key…
          </button>
        </div>
      </div>

      <details class="setup-guide">
        <summary>How to use a key</summary>
        <div class="setup-guide__content">
          <strong>App-managed keys can be reused by multiple Built-in SSH hosts.</strong>
          <ol>
            <li>
              Click <strong>Copy public key</strong> to add it manually, or choose <strong>Transfer public key…</strong>
              for a saved Built-in SSH host.
            </li>
            <li>
              On a Linux or macOS OpenSSH server, append its full line to the target account's usual
              <code>~/.ssh/authorized_keys</code> file. Use the same account as the SSH username and keep existing
              lines.
            </li>
            <li>
              In the host editor, choose <strong>Built-in SSH</strong>, then <strong>Key stored in strIDEterm</strong>,
              select this key, and test the connection.
            </li>
          </ol>
          <p>
            Keep the private key in strIDEterm; only the public key goes on the server. System SSH and WSL use keys from
            their own OpenSSH setups instead. Private keys do not expire on their own; certificates may have an expiry
            date shown below.
          </p>
        </div>
      </details>

      <div v-if="keys.length === 0" class="empty-state empty-state--detailed">
        <p class="empty-state__title">No app-managed private keys are imported.</p>
        <p class="empty-state__note">
          strideterm does <strong>not</strong> read your <code>{{ sshDirPath }}</code> directory automatically. Imported
          keys are stored in strIDEterm credentials ({{ credentialStoreName }}); the original file on disk stays
          untouched.
        </p>
        <p class="empty-state__note">
          Import an existing private key or generate one for Built-in SSH. System SSH and WSL read keys from their own
          SSH configuration and do not require importing them here.
        </p>
      </div>
      <div v-else class="card-list">
        <div v-for="key in keys" :key="key.id" class="card key-card">
          <div class="key-card-header">
            <strong v-if="editingKeyId !== key.id" class="key-card-title">{{ key.label || "Unnamed key" }}</strong>
            <span v-else class="key-card-title">Rename key</span>
            <div v-if="editingKeyId !== key.id" class="key-card-actions">
              <button
                type="button"
                class="button button--ghost button--small"
                :disabled="!canManage || renamingKeyId !== null"
                title="Change the label used to identify this saved private key."
                @click="beginRename(key)"
              >
                Rename
              </button>
              <button
                v-if="key.publicKey"
                type="button"
                class="button button--ghost button--small"
                title="Copy this public key to add it to your account on the SSH server. Share the public key only; keep the matching private key secret."
                @click="copyPublicKey(key)"
              >
                {{ copiedKeyId === key.id ? "Copied public key" : "Copy public key" }}
              </button>
              <button
                v-if="key.publicKey"
                type="button"
                class="button button--ghost button--small"
                :disabled="!canManage"
                title="Add this public key to a saved Built-in SSH host. The private key stays in strIDEterm."
                @click="openKeyTransfer(key.id)"
              >
                {{ embedded && expandedTransferKeyId === key.id ? "Close key setup" : "Transfer public key…" }}
              </button>
              <button
                type="button"
                class="button button--danger button--small"
                :disabled="!canManage || confirmingDeleteId === key.id"
                title="Delete this app-managed private key. SSH hosts that reference it will no longer be able to use it."
                @click="deleteKey(key)"
              >
                Delete
              </button>
            </div>
          </div>
          <div class="card__info">
            <div v-if="editingKeyId === key.id" class="key-rename-form">
              <label :for="`ssh-key-label-${key.id}`">Key label</label>
              <input
                :id="`ssh-key-label-${key.id}`"
                v-model="renameDraft"
                class="input"
                maxlength="60"
                autocomplete="off"
                :disabled="renamingKeyId === key.id"
                @keydown.enter.prevent="saveKeyLabel(key)"
                @keydown.esc.stop.prevent="cancelRename"
              />
              <div class="key-rename-form__actions">
                <button
                  type="button"
                  class="button button--small"
                  :disabled="renamingKeyId === key.id"
                  title="Save the new label for this private key."
                  @click="saveKeyLabel(key)"
                >
                  {{ renamingKeyId === key.id ? "Saving…" : "Save label" }}
                </button>
                <button
                  type="button"
                  class="button button--ghost button--small"
                  :disabled="renamingKeyId === key.id"
                  title="Discard the unsaved label change."
                  @click="cancelRename"
                >
                  Cancel
                </button>
              </div>
            </div>
            <span class="muted">{{ key.kind || "unknown" }}{{ key.hasPassphrase ? " · encrypted" : "" }}</span>
            <span class="muted">Added {{ formatAddedDate(key.createdAt) }}</span>
            <span class="muted">Used by: {{ keyHosts.get(key.id)?.join(", ") || "No saved hosts" }}</span>
            <span v-if="key.fingerprint" class="muted fingerprint">{{ key.fingerprint }}</span>
            <details v-if="key.publicKey" class="public-key-details">
              <summary>Public key</summary>
              <code class="public-key">{{ key.publicKey }}</code>
            </details>
          </div>
          <div v-if="embedded && expandedTransferKeyId === key.id" class="key-transfer-inline">
            <SshKeyTransferDialog
              :ref="setActiveTransferDialog"
              :key-id="key.id"
              :profile-id="store.myActiveProfileId || 'default'"
              inline
              @cancel="expandedTransferKeyId = null"
            />
          </div>
        </div>
      </div>
    </section>

    <details class="manager-section certificates-section">
      <summary class="certificates-summary">
        <h3>
          Advanced: certificates <span v-if="certificates.length" class="muted">({{ certificates.length }})</span>
        </h3>
      </summary>
      <div class="certificates-content">
        <div class="section-header certificates-actions">
          <p class="muted certificate-help">
            Most people do not need an SSH certificate. Built-in SSH does not use certificates; importing metadata here
            does not configure OpenSSH.
          </p>
          <button
            type="button"
            class="button button--small button--ghost"
            :disabled="!canManage"
            title="Import OpenSSH certificate metadata. Built-in SSH does not use imported certificates."
            @click="pasteCert"
          >
            Import certificate…
          </button>
        </div>

        <div v-if="certificates.length === 0" class="empty-state empty-state--detailed">
          <p class="empty-state__title">No certificates imported.</p>
          <p class="empty-state__note">
            OpenSSH certificates (files typically named <code>&lt;key&gt;-cert.pub</code> in
            <code>{{ sshDirPath }}</code
            >) extend a private key with CA-signed metadata — principals, validity window, critical options. They're
            only needed if your infrastructure uses a certificate authority; most setups do not.
          </p>
          <p class="empty-state__note">
            Built-in SSH does not authenticate with these certificates. Importing certificate metadata here does not
            configure OpenSSH; System SSH or WSL must be configured to use the matching key and certificate in that
            environment. Keep it only if your organization has issued one for this connection.
          </p>
        </div>
        <div v-else class="card-list">
          <div v-for="cert in certificates" :key="cert.id" class="card">
            <div class="card__info">
              <strong>{{ cert.keyIdString || cert.id }}</strong>
              <span class="muted">Added {{ formatAddedDate(cert.createdAt) }}</span>
              <span v-if="cert.validAfter || cert.validBefore" class="muted">
                Valid: {{ formatDate(cert.validAfter) }} → {{ formatDate(cert.validBefore) }}
              </span>
              <span v-if="cert.principals?.length" class="muted">Principals: {{ cert.principals.join(", ") }}</span>
            </div>
            <button
              type="button"
              class="button button--danger button--small"
              :disabled="!canManage || confirmingDeleteId === cert.id"
              title="Delete this imported certificate metadata."
              @click="deleteCertificate(cert)"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </details>
    <footer v-if="!embedded" class="dialog__footer dialog__footer--end ssh-key-manager__footer">
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import HelpTooltip from "../common/HelpTooltip.vue";
import type { SshKey as BaseSshKey, SshCert as BaseSshCert } from "../../../electron/shared/types/ssh.js";
import { useSshPanelNavigation } from "./ssh-panel-navigation.js";
import SshKeyTransferDialog from "./SshKeyTransferDialog.vue";

// Extended runtime types — backend returns additional fields not in the base types
type SshKey = BaseSshKey & { publicKey?: string };

interface SshCert extends BaseSshCert {
  keyIdString?: string;
  principals?: string[];
}

const emit = defineEmits<{ cancel: [] }>();
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });
const embedded = computed(() => props.embedded);
const sshStore = useSshStore();
const store = useAppStore();
const panelNavigation = useSshPanelNavigation();
const managerError = ref("");
const copiedKeyId = ref<string | null>(null);
const confirmingDeleteId = ref<string | null>(null);
const editingKeyId = ref<string | null>(null);
const renameDraft = ref("");
const renamingKeyId = ref<string | null>(null);
const expandedTransferKeyId = ref<string | null>(null);
const activeTransferDialog = ref<{ requestClose?: () => Promise<boolean> } | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
const canManage = computed(
  () => !store.isRemoteTransport && sshStore.capabilities?.permissions?.canManageHosts !== false,
);

// Cast to extended types that include runtime-only fields not present in shared types
const keys = computed(() => sshStore.keys as SshKey[]);
const certificates = computed(() => sshStore.certificates as SshCert[]);
const keyHosts = computed(
  () =>
    new Map(
      keys.value.map((key) => [
        key.id,
        sshStore.hosts.filter((host) => host.auth?.keyRef === key.id).map((host) => host.name || host.host),
      ]),
    ),
);

const platform = computed(() => sshStore.capabilities?.platform || "unknown");

const sshDirPath = computed(() => (platform.value === "win" ? "%USERPROFILE%\\.ssh\\" : "~/.ssh/"));

const credentialStoreName = computed(() =>
  sshStore.capabilities?.safeStorageAvailable ? "OS-protected strIDEterm credentials" : "strIDEterm credential storage",
);

async function copyPublicKey(key: SshKey): Promise<void> {
  managerError.value = "";
  copiedKeyId.value = null;
  try {
    await navigator.clipboard.writeText(key.publicKey || "");
    if (disposed) return;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedKeyId.value = key.id;
    copiedTimer = setTimeout(() => {
      if (copiedKeyId.value === key.id) copiedKeyId.value = null;
      copiedTimer = undefined;
    }, 2000);
  } catch (err) {
    if (disposed) return;
    managerError.value = `Could not copy public key: ${(err as Error).message || "clipboard unavailable"}`;
  }
}

onBeforeUnmount(() => {
  disposed = true;
  if (copiedTimer) clearTimeout(copiedTimer);
});

onMounted(() => {
  sshStore.load();
});

async function requestClose(): Promise<boolean> {
  if (renamingKeyId.value || confirmingDeleteId.value) return false;
  if (!(await closeInlineTransfer())) return false;
  if (editingKeyId.value) {
    const discard = await store.confirmInApp({
      title: "Discard SSH key label?",
      message: "This key label has not been saved.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      danger: true,
    });
    if (!discard) return false;
    cancelRename();
  }
  if (!embedded.value) emit("cancel");
  return true;
}
defineExpose({ requestClose });

function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return "forever";
  return new Date(isoString).toLocaleString();
}

function formatAddedDate(isoString: string | null | undefined): string {
  if (!isoString) return "unknown";
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
}

async function beginRename(key: SshKey): Promise<void> {
  if (!(await prepareKeyNavigation())) return;
  managerError.value = "";
  editingKeyId.value = key.id;
  renameDraft.value = key.label || "";
}

function cancelRename(): void {
  if (renamingKeyId.value) return;
  editingKeyId.value = null;
  renameDraft.value = "";
  managerError.value = "";
}

async function saveKeyLabel(key: SshKey): Promise<void> {
  if (renamingKeyId.value) return;
  const label = renameDraft.value.trim();
  if (!label || label.length > 60) {
    managerError.value = "Key labels must be between 1 and 60 characters.";
    return;
  }
  renamingKeyId.value = key.id;
  managerError.value = "";
  try {
    const renamed = await sshStore.renameKey(key.id, label);
    if (!renamed) {
      managerError.value = "This SSH key no longer exists.";
      return;
    }
    editingKeyId.value = null;
    renameDraft.value = "";
  } catch (err) {
    managerError.value = `Could not rename SSH key: ${(err as Error).message || "request failed"}`;
  } finally {
    renamingKeyId.value = null;
  }
}

async function pasteKey(): Promise<void> {
  if (!(await prepareKeyNavigation())) return;
  // window.prompt() throws unconditionally in an Electron renderer ("prompt()
  // is and will not be supported") — use the in-app multi-field dialog instead.
  if (!store.isRemoteTransport && sshStore.capabilities?.permissions?.canManageHosts !== false)
    if (panelNavigation) panelNavigation.open("SshKeyImportDialog");
    else store.openSshKeyImportDialog();
}

async function pasteCert(): Promise<void> {
  if (!(await prepareKeyNavigation())) return;
  if (sshStore.keys.length === 0) {
    managerError.value = "Import a private key before adding a certificate.";
    return;
  }
  if (!store.isRemoteTransport && sshStore.capabilities?.permissions?.canManageHosts !== false)
    if (panelNavigation) panelNavigation.open("SshCertImportDialog", { keyId: sshStore.keys[0].id });
    else store.openSshCertImportDialog(sshStore.keys[0].id);
}

async function openKeyGenerate() {
  if (!(await prepareKeyNavigation())) return;
  if (panelNavigation) panelNavigation.open("SshKeyGenerateDialog");
  else store.openSshKeyGenerateDialog();
}

async function openKeyTransfer(keyId: string) {
  if (embedded.value) {
    if (expandedTransferKeyId.value === keyId) {
      if (activeTransferDialog.value?.requestClose && !(await activeTransferDialog.value.requestClose())) return;
      expandedTransferKeyId.value = null;
    } else {
      if (editingKeyId.value && !(await confirmDiscardRename())) return;
      if (expandedTransferKeyId.value && activeTransferDialog.value?.requestClose) {
        if (!(await activeTransferDialog.value.requestClose())) return;
      }
      expandedTransferKeyId.value = keyId;
    }
    return;
  }
  if (panelNavigation)
    panelNavigation.open("SshKeyTransferDialog", { keyId, profileId: store.myActiveProfileId || "default" });
  else store.openSshKeyTransferDialog(keyId);
}

async function prepareKeyNavigation(): Promise<boolean> {
  if (embedded.value && editingKeyId.value && !(await confirmDiscardRename())) return false;
  return closeInlineTransfer();
}

async function confirmDiscardRename(): Promise<boolean> {
  if (!editingKeyId.value) return true;
  const discard = await store.confirmInApp({
    title: "Discard SSH key label?",
    message: "This key label has not been saved.",
    confirmLabel: "Discard changes",
    cancelLabel: "Keep editing",
    danger: true,
  });
  if (!discard) return false;
  cancelRename();
  return true;
}

async function closeInlineTransfer(): Promise<boolean> {
  if (!embedded.value || !expandedTransferKeyId.value) return true;
  if (activeTransferDialog.value?.requestClose && !(await activeTransferDialog.value.requestClose())) return false;
  expandedTransferKeyId.value = null;
  return true;
}

function setActiveTransferDialog(component: unknown) {
  activeTransferDialog.value =
    component && typeof component === "object" && "requestClose" in component
      ? (component as { requestClose?: () => Promise<boolean> })
      : null;
}

async function deleteKey(key: SshKey): Promise<void> {
  if (!(await prepareKeyNavigation())) return;
  if (confirmingDeleteId.value) return;
  confirmingDeleteId.value = key.id;
  managerError.value = "";
  try {
    const confirmed = await store.confirmInApp({
      title: "Delete SSH key?",
      message: `Delete key "${key.label}"? This cannot be undone.`,
      confirmLabel: "Delete key",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!confirmed) return;
    sshStore.error = null;
    const res = (await sshStore.deleteKey(key.id)) as
      | { ok?: boolean; error?: string; hosts?: { name?: string }[]; certs?: { keyIdString?: string; id: string }[] }
      | undefined;
    if (res?.ok === false && res?.error === "in-use") {
      const names = [
        ...(res.hosts || []).map((host) => host.name || "unnamed host"),
        ...(res.certs || []).map((cert) => `certificate ${cert.keyIdString || cert.id}`),
      ];
      managerError.value = `This key is still used by: ${names.join(", ") || "another SSH entry"}. Update those references before deleting the key.`;
    } else if (!res) {
      managerError.value = sshStore.error || "Could not delete this key.";
    }
  } catch (err) {
    managerError.value = `Delete failed: ${(err as Error).message}`;
  } finally {
    confirmingDeleteId.value = null;
  }
}

async function deleteCertificate(cert: SshCert): Promise<void> {
  if (!(await prepareKeyNavigation())) return;
  if (confirmingDeleteId.value) return;
  confirmingDeleteId.value = cert.id;
  managerError.value = "";
  try {
    const confirmed = await store.confirmInApp({
      title: "Delete SSH certificate?",
      message: `Delete certificate "${cert.keyIdString || cert.id}"? This cannot be undone.`,
      confirmLabel: "Delete certificate",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!confirmed) return;
    sshStore.error = null;
    const result = (await sshStore.deleteCertificate(cert.id)) as
      { ok?: boolean; error?: string; hosts?: { name?: string }[] } | undefined;
    if (result?.ok === false && result?.error === "in-use") {
      const hosts = (result.hosts || []).map((host) => host.name || "unnamed host").join(", ");
      managerError.value = `This certificate is still referenced by ${hosts || "a saved host"}. Update that host before deleting it.`;
    } else if (!result) {
      managerError.value = sshStore.error || "Could not delete this certificate.";
    }
  } catch (err) {
    managerError.value = `Delete failed: ${(err as Error).message}`;
  } finally {
    confirmingDeleteId.value = null;
  }
}
</script>

<style scoped>
.ssh-key-manager {
  width: min(640px, 100%);
  display: flex;
  flex-direction: column;
}
.ssh-key-manager--embedded {
  width: 100%;
  height: auto;
  max-height: none;
  display: block;
}
.ssh-key-manager__footer {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.manager-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.setup-guide {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.setup-guide summary {
  cursor: pointer;
  color: var(--text);
  font-size: 12.5px;
}
.setup-guide__content {
  padding-top: 8px;
}
.certificates-section {
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.certificates-section > .certificates-summary {
  display: list-item;
  list-style: disclosure-closed;
  list-style-position: inside;
  cursor: pointer;
}
.certificates-summary > h3 {
  display: inline;
  margin: 0;
  font-size: 14px;
}
.certificates-section[open] > .certificates-summary {
  list-style: disclosure-open;
}
.certificate-help {
  margin: 0 0 10px;
}
.certificates-actions {
  align-items: flex-start;
}
.public-key-details summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 12px;
}
.setup-guide strong {
  color: var(--text);
}
.setup-guide ol {
  display: grid;
  gap: 4px;
  margin: 6px 0;
  padding-left: 20px;
}
.setup-guide p {
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
}
.card-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 250px;
  overflow-y: auto;
}
.ssh-key-manager--embedded .card-list {
  max-height: none;
  overflow: visible;
}
.card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  padding: 10px;
  border-radius: 6px;
  gap: 12px;
  flex-wrap: wrap;
}
.key-transfer-inline {
  flex: 1 0 100%;
  min-width: 0;
}
.card__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.key-card {
  flex-direction: column;
  align-items: stretch;
}
.key-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.key-card-title {
  flex: 0 1 auto;
  padding: 5px 0;
}
.key-card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
.key-label-row,
.key-rename-form__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}
.key-public-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.key-rename-form {
  display: grid;
  gap: 6px;
  max-width: 320px;
}
.key-rename-form label {
  font-size: 12px;
  font-weight: 600;
}
.key-rename-form .input {
  width: 100%;
  min-width: 0;
}
.muted {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fingerprint {
  font-family: var(--font-mono);
  font-size: 10px;
}
.empty-state {
  padding: 16px;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--border);
  border-radius: 6px;
}
.empty-state--detailed {
  text-align: left;
  padding: 14px 16px;
  line-height: 1.5;
}
.empty-state__title {
  margin: 0 0 8px;
  color: var(--text);
  font-weight: 600;
}
.empty-state__note {
  margin: 0 0 8px;
  font-size: 12.5px;
}
.empty-state__list {
  margin: 4px 0 0;
  padding-left: 20px;
  font-size: 12.5px;
}
.empty-state__list li {
  margin-bottom: 8px;
}
.empty-state__list li:last-child {
  margin-bottom: 0;
}
.empty-state code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text);
}
.divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
}
</style>
