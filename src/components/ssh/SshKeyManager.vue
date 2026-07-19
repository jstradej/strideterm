<template>
  <div class="dialog ssh-key-manager">
    <header class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Keys &amp; Certificates</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </header>

    <section class="manager-section">
      <div class="section-header">
        <h3>Private keys</h3>
        <div class="actions">
          <button type="button" class="button button--small" @click="store.openSshKeyGenerateDialog()">Generate</button>
          <button type="button" class="button button--small button--ghost" @click="pasteKey">Paste key…</button>
        </div>
      </div>

      <div v-if="keys.length === 0" class="empty-state empty-state--detailed">
        <p class="empty-state__title">No keys imported into strideterm yet.</p>
        <p class="empty-state__note">
          strideterm does <strong>not</strong> read your <code>{{ sshDirPath }}</code> directory automatically. Imported
          keys are copied into the OS credential store ({{ credentialStoreName }}); the original file on disk stays
          untouched.
        </p>
        <p class="empty-state__note"><strong>Two ways to use SSH keys:</strong></p>
        <ol class="empty-state__list">
          <li>
            <strong>Bring a key under strideterm's management</strong> — click <em>Generate</em> to create a new one, or
            <em>Paste key…</em> to import an existing one (open <code>{{ sshDirPath }}&lt;name&gt;</code> in a text
            editor and paste the whole file contents including the <code>-----BEGIN…</code> header). Works with every
            launch mode including the built-in <code>ssh2</code>.
          </li>
          <li>
            <strong>Use your existing ~/.ssh keys without importing</strong> — edit the host and set
            <em>Launch via</em> to <code>system-ssh</code> (or change the global default in Settings → SSH). strideterm
            will shell out to the system <code>ssh</code> binary, which already reads
            <code>{{ sshDirPath }}config</code> and its keys just like the terminal does.
            <strong>In this mode this screen stays empty — that's fine, it's not used.</strong>
          </li>
        </ol>
      </div>
      <div v-else class="card-list">
        <div v-for="key in keys" :key="key.id" class="card">
          <div class="card__info">
            <strong>{{ key.label || "Unnamed key" }}</strong>
            <span class="muted">{{ key.kind || "unknown" }}{{ key.hasPassphrase ? " · encrypted" : "" }}</span>
            <span v-if="key.publicKey" class="muted fingerprint">{{ key.publicKey.slice(0, 80) }}…</span>
          </div>
          <button type="button" class="button button--danger button--small" @click="deleteKey(key)">Delete</button>
        </div>
      </div>
    </section>

    <hr class="divider" />

    <section class="manager-section">
      <div class="section-header">
        <h3>Certificates</h3>
        <div class="actions">
          <button type="button" class="button button--small button--ghost" @click="pasteCert">
            Paste certificate…
          </button>
        </div>
      </div>

      <div v-if="certificates.length === 0" class="empty-state empty-state--detailed">
        <p class="empty-state__title">No certificates imported.</p>
        <p class="empty-state__note">
          OpenSSH certificates (files typically named <code>&lt;key&gt;-cert.pub</code> in <code>{{ sshDirPath }}</code
          >) extend a private key with CA-signed metadata — principals, validity window, critical options. They're only
          needed if your infrastructure uses a certificate authority; most setups do not.
        </p>
        <p class="empty-state__note">
          To attach one: import the matching private key first (above), then click <em>Paste certificate…</em> and paste
          the full line from <code>{{ sshDirPath }}&lt;key&gt;-cert.pub</code> (starts with
          <code>ssh-…-cert-v01@openssh.com AAAA…</code>).
        </p>
      </div>
      <div v-else class="card-list">
        <div v-for="cert in certificates" :key="cert.id" class="card">
          <div class="card__info">
            <strong>{{ cert.keyIdString || cert.id }}</strong>
            <span v-if="cert.validAfter || cert.validBefore" class="muted">
              Valid: {{ formatDate(cert.validAfter) }} → {{ formatDate(cert.validBefore) }}
            </span>
            <span v-if="cert.principals?.length" class="muted">Principals: {{ cert.principals.join(", ") }}</span>
          </div>
          <button type="button" class="button button--danger button--small" @click="deleteCertificate(cert)">
            Delete
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import type { SshKey as BaseSshKey, SshCert as BaseSshCert } from "../../../electron/shared/types/ssh.js";

// Extended runtime types — backend returns additional fields not in the base types
interface SshKey extends BaseSshKey {
  kind?: string;
  publicKey?: string;
}

interface SshCert extends BaseSshCert {
  keyIdString?: string;
  principals?: string[];
}

const emit = defineEmits<{
  (e: "cancel"): void;
}>();
const sshStore = useSshStore();
const store = useAppStore();

// Cast to extended types that include runtime-only fields not present in shared types
const keys = computed(() => sshStore.keys as SshKey[]);
const certificates = computed(() => sshStore.certificates as SshCert[]);

const platform = computed(() => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "win";
  if (ua.includes("mac")) return "mac";
  return "linux";
});

const sshDirPath = computed(() => (platform.value === "win" ? "%USERPROFILE%\\.ssh\\" : "~/.ssh/"));

const credentialStoreName = computed(() => {
  if (platform.value === "win") return "Windows Credential Manager";
  if (platform.value === "mac") return "macOS Keychain";
  return "libsecret / Secret Service";
});

onMounted(() => {
  sshStore.load();
});

function formatDate(isoString: string | undefined): string {
  if (!isoString) return "forever";
  return new Date(isoString).toLocaleString();
}

function pasteKey(): void {
  // window.prompt() throws unconditionally in an Electron renderer ("prompt()
  // is and will not be supported") — use the in-app multi-field dialog instead.
  store.openSshKeyImportDialog();
}

function pasteCert(): void {
  if (sshStore.keys.length === 0) {
    window.alert("Import a private key before adding a certificate.");
    return;
  }
  store.openSshCertImportDialog(sshStore.keys[0].id);
}

async function deleteKey(key: SshKey): Promise<void> {
  if (!window.confirm(`Delete key "${key.label}"?`)) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (sshStore as any).deleteKey(key.id);
    if (res?.ok === false && res?.error === "in-use") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = res.hosts.map((h: any) => h.name).join(", ") || "(none)";
      const force = window.confirm(
        `This key is used by host(s): ${names}.\n\nOK = delete anyway and clear references, Cancel = keep key.`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (force) await (sshStore as any).deleteKey(key.id, { cascade: true });
    }
  } catch (err) {
    window.alert(`Delete failed: ${(err as Error).message}`);
  }
}

async function deleteCertificate(cert: SshCert): Promise<void> {
  if (!window.confirm(`Delete certificate "${cert.keyIdString || cert.id}"?`)) return;
  await sshStore.deleteCertificate(cert.id);
}
</script>

<style scoped>
.ssh-key-manager {
  width: min(640px, 100%);
  display: flex;
  flex-direction: column;
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
.card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  padding: 10px;
  border-radius: 6px;
  gap: 12px;
}
.card__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
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
