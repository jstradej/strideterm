<template>
  <div class="settings-ssh-tab">
    <nav class="ssh-subtabs" role="tablist" aria-label="SSH settings sections" @keydown="onTabKeydown">
      <button
        v-for="(tab, index) in sshTabs"
        :id="`ssh-settings-tab-${tab.id}`"
        :key="tab.id"
        :ref="(element) => setTabRef(element, index)"
        type="button"
        role="tab"
        class="ssh-subtab"
        :class="{ 'ssh-subtab--active': activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`ssh-settings-panel-${tab.id}`"
        :tabindex="activeTab === tab.id ? 0 : -1"
        :disabled="localFlow.length > 1 && activeTab !== tab.id"
        :title="
          localFlow.length > 1 && activeTab !== tab.id
            ? 'Return to the current editor before changing SSH sections.'
            : tab.id === 'default'
              ? 'Set the SSH connection method used by hosts that follow the app default.'
              : tab.id === 'hosts'
                ? 'Add and maintain saved SSH endpoints, test connections, and set up public keys.'
                : 'Import, generate, rename, and manage app-stored SSH keys.'
        "
        @click="switchTab(tab.id)"
      >
        <svg v-if="tab.id === 'default'" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3.5 5h13M3.5 10h13M3.5 15h13" />
          <circle cx="8" cy="5" r="1.6" />
          <circle cx="12.5" cy="10" r="1.6" />
          <circle cx="7" cy="15" r="1.6" />
        </svg>
        <svg v-else-if="tab.id === 'hosts'" viewBox="0 0 20 20" aria-hidden="true">
          <rect x="3" y="3.5" width="14" height="5.5" rx="1" />
          <rect x="3" y="11" width="14" height="5.5" rx="1" />
          <path d="M6 6.2h.1M6 13.8h.1M9 6.2h5M9 13.8h5" />
        </svg>
        <svg v-else viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="7" cy="8" r="3" />
          <path d="m9.3 10.3 6.2 6.2m-2.5-2.5 1.6-1.6m-3.3-.1 1.6-1.6" />
        </svg>
        {{ tab.label }}
      </button>
    </nav>
    <div v-if="form.ssh.storagePolicyMigrationNotice" class="ssh-secure-warning" role="status">
      SSH key storage now requires encrypted storage by default. Review the requirement below before importing a private
      key.
    </div>
    <div v-if="!canManage" class="ssh-secure-warning" role="status">
      SSH host and key management is available on the computer running strIDEterm. {{ capabilityReason }}
    </div>
    <div v-if="capabilities && !capabilities.safeStorageAvailable" class="ssh-secure-warning" role="alert">
      <strong v-if="form.ssh.requireEncryptedStorage">Private key storage is disabled.</strong>
      <strong v-else>Private keys will be stored without OS encryption.</strong>
      {{
        form.ssh.requireEncryptedStorage
          ? "This computer has no encrypted credential storage. Keep the secure-storage requirement enabled, or turn it off only if you accept the risk."
          : "The current settings permit key storage without OS encryption. Anyone able to read the local credentials file may recover those keys."
      }}
    </div>

    <section
      v-if="activeTab === 'default'"
      :id="`ssh-settings-panel-default`"
      role="tabpanel"
      aria-labelledby="ssh-settings-tab-default"
      class="form-group"
    >
      <h3 class="section-title">Connection</h3>
      <div class="form-row">
        <label
          >Default connection method <HelpTooltip :text="help.defaultMethod" label="Default connection method help"
        /></label>
        <CustomSelect
          v-model="form.ssh.defaultLaunchVia"
          class="select"
          :options="launchViaOptions"
          :disabled="!canManage"
        />
        <p class="form-help">{{ launchModeHelp }}</p>
        <p v-if="defaultChanged" class="form-help">
          This changes the next connection for {{ inheritedHostCount }} host(s) using the app default. Open terminals
          are unchanged.
        </p>
      </div>
    </section>

    <details v-if="activeTab === 'default'" class="ssh-advanced">
      <summary>Advanced settings</summary>
      <div class="form-group">
        <div class="form-row">
          <label v-if="isSystem"
            >Custom SSH executable <HelpTooltip :text="help.executable" label="Custom SSH executable help"
          /></label>
          <label v-else-if="isWslMode"
            >SSH executable inside WSL <HelpTooltip :text="help.wslExecutable" label="WSL SSH executable help"
          /></label>
          <input
            v-if="isSystem"
            v-model="form.ssh.systemSshPath"
            type="text"
            class="input"
            placeholder="Use installed ssh"
            :disabled="!canManage"
          />
          <input
            v-else-if="isWslMode"
            v-model="form.ssh.wslSshExec"
            type="text"
            class="input"
            placeholder="ssh"
            :disabled="!canManage"
          />
          <p v-if="isSystem || isWslMode" class="form-help">
            Leave empty to use the installed SSH command for the selected environment.
          </p>
        </div>
        <div v-if="isWslMode" class="form-row">
          <label>WSL default distribution <HelpTooltip :text="help.wslDistro" label="WSL distribution help" /></label>
          <CustomSelect
            v-if="wslDistros.length"
            v-model="form.ssh.wslDefaultDistro"
            class="select"
            :options="wslDistroOptions"
            :disabled="!canManage"
          />
          <input
            v-else
            v-model="form.ssh.wslDefaultDistro"
            type="text"
            class="input"
            placeholder="Default distribution"
            :disabled="!canManage"
          />
        </div>
        <div v-if="isBuiltIn" class="form-row">
          <label>Default SSH agent source <HelpTooltip :text="help.agent" label="SSH agent source help" /></label>
          <CustomSelect
            v-model="form.ssh.defaultAgentMode"
            class="select"
            :options="agentModeOptions"
            :disabled="!canManage"
          />
          <input
            v-model="form.ssh.agentPath"
            type="text"
            class="input"
            placeholder="Automatic"
            :disabled="!canManage"
          />
          <p class="form-help">Set a custom path only for agents that require one.</p>
        </div>
        <div v-if="isBuiltIn" class="form-row">
          <label class="checkbox-label">
            <input v-model="form.ssh.requireEncryptedStorage" type="checkbox" :disabled="!canManage" />
            <span>Require encrypted storage <HelpTooltip :text="help.storage" label="Encrypted storage help" /></span>
          </label>
        </div>
      </div>
    </details>

    <p v-if="activeTab !== 'default' && !localFlow.length" class="ssh-persistence-note" role="note">
      Host, key, and certificate changes are saved as you make them. Settings <strong>Save</strong> applies the default
      connection settings.
    </p>
    <section
      v-show="activeTab === 'hosts' && !localFlow.length"
      id="ssh-settings-panel-hosts"
      role="tabpanel"
      aria-labelledby="ssh-settings-tab-hosts"
      class="ssh-embedded-panel"
    >
      <KeepAlive><SshHostsDialog v-if="activeTab === 'hosts'" ref="hostsPanel" embedded /></KeepAlive>
    </section>
    <section
      v-show="activeTab === 'keys' && !localFlow.length"
      id="ssh-settings-panel-keys"
      role="tabpanel"
      aria-labelledby="ssh-settings-tab-keys"
      class="ssh-embedded-panel"
    >
      <KeepAlive><SshKeyManager v-if="activeTab === 'keys'" ref="keysPanel" embedded /></KeepAlive>
    </section>
    <div v-if="localFlow.length" class="ssh-local-flow" role="region" aria-label="SSH editor">
      <div v-if="!flowOwnsHeaderActions" class="ssh-local-flow__toolbar">
        <button type="button" class="button button--ghost button--small" @click="requestLocalBack">
          {{ localBackLabel }}
        </button>
      </div>
      <div v-for="(entry, index) in localFlow" v-show="index === localFlow.length - 1" :key="entry.id">
        <component
          :is="flowComponent(entry.name)"
          :ref="(instance) => setFlowComponent(entry.id, instance)"
          v-bind="entry.props"
          @cancel="handleFlowCancel(entry.id)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, shallowRef } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useSshStore } from "../../../stores/ssh.js";
