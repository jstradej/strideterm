<template>
  <div :class="embedded ? 'ssh-hosts-dialog ssh-hosts-dialog--embedded' : 'dialog ssh-hosts-dialog'">
    <div v-if="!embedded" class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Manage Hosts</h2>
      </div>
    </div>

    <div class="ssh-hosts-dialog__toolbar">
      <div v-if="embedded" class="ssh-hosts-dialog__toolbar-title">
        <h3>Saved hosts</h3>
        <HelpTooltip
          text="Saved hosts are a reusable SSH address book shared across profiles in this installation. Use an entry wherever you open an SSH connection."
          label="Saved host book help"
        />
      </div>
      <div class="ssh-hosts-dialog__toolbar-actions">
        <input
          v-model="searchQuery"
          type="text"
          class="input"
          aria-label="Search saved hosts"
          placeholder="Search hosts…"
          title="Filter the host list by name, address, or tag (case-insensitive substring match)."
          :disabled="Boolean(testingHostId) || Boolean(inlineTransferHostId)"
        />
        <button
          type="button"
          class="button"
          :class="{ 'button--small': embedded }"
          title="Add a saved SSH connection. Enter the address and sign-in details, then save the host."
          :disabled="!canManage || Boolean(testingHostId)"
          @click="openHostEditor()"
        >
          + Add host
        </button>
      </div>
    </div>

    <div class="ssh-hosts-dialog__list">
      <div v-if="filteredHosts.length === 0" class="empty-state">
        <p>No SSH hosts found.</p>
      </div>
      <div v-for="host in filteredHosts" :key="host.id" class="ssh-host-card">
        <div class="ssh-host-card__header">
          <strong class="ssh-host-card__name">{{ host.name }}</strong>
          <div class="ssh-host-card__actions">
            <button
              type="button"
              class="button button--ghost button--small"
              :disabled="!canManage || Boolean(testingHostId)"
              title="Edit this saved SSH connection and its sign-in settings."
              @click="editHost(host)"
            >
              Edit
            </button>
            <button
              type="button"
              class="button button--ghost button--small"
              :disabled="!canTest || (testingHostId !== null && testingHostId !== host.id)"
              :title="
                canTest ? `Test the SSH connection to ${host.name} using its saved settings.` : testDisabledReason
              "
              @click="startHostTest(host)"
            >
              <Spinner v-if="testingHostId === host.id" size="sm" label="Testing SSH connection" />
              {{ testingHostId === host.id ? "Testing…" : testResults[host.id] ? "Test again" : "Test connection" }}
            </button>
            <button
              v-if="transferKey(host)"
              type="button"
              class="button button--ghost button--small"
              :disabled="!canManage || Boolean(testingHostId)"
              title="Copy the public half of the saved SSH key for this host. Add it to the server account's authorized_keys; never share the private key."
              @click="copyHostKey(host)"
            >
              {{ copiedHostKeyId === host.id ? "Copied public key" : "Copy public key" }}
            </button>
            <button
              v-if="transferKey(host)"
              type="button"
              class="button button--ghost button--small"
              :disabled="(inlineTransferHostId !== host.id && !canManage) || Boolean(testingHostId)"
              title="Add this public key to the saved host's server account. The private key stays in strIDEterm."
              @click="toggleHostTransfer(host)"
            >
              {{ inlineTransferHostId === host.id ? "Close key setup" : "Transfer public key…" }}
            </button>
            <button
              type="button"
              class="button button--danger button--small"
              :disabled="!canManage || confirmingDeleteId === host.id || Boolean(testingHostId)"
              title="Delete this saved host. Deletion is blocked while another saved host uses it as a jump host or an SSH tab references it; update those references first."
              @click="deleteHost(host)"
            >
              Delete
            </button>
          </div>
        </div>
        <div class="ssh-host-card__info">
          <span class="ssh-host-card__address"
            >{{ host.username ? `${host.username}@` : "" }}{{ host.host
            }}{{ host.port !== undefined ? `:${host.port}` : "" }}</span
          >
          <span class="ssh-host-card__summary">{{ methodLabel(host) }} · {{ authLabel(host) }}</span>
          <div v-if="host.tags && host.tags.length" class="ssh-host-card__tags">
            <span v-for="tag in host.tags" :key="tag" class="ssh-host-card__tag">{{ tag }}</span>
          </div>
        </div>
        <p v-if="recentlySavedHostId === host.id && transferKey(host)" class="ssh-host-card__key-hint">
          Saved with {{ keyLabel(host) }}. If this key is not authorized for the account yet, copy or transfer its
          public key.
        </p>
        <div v-if="inlineTransferHostId === host.id && transferKey(host)" class="ssh-host-card__test">
          <SshKeyTransferDialog
            :ref="setActiveTransferDialog"
            :key-id="transferKey(host)!.id"
            :profile-id="store.myActiveProfileId || 'default'"
            :initial-host-id="host.id"
            inline
            @cancel="inlineTransferHostId = null"
          />
        </div>
        <div v-if="testingHostId === host.id" class="ssh-host-card__test">
          <SshConnectionTestDialog
            :ref="setActiveTestDialog"
            :key="`${host.id}-${activeTestAttempt}`"
            :profile-id="testingProfileId"
            :draft="host as unknown as Record<string, unknown>"
            inline
            :on-result="(result) => finishHostTest(host.id, activeTestAttempt, result)"
            @cancel="cancelHostTest(host.id)"
          />
        </div>
        <p
          v-else-if="testResults[host.id]"
          class="ssh-host-card__test-result"
          :class="`ssh-host-card__test-result--${testResults[host.id].kind}`"
          role="status"
        >
          {{ testResults[host.id].message }}
        </p>
      </div>
      <p v-if="errorMessage" class="dialog__error" role="alert">{{ errorMessage }}</p>
    </div>
    <footer v-if="!embedded" class="dialog__footer dialog__footer--end ssh-hosts-dialog__footer">
      <button type="button" class="button button--ghost" title="Close SSH host management." @click="requestClose">
        {{ store.dialogLayers.length > 1 ? "Back" : "Close" }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import type { SshHost as BaseSshHost } from "../../../electron/shared/types/ssh.js";
import SshConnectionTestDialog from "./SshConnectionTestDialog.vue";
import SshKeyTransferDialog from "./SshKeyTransferDialog.vue";
import type { SshTestStatePayload } from "../../transport.js";
import Spinner from "../common/Spinner.vue";
import HelpTooltip from "../common/HelpTooltip.vue";
import { useSshPanelNavigation } from "./ssh-panel-navigation.js";
import { resolveSshLaunchVia } from "../../../electron/shared/ssh-connection.js";

// Extended host type — backend returns additional UI fields
interface SshHost extends BaseSshHost {
  name?: string;
  tags?: string[];
}

interface HostTestResult {
  mode: SshTestStatePayload["mode"] | null;
  status: SshTestStatePayload["status"] | null;
  error: string;
}

interface HostTestRowResult {
  kind: "success" | "neutral" | "error" | "cancelled";
  message: string;
}

const emit = defineEmits<{ cancel: [] }>();
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });
const embedded = computed(() => props.embedded);

