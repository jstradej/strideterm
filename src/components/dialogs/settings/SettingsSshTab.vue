<template>
  <div class="settings-ssh-tab">
    <!-- Secure-storage warning. When the OS keychain isn't available
         (Linux without libsecret/gnome-keyring is the typical case)
         credentials.json falls back to base64-on-disk. The user must
         see this — a one-shot log warning is too easy to miss, and any
         token/passphrase saved through the credential store is then
         readable by anyone with read access to the file. -->
    <div v-if="!secureStorageAvailable" class="ssh-secure-warning" role="alert">
      <strong>OS keychain unavailable.</strong>
      Credentials are being saved as base64 plaintext in
      <code>credentials.json</code>. Anyone who can read that file can recover the secrets.
      <span v-if="isLinuxClient">Install <code>libsecret</code> / <code>gnome-keyring</code> and restart.</span>
      <span v-else>Make sure strideterm is launched with the desktop session attached, then restart.</span>
    </div>

    <!-- 1. Connection mode — the primary decision. Everything below depends on this. -->
    <section class="form-group">
      <h3 class="section-title">Connection Mode</h3>

      <div class="form-row">
        <label>Default Launch Mode</label>
        <CustomSelect v-model="form.ssh.defaultLaunchVia" class="input select" :options="launchViaOptions" />
        <p class="form-help">{{ launchModeHelp }}</p>
      </div>

      <div v-if="showSystemSshPath" class="form-row">
        <label>System SSH Binary Path (optional)</label>
        <input v-model="form.ssh.systemSshPath" type="text" class="input" placeholder="ssh" />
        <p class="form-help">Leave blank to use <code>ssh</code> from <code>PATH</code>.</p>
      </div>

      <div v-if="isWslMode" class="form-row">
        <label>WSL Default Distribution</label>
        <input v-model="form.ssh.wslDefaultDistro" type="text" class="input" placeholder="e.g. Ubuntu" />
        <p class="form-help">Leave blank to use WSL's default distribution.</p>
      </div>
    </section>

    <hr class="divider" />

    <!-- 2. SSH Agent — both ssh2 and system-ssh honour the agent, so this section is always visible. -->
    <section class="form-group">
      <h3 class="section-title">SSH Agent</h3>

      <div class="form-row">
        <label class="checkbox-label">
          <input v-model="form.ssh.preferAgent" type="checkbox" />
          <span>Prefer SSH Agent if available</span>
        </label>
        <p class="form-help">Try ssh-agent / Pageant before falling back to stored keys.</p>
      </div>

      <div v-if="form.ssh.preferAgent" class="form-row">
        <label>Agent Path (optional)</label>
        <input v-model="form.ssh.agentPath" type="text" class="input" placeholder="Auto-detect" />
        <p class="form-help">Override <code>SSH_AUTH_SOCK</code> or the named-pipe path.</p>
      </div>
    </section>

    <!-- 3. Strideterm key store — only meaningful in ssh2 mode; in other modes keys live in ~/.ssh on disk. -->
    <template v-if="isSsh2Mode">
      <hr class="divider" />
      <section class="form-group">
        <h3 class="section-title">Strideterm Key Store</h3>
        <p class="section-help">
          Only used by <code>ssh2</code> mode. Imported keys live in {{ credentialStoreName }}.
        </p>

        <div class="form-row">
          <label class="checkbox-label">
            <input v-model="form.ssh.requireEncryptedStorage" type="checkbox" />
            <span>Require encrypted storage</span>
          </label>
          <p class="form-help">Refuse to save private keys if the OS keychain is unavailable.</p>
        </div>

        <div class="form-row">
          <label>Certificate Expiry Warning (hours)</label>
          <input v-model.number="form.ssh.certExpiryWarnHours" type="number" class="input" min="0" />
          <p class="form-help">Warn when an imported certificate expires within this many hours.</p>
        </div>
      </section>
    </template>

    <hr class="divider" />

    <!-- 4. Management entry points. Keys & Certs is only relevant for ssh2 mode; in other modes the button is
         hidden and a short note explains why. -->
    <section class="form-group">
      <h3 class="section-title">Host &amp; Key Management</h3>

      <div class="actions-row">
        <button
          type="button"
          class="button"
          title="Open the host book — add, edit, or delete saved SSH hosts; configure auth (key/password/agent), launch mode, jump hosts, and post-login commands."
          @click="store.openSshHostsDialog()"
        >
          Manage SSH Hosts
        </button>
        <button
          v-if="isSsh2Mode"
          type="button"
          class="button"
          title="Open the strIDEterm key store — generate or import private keys (ed25519/ECDSA/RSA), inspect certificates, and see which hosts reference each key. ssh2 mode only."
          @click="store.openSshKeyManager()"
        >
          Manage Keys &amp; Certs
        </button>
      </div>

      <p v-if="!isSsh2Mode" class="form-help management-note">
        <strong>Keys &amp; Certs</strong> is hidden in <code>{{ form.ssh.defaultLaunchVia }}</code> mode — the system
        <code>ssh</code> binary reads keys directly from <code>{{ sshDirPath }}</code> and strideterm's own key store is
        not used. Switch to <code>ssh2</code> to manage strideterm-held keys.
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import { useAppStore } from "../../../stores/app.js";
import CustomSelect from "../../common/CustomSelect.vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const form = inject<Record<string, any>>("settingsForm")!;
const store = useAppStore();