import CustomSelect from "../../common/CustomSelect.vue";
import HelpTooltip from "../../common/HelpTooltip.vue";
import type { SshConnectionSettings } from "../../../../electron/shared/ssh-connection.js";
import type { SshHost } from "../../../../electron/shared/types/ssh.js";
import { sshGlobalDefaultMethodHelp } from "../../../lib/ssh-help-text.js";
import SshHostsDialog from "../../ssh/SshHostsDialog.vue";
import SshKeyManager from "../../ssh/SshKeyManager.vue";
import SshHostEditor from "../../ssh/SshHostEditor.vue";
import SshKeyImportDialog from "../../ssh/SshKeyImportDialog.vue";
import SshKeyGenerateDialog from "../../ssh/SshKeyGenerateDialog.vue";
import SshCertImportDialog from "../../ssh/SshCertImportDialog.vue";
import SshConnectionTestDialog from "../../ssh/SshConnectionTestDialog.vue";
import SshKeyTransferDialog from "../../ssh/SshKeyTransferDialog.vue";
import { provideSshPanelNavigation, type SshPanelDialog } from "../../ssh/ssh-panel-navigation.js";

const form = inject<{ ssh: SshConnectionSettings & { preferAgent: boolean; certExpiryWarnHours: number } }>(
  "settingsForm",
)!;
const store = useAppStore();
const ssh = useSshStore();
const sshTabs = [
  { id: "default", label: "Default" },
  { id: "hosts", label: "Hosts" },
  { id: "keys", label: "Keys" },
] as const;
type SshTab = (typeof sshTabs)[number]["id"];
const activeTab = ref<SshTab>("default");
const tabRefs = ref<HTMLElement[]>([]);
const localFlow = ref<
  Array<{ id: number; name: SshPanelDialog; props: Record<string, unknown>; returnFocus?: HTMLElement }>