const sshStore = useSshStore();
const store = useAppStore();
const panelNavigation = useSshPanelNavigation();
const searchQuery = ref("");
const errorMessage = ref("");
const testingHostId = ref<string | null>(null);
const testingHost = ref<SshHost | null>(null);
const testingProfileId = ref("default");
const activeTestAttempt = ref(0);
const testResults = ref<Record<string, HostTestRowResult>>({});
const activeTestDialog = ref<{ requestClose?: () => Promise<void> } | null>(null);
const inlineTransferHostId = ref<string | null>(null);
const activeTransferDialog = ref<{ requestClose?: () => Promise<boolean> } | null>(null);
const recentlySavedHostId = ref<string | null>(null);
const copiedHostKeyId = ref<string | null>(null);
const closing = ref(false);
const confirmingDeleteId = ref<string | null>(null);
const canManage = computed(
  () => !store.isRemoteTransport && sshStore.capabilities?.permissions?.canManageHosts !== false,
);
const canTest = computed(() => !store.isRemoteTransport);
const testDisabledReason = computed(() =>
  canTest.value ? "Test this saved host without opening a workspace tab." : "SSH tests run on the desktop.",
);

onMounted(() => {
  sshStore.load();
});

const filteredHosts = computed((): SshHost[] => {
  const query = searchQuery.value.toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hosts = (sshStore.hosts as any[]).filter(
    (h: SshHost) =>
      (h.name || "").toLowerCase().includes(query) ||
      h.host.toLowerCase().includes(query) ||
      (h.tags || []).some((t) => t.toLowerCase().includes(query)),
  ) as SshHost[];
  if (testingHost.value && !hosts.some((host) => host.id === testingHost.value?.id)) hosts.push(testingHost.value);
  return hosts;
});