const ua = navigator.userAgent.toLowerCase();
const isWin = ua.includes("win");
const isMac = ua.includes("mac");
const isLinuxClient = !isWin && !isMac;

// Pull the secure-storage flag straight from the runtime payload. It's
// surfaced from the credential store on the main process via getPayload();
// see runtime.ts for the field. Falls back to `true` so older payloads
// that don't include the field don't show a spurious warning.
const secureStorageAvailable = computed<boolean>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flag = (store.payload as any)?.secureStorage?.available;
  return flag === undefined ? true : Boolean(flag);
});

const launchViaOptions = computed(() => {
  const opts = [
    { value: "ssh2", label: "ssh2 — built-in pure-JS client (strideterm manages keys)" },
    { value: "system-ssh", label: "System SSH — delegate to local ssh binary" },
  ];
  if (isWin) {
    opts.push({ value: "wsl", label: "WSL — run ssh inside a Windows Subsystem for Linux distro" });
  }
  return opts;
});

const isSsh2Mode = computed(() => form.ssh.defaultLaunchVia === "ssh2");
const isSystemSshMode = computed(() => form.ssh.defaultLaunchVia === "system-ssh");
const isWslMode = computed(() => form.ssh.defaultLaunchVia === "wsl");
const showSystemSshPath = computed(() => isSystemSshMode.value || isWslMode.value);

const sshDirPath = computed(() => {
  if (isWslMode.value) return "~/.ssh/ (inside WSL)";
  return isWin ? "%USERPROFILE%\\.ssh\\" : "~/.ssh/";
});

const credentialStoreName = computed(() => {
  if (isWin) return "Windows Credential Manager";
  if (isMac) return "macOS Keychain";
  return "libsecret / Secret Service";
});

const launchModeHelp = computed(() => {
  switch (form.ssh.defaultLaunchVia) {
    case "ssh2":
      return "Built-in SSH client. Keys must be imported into strideterm (stored in the OS keychain).";
    case "system-ssh":
      return `Runs your system's ssh binary. Reads ${sshDirPath.value}config and keys from disk, like the command line.`;
    case "wsl":
      return "Runs ssh inside a WSL distro. Uses the WSL-side ~/.ssh, not Windows-side.";
    default:
      return "Applies to new hosts by default. Each host can still override this individually.";
  }
});
</script>

<style scoped>
.settings-ssh-tab {
  padding: 8px;
}
.form-group {
  margin-bottom: 24px;
}
.form-row {
  margin-bottom: 16px;
}
.section-title {
  margin: 0 0 10px;
  font-size: 14px;
  letter-spacing: 0.3px;
}
.section-help {
  font-size: 12px;
  color: var(--muted);
  margin: -4px 0 12px;
  line-height: 1.5;
}
label {
  display: block;
  font-weight: 600;
  margin-bottom: 4px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  margin-bottom: 0;
}
.checkbox-label input[type="checkbox"] {
  width: auto;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.checkbox-label span {
  font-weight: 600;
}
.input {
  width: 100%;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
}
.select {
  appearance: auto;
  color-scheme: dark;
}
.select option {
  background: var(--panel-elevated);
  color: var(--text);
}
.form-help {
  font-size: 12px;
  color: var(--muted);
  margin-top: 4px;
  line-height: 1.5;
}
.form-help code,
.section-help code,
.management-note code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--text);
}
.management-note {
  margin-top: 10px;
}
.divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 20px 0;
}
.actions-row {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.ssh-secure-warning {
  margin: 0 0 18px;
  padding: 10px 12px;
  border: 1px solid #d97706;
  border-radius: 6px;
  background: rgba(217, 119, 6, 0.12);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.5;
}
.ssh-secure-warning code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
}
</style>