>([]);
type SshFlowComponent = { requestClose?: () => Promise<void> | void };
const flowComponents = shallowRef(new Map<number, SshFlowComponent>());
const activeFlowComponent = computed(() => {
  const id = localFlow.value.at(-1)?.id;
  return id === undefined ? null : (flowComponents.value.get(id) ?? null);
});
const hostsPanel = ref<{ requestClose?: () => Promise<boolean> } | null>(null);
const keysPanel = ref<{ requestClose?: () => Promise<boolean> } | null>(null);
let nextFlowId = 0;
const localBackLabel = computed(() => {
  const entry = localFlow.value.at(-1);
  if (typeof entry?.props.backLabel === "string") return entry.props.backLabel;
  if (localFlow.value.length > 1) return activeTab.value === "hosts" ? "Back to host" : "Back to keys";
  return activeTab.value === "hosts" ? "Back to hosts" : "Back to keys";
});
const activeFlowName = computed(() => localFlow.value.at(-1)?.name ?? null);
const flowOwnsHeaderActions = computed(() =>
  [
    "SshHostEditor",
    "SshKeyImportDialog",
    "SshKeyGenerateDialog",
    "SshCertImportDialog",
    "SshConnectionTestDialog",
  ].includes(activeFlowName.value || ""),
);
const componentMap = {
  SshHostEditor,
  SshKeyImportDialog,
  SshKeyGenerateDialog,
  SshCertImportDialog,
  SshConnectionTestDialog,
  SshKeyTransferDialog,
};
function openLocalFlow(name: SshPanelDialog, props: Record<string, unknown> = {}) {
  const ownsHeaderActions = [
    "SshHostEditor",
    "SshKeyImportDialog",
    "SshKeyGenerateDialog",
    "SshCertImportDialog",
    "SshConnectionTestDialog",
  ].includes(name);
  const resolved = { ...props, ...(ownsHeaderActions ? { embedded: true } : {}) };
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  localFlow.value = [...localFlow.value, { id: ++nextFlowId, name, props: resolved, returnFocus }];
}
async function backLocalFlow() {
  const opener = localFlow.value.at(-1)?.returnFocus;
  localFlow.value = localFlow.value.slice(0, -1);
  await nextTick();
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}
function handleFlowCancel(id: number) {
  if (localFlow.value.at(-1)?.id === id) void backLocalFlow();
}
async function requestLocalBack() {
  if (activeFlowComponent.value?.requestClose) await activeFlowComponent.value.requestClose();
  else await backLocalFlow();
}
provideSshPanelNavigation({ open: openLocalFlow, back: backLocalFlow });
function flowComponent(name: SshPanelDialog) {
  return componentMap[name];
}
function setFlowComponent(id: number, component: unknown) {
  const current = flowComponents.value.get(id);
  const resolved =
    component && typeof component === "object" && "requestClose" in component ? (component as SshFlowComponent) : null;
  if (current === resolved) return;
  const next = new Map(flowComponents.value);
  if (resolved) next.set(id, resolved);
  else next.delete(id);
  flowComponents.value = next;
}
function setTabRef(element: unknown, index: number) {
  if (element instanceof HTMLElement) tabRefs.value[index] = element;
}
async function onTabKeydown(event: KeyboardEvent) {
  if (localFlow.value.length > 1) return;
  const index = sshTabs.findIndex((tab) => tab.id === activeTab.value);
  const next =
    event.key === "ArrowRight"
      ? (index + 1) % sshTabs.length
      : event.key === "ArrowLeft"
        ? (index - 1 + sshTabs.length) % sshTabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? sshTabs.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  await switchTab(sshTabs[next]!.id);
  if (activeTab.value === sshTabs[next]!.id) tabRefs.value[next]?.focus();
}
async function switchTab(tab: SshTab) {
  if (tab === activeTab.value) return;
  if (localFlow.value.length && !(await requestClose())) return;
  if (activeTab.value === "hosts" && hostsPanel.value && !(await hostsPanel.value.requestClose?.())) return;
  if (activeTab.value === "keys" && keysPanel.value && !(await keysPanel.value.requestClose?.())) return;
  activeTab.value = tab;
}
async function requestClose(): Promise<boolean> {
  if (localFlow.value.length) {
    if (!activeFlowComponent.value?.requestClose) return false;
    await activeFlowComponent.value.requestClose();
    return localFlow.value.length === 0;
  }
  if (activeTab.value === "hosts" && hostsPanel.value?.requestClose) {
    return hostsPanel.value.requestClose();
  }
  if (activeTab.value === "keys" && keysPanel.value && !(await keysPanel.value.requestClose?.())) return false;
  return true;
}
defineExpose({ requestClose });
const capabilities = computed(() => ssh.capabilities);
const canManage = computed(() => !store.isRemoteTransport && (capabilities.value?.permissions?.canManageHosts ?? true));
const capabilityReason = computed(
  () => capabilities.value?.permissions?.reason || "Connect to the desktop app to manage saved SSH configuration.",
);
const platform = computed(() => capabilities.value?.platform || "unknown");
const wslDistros = computed<string[]>(() => capabilities.value?.wsl?.distros || []);
const wslDistroOptions = computed(() => [
  { value: "", label: "Default distribution" },
  ...wslDistros.value.map((name) => ({ value: name, label: name })),
]);
const agentModeOptions = computed(() => [
  {
    value: "auto",
    label: `Automatic${capabilities.value && !capabilities.value.openSshAgent ? " · unavailable" : ""}`,
    disabled: capabilities.value ? !capabilities.value.openSshAgent : false,
  },
  {
    value: "pipe",
    label: `OpenSSH agent pipe (Windows OpenSSH)${capabilities.value && !capabilities.value.openSshAgent ? " · unavailable" : ""}`,
    disabled: capabilities.value ? !capabilities.value.openSshAgent : false,
  },
  {
    value: "pageant",
    label: `Pageant${capabilities.value && !capabilities.value.pageant ? " · unavailable" : ""}`,
    disabled: capabilities.value ? !capabilities.value.pageant : false,
  },
  { value: "socket", label: "Unix socket (macOS/Linux)" },
  { value: "off", label: "Off" },
]);
const launchViaOptions = computed(() => {
  const options = [
    {
      value: "system-ssh",
      label: `SSH on this computer${capabilities.value && !capabilities.value.systemSsh ? " · unavailable" : ""}`,
      disabled: capabilities.value ? !capabilities.value.systemSsh : false,
    },
    { value: "ssh2", label: "Built-in SSH" },
  ];
  if (platform.value === "win32")
    options.push({
      value: "wsl",
      label: `SSH in WSL${capabilities.value && !capabilities.value.wsl?.installed ? " · unavailable" : ""}`,
      disabled: capabilities.value ? !capabilities.value.wsl?.installed : true,
    });
  return options;
});
const isBuiltIn = computed(() => form.ssh.defaultLaunchVia === "ssh2");
const isSystem = computed(() => form.ssh.defaultLaunchVia === "system-ssh");
const isWslMode = computed(() => form.ssh.defaultLaunchVia === "wsl");
const savedDefault = computed(() => String(store.payload?.appState?.settings?.ssh?.defaultLaunchVia || "system-ssh"));
const defaultChanged = computed(() => form.ssh.defaultLaunchVia !== savedDefault.value);
const inheritedHostCount = computed(
  () => ssh.hosts.filter((host: SshHost) => !host.advanced?.launchVia || host.advanced.launchVia === "default").length,
);
const launchModeHelp = computed(() =>
  isSystem.value
    ? "Uses the SSH configuration and keys on the computer running strIDEterm. Sign-in prompts appear in the terminal."
    : isWslMode.value
      ? "Uses SSH configuration and keys inside the selected WSL distribution. Sign-in prompts appear in the terminal."
      : "Uses strIDEterm sign-in prompts and app-managed keys. OpenSSH does not need to be installed.",
);
const help = {
  defaultMethod: sshGlobalDefaultMethodHelp,
  executable:
    "Leave empty to use the normal SSH command on this computer. Enter a full path only when you need a different OpenSSH installation; that installation may use a different config and keys.",
  wslExecutable:
    "Leave empty to use ssh inside the selected WSL distribution, or enter a Linux path such as /usr/bin/ssh. Windows executable paths do not work inside Linux.",
  wslDistro:
    "Choose the Linux environment that contains your SSH setup. Default uses the distribution selected in Windows.",
  agent:
    "An SSH agent holds unlocked keys so you can connect without entering each key's passphrase. Automatic checks for a running agent and is the simplest choice. OpenSSH agent pipe uses the Windows OpenSSH agent service; Pageant is the PuTTY agent. Unix socket connects to an agent socket on macOS or Linux. Off ignores agents. The path below is only for a non-standard agent endpoint.",
  storage:
    "When enabled, strIDEterm refuses to import or generate private keys if the operating system cannot encrypt credentials at rest. When disabled, strIDEterm uses OS encryption when available and falls back to unencrypted local storage only when it is not. This also governs saved key passphrases, but not keys managed by OpenSSH or WSL.",
};