function methodLabel(host: SshHost): string {
  const appDefault = String(store.payload?.appState?.settings?.ssh?.defaultLaunchVia || "system-ssh");
  const method = resolveSshLaunchVia(host.advanced?.launchVia, appDefault);
  return method === "ssh2" ? "Built-in SSH" : method === "wsl" ? "SSH in WSL" : "SSH on this computer";
}

function authLabel(host: SshHost): string {
  const appDefault = String(store.payload?.appState?.settings?.ssh?.defaultLaunchVia || "system-ssh");
  if (resolveSshLaunchVia(host.advanced?.launchVia, appDefault) !== "ssh2") return "OpenSSH configuration";
  const key = host.auth?.keyRef ? sshStore.keys.find((entry) => entry.id === host.auth?.keyRef) : null;
  if (key) return `Key · ${key.label || "Unnamed key"}`;
  if (host.auth?.methods?.includes("agent")) return "SSH agent";
  if (host.auth?.methods?.includes("keyboard-interactive") || host.auth?.methods?.includes("password"))
    return "Password / verification code";
  return host.advanced?.launchVia === "ssh2" ? "Sign-in required" : "OpenSSH configuration";
}

function transferKey(host: SshHost): { id: string; publicKey: string } | null {
  const appDefault = String(store.payload?.appState?.settings?.ssh?.defaultLaunchVia || "system-ssh");
  if (resolveSshLaunchVia(host.advanced?.launchVia, appDefault) !== "ssh2" || !host.username || !host.auth?.keyRef)
    return null;
  const key = sshStore.keys.find((candidate) => candidate.id === host.auth?.keyRef);
  return key?.publicKey ? { id: key.id, publicKey: key.publicKey } : null;
}

function keyLabel(host: SshHost): string {
  return sshStore.keys.find((key) => key.id === host.auth?.keyRef)?.label || "the selected key";
}

async function deleteHost(host: SshHost): Promise<void> {
  if (!(await closeInlineTransfer())) return;
  if (!canManage.value || confirmingDeleteId.value) return;
  confirmingDeleteId.value = host.id;
  errorMessage.value = "";
  try {
    const confirmed = await store.confirmInApp({
      title: "Delete SSH host?",
      message: `Delete host "${host.name || host.host}"? Deletion is blocked while an SSH tab or another saved host refers to it.`,
      confirmLabel: "Delete host",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!confirmed) return;
    sshStore.error = null;
    const result = (await sshStore.deleteHost(host.id)) as
      | {
          ok?: boolean;
          error?: string;
          workspaces?: { workspaceName: string; panelTitle: string }[];
          hosts?: { name: string }[];
        }
      | undefined;
    if (result?.ok === false && result.error === "in-use") {
      const uses = (result.workspaces || []).map((item) => `${item.workspaceName} · ${item.panelTitle}`);
      const jumpRefs = (result.hosts || []).map((item) => `${item.name} (jump host)`);
      errorMessage.value = `This host is still referenced by ${[...uses, ...jumpRefs].join(", ") || "another saved SSH entry"}. Update those references before deleting it.`;
    } else if (result?.ok === false) {
      errorMessage.value = "Could not delete this SSH host.";
    } else if (!result) {
      errorMessage.value = sshStore.error || "Could not delete this SSH host.";
    }
  } catch (error) {
    errorMessage.value = (error as Error).message || "Could not delete this SSH host.";
  } finally {
    confirmingDeleteId.value = null;
  }
}

async function startHostTest(host: SshHost): Promise<void> {
  if (!(await closeInlineTransfer())) return;
  if (!canTest.value || testingHostId.value) return;
  errorMessage.value = "";
  testResults.value = { ...testResults.value };
  delete testResults.value[host.id];
  testingHost.value = host;
  testingProfileId.value = store.myActiveProfileId || "default";
  activeTestAttempt.value += 1;
  testingHostId.value = host.id;
}

async function editHost(host: SshHost): Promise<void> {
  const results = { ...testResults.value };
  delete results[host.id];
  testResults.value = results;
  openHostEditor(host);
}

async function openHostEditor(host: SshHost | null = null): Promise<void> {
  if (!(await closeInlineTransfer())) return;
  recentlySavedHostId.value = null;
  const onSaved = (saved: SshHost) => {
    const selectedNewKey = Boolean(saved.auth?.keyRef && saved.auth.keyRef !== host?.auth?.keyRef);
    const builtIn =
      resolveSshLaunchVia(
        saved.advanced?.launchVia,
        String(store.payload?.appState?.settings?.ssh?.defaultLaunchVia || "system-ssh"),
      ) === "ssh2";
    recentlySavedHostId.value = selectedNewKey && builtIn ? saved.id || null : null;
  };
  if (panelNavigation) panelNavigation.open("SshHostEditor", { host, onSaved });
  else store.openSshHostEditor(host);
}

async function toggleHostTransfer(host: SshHost) {
  if (!transferKey(host)) return;
  if (inlineTransferHostId.value === host.id) {
    if (activeTransferDialog.value?.requestClose && !(await activeTransferDialog.value.requestClose())) return;
    inlineTransferHostId.value = null;
  } else {
    if (inlineTransferHostId.value && activeTransferDialog.value?.requestClose) {
      if (!(await activeTransferDialog.value.requestClose())) return;
    }
    inlineTransferHostId.value = host.id;
  }
}

async function copyHostKey(host: SshHost) {
  const key = transferKey(host);
  if (!key) return;
  try {
    await navigator.clipboard.writeText(key.publicKey);
    copiedHostKeyId.value = host.id;
    setTimeout(() => {
      if (copiedHostKeyId.value === host.id) copiedHostKeyId.value = null;
    }, 2000);
  } catch (error) {
    errorMessage.value = `Could not copy public key: ${(error as Error).message || "clipboard unavailable"}`;
  }
}

function setActiveTransferDialog(component: unknown) {
  activeTransferDialog.value =
    component && typeof component === "object" && "requestClose" in component
      ? (component as { requestClose?: () => Promise<boolean> })
      : null;
}

function finishHostTest(hostId: string, attempt: number, result: HostTestResult): void {
  if (testingHostId.value !== hostId || activeTestAttempt.value !== attempt) return;
  let rowResult: HostTestRowResult;
  if (result.status === "authenticated") {
    rowResult = {
      kind: "success",
      message:
        result.mode === "ssh2" ? "Authentication succeeded." : "OpenSSH authentication and verification succeeded.",
    };
  } else if (result.error || result.status === "error") {
    rowResult = { kind: "error", message: result.error || "SSH connection test failed." };
  } else if (result.mode === "system-ssh" || result.mode === "wsl") {
    rowResult = {
      kind: "neutral",
      message:
        result.status === "process-running"
          ? "The SSH process started; authentication was not confirmed."
          : result.status === "disconnected" || result.status === "cancelled"
            ? "The SSH process ended; authentication was not confirmed."
            : "The SSH test ended; authentication was not confirmed.",
    };
  } else {
    rowResult = { kind: "cancelled", message: "Test stopped before authentication was confirmed." };
  }
  testResults.value = { ...testResults.value, [hostId]: rowResult };
  testingHost.value = null;
  testingHostId.value = null;
}

function cancelHostTest(hostId: string): void {
  if (testingHostId.value === hostId) {
    testingHost.value = null;
    testingHostId.value = null;
  }
}

function setActiveTestDialog(component: unknown): void {
  activeTestDialog.value =
    component && typeof component === "object" && "requestClose" in component
      ? (component as { requestClose?: () => Promise<void> })
      : null;
}

async function requestClose(): Promise<boolean> {
  if (closing.value) return false;
  closing.value = true;
  try {
    if (!(await closeInlineTransfer())) return false;
    if (testingHostId.value) {
      await nextTick();
      if (testingHostId.value) {
        if (!activeTestDialog.value?.requestClose) return false;
        await activeTestDialog.value.requestClose();
        if (testingHostId.value) return false;
      }
    }
    emit("cancel");
    return true;
  } finally {
    closing.value = false;
  }
}

async function closeInlineTransfer(): Promise<boolean> {
  if (!inlineTransferHostId.value) return true;
  if (activeTransferDialog.value?.requestClose && !(await activeTransferDialog.value.requestClose())) return false;
  inlineTransferHostId.value = null;
  return true;
}

defineExpose({ requestClose });
</script>

<style scoped>
.ssh-hosts-dialog {
  width: min(600px, 100%);
  height: min(600px, 85vh);
  display: flex;
  flex-direction: column;
}
.ssh-hosts-dialog--embedded {
  width: 100%;
  height: auto;
  max-height: none;
}
.ssh-hosts-dialog > .dialog__header {
  margin-bottom: 16px;
}
.ssh-hosts-dialog__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.ssh-hosts-dialog__toolbar-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.ssh-hosts-dialog__toolbar-title h3 {
  margin: 0;
}
.ssh-hosts-dialog--embedded .ssh-hosts-dialog__toolbar {
  padding-bottom: 0;
  border-bottom: 0;
  margin-bottom: 12px;
}
.ssh-hosts-dialog__toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
}
.ssh-hosts-dialog__toolbar-actions .input {
  flex: 1 1 220px;
  min-width: 0;
  max-width: 340px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px;
  border-radius: 4px;
}
.ssh-hosts-dialog__toolbar-actions .button {
  flex: 0 0 auto;
  white-space: nowrap;
}
.ssh-hosts-dialog__list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ssh-hosts-dialog__footer {
  flex-shrink: 0;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.ssh-host-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
}