onMounted(() => {
  void ssh.load(true);
});
</script>

<style scoped>
.settings-ssh-tab {
  position: relative;
  padding: 8px;
  min-height: 100%;
}
.ssh-subtabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 16px;
  padding: 2px;
}
.ssh-subtab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.025);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.ssh-subtab svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ssh-subtab--active {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
.ssh-subtab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ssh-subtab:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ssh-embedded-panel {
  overflow: visible;
}
.ssh-persistence-note {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 12px;
}
.ssh-local-flow {
  min-height: 320px;
}
.ssh-local-flow__toolbar {
  margin: 0 0 10px;
}
.ssh-local-flow :deep(.dialog) {
  width: 100%;
  max-width: none;
  height: auto;
  max-height: none;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.ssh-local-flow :deep(.eyebrow) {
  display: none;
}
.ssh-local-flow :deep(.dialog__header) {
  margin-bottom: 12px;
}
.ssh-local-flow :deep(.dialog__footer) {
  padding-top: 12px;
  margin-top: 16px;
}
.ssh-local-flow :deep(.ssh-key-generate label) {
  display: flex;
  align-items: center;
  gap: 6px;
}
.form-group {
  margin-bottom: 20px;
}
.form-row {
  margin-bottom: 14px;
}
.section-title {
  margin: 0 0 10px;
  font-size: 14px;
  letter-spacing: 0.3px;
}
.section-help,
.form-help {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  margin: 5px 0 0;
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
}
.checkbox-label input {
  width: auto;
  accent-color: var(--accent);
}
.form-row > .select + input.input {
  margin-top: 8px;
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
.ssh-advanced {
  margin: 12px 0 20px;
}
.ssh-advanced summary {
  cursor: pointer;
  padding: 8px 0;
}
.ssh-advanced .form-group {
  padding-top: 12px;
}
.actions-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.divider {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 18px 0;
}
.ssh-secure-warning {
  margin: 0 0 16px;
  padding: 10px 12px;
  border: 1px solid #d97706;
  border-radius: 6px;
  background: rgba(217, 119, 6, 0.12);
  font-size: 12.5px;
  line-height: 1.5;
}
</style>