.ssh-host-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.ssh-host-card__test {
  flex: 1 0 100%;
  min-width: 0;
  margin-top: 12px;
}
.ssh-host-card__test-result {
  flex: 1 0 100%;
  margin: 10px 0 0;
  font-size: 12px;
}
.ssh-host-card__test-result--success {
  color: var(--success, #55bd7b);
}
.ssh-host-card__test-result--neutral,
.ssh-host-card__test-result--cancelled {
  color: var(--muted);
}
.ssh-host-card__test-result--error {
  color: var(--danger, #e26c6c);
}
.ssh-host-card__info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ssh-host-card__key-hint {
  flex: 1 0 100%;
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.ssh-host-card__name {
  font-size: 14px;
  font-weight: 600;
}
.ssh-host-card__address {
  font-size: 12px;
  color: var(--muted);
  font-family: var(--font-mono);
}
.ssh-host-card__summary {
  display: block;
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
}
.ssh-host-card__tags {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.ssh-host-card__tag {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
}
.ssh-host-card__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 6px;
}
.empty-state {
  text-align: center;
  color: var(--muted);
  padding: 32px;
}
@media (max-width: 540px) {
  .ssh-hosts-dialog__toolbar {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .ssh-hosts-dialog__toolbar-title {
    flex: 1 1 100%;
  }
  .ssh-hosts-dialog__toolbar-actions {
    flex: 1 1 100%;
  }
}
</style>
