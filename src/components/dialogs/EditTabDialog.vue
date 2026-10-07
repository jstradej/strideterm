<template>
  <div class="dialog edit-tab-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ mode === "new" ? "New tab" : "Edit tab" }}</h2>
      </div>

      <div v-if="mode === 'new'" class="new-tab-kind" role="group" aria-label="New tab type">
        <button
          type="button"
          :class="['segmented__btn', { 'segmented__btn--active': tabType === 'local' }]"
          title="Create a local shell tab on this computer."
          @click="tabType = 'local'"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 3.5h12v9H2zM4.5 6l2 2-2 2M8 10h3" /></svg>
          Local shell
        </button>
        <button
          type="button"
          :class="['segmented__btn', { 'segmented__btn--active': tabType === 'ssh' }]"
          title="Create an SSH tab or connect to a saved host."
          @click="tabType = 'ssh'"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6" />
            <path d="M2 8h12M8 2c1.7 1.6 2.4 3.6 2.4 6S9.7 12.4 8 14M8 2C6.3 3.6 5.6 5.6 5.6 8S6.3 12.4 8 14" />
          </svg>
          SSH
        </button>
      </div>
    </div>

    <form class="form edit-tab-dialog__form" @submit.prevent="handleSubmit">
      <label class="field">
        <span>Title</span>
        <div class="title-row">
          <button
            type="button"
            class="icon-btn"
            :title="
              showIconPicker
                ? 'Close the emoji picker without changing the icon.'
                : 'Open the emoji picker to prefix this tab with an icon — the picked emoji is inserted at the start of the title.'
            "
            @click="showIconPicker = !showIconPicker"
          >
            {{ currentIcon || "\u{1F4BB}" }}
          </button>
          <input
            ref="titleRef"
            v-model="titleInput"
            class="title-input"
            maxlength="60"
            title="Tab title shown in the tab bar. Edit freely — leading emoji is treated as the icon and is editable via the icon picker."
            required
            data-validation-required="Enter a tab name, for example Claude Code or Server logs."
          />
        </div>
        <div v-if="showIconPicker" class="icon-picker">
          <button
            v-for="icon in BADGE_ICONS"
            :key="icon"
            type="button"
            class="icon-picker__btn"
            :title="`Use ${icon} as the tab's leading icon — replaces any existing emoji prefix in the title.`"
            @click="pickIcon(icon)"
          >
            {{ icon }}
          </button>
        </div>
      </label>

      <label v-if="tabType !== 'ssh' && sshTab" class="field">
        <span
          >Startup command
          <HelpTooltip
            text="Runs on the server right after sign-in and replaces the host's own startup command for this tab. Leave it blank to use the host's startup command, or a normal shell. Connection details (address, sign-in, port, jump hosts) are edited with Edit SSH host."
            label="Startup command help"
        /></span>
        <input v-model="commandInput" placeholder="e.g. claude" maxlength="500" />
      </label>
      <label v-else-if="tabType !== 'ssh'" class="field">
        <span>Command</span>
        <input v-model="commandInput" placeholder="optional boot command" maxlength="500" />
      </label>

      <component
        :is="tabType === 'ssh' ? 'div' : 'details'"
        v-if="!sshTab"
        :class="tabType === 'ssh' ? 'ssh-connection-content' : 'advanced-options'"
        :open="tabType !== 'ssh' && advancedOpen"
        @toggle="onAdvancedToggle"
      >
        <summary v-if="tabType !== 'ssh'">
          <span>Advanced</span>
          <span v-if="advancedSummary" class="advanced-options__summary">{{ advancedSummary }}</span>
        </summary>
        <div class="advanced-content">
          <template v-if="tabType === 'ssh'">
            <div class="segmented advanced-options__control" role="tablist" aria-label="SSH mode">
              <button
                type="button"
                role="tab"
                :aria-selected="sshMode === 'saved'"
                :class="['segmented__btn', { 'segmented__btn--active': sshMode === 'saved' }]"
                :disabled="sshHosts.length === 0"
                :title="
                  sshHosts.length === 0
                    ? 'Disabled — no saved hosts yet. Switch to Quick connect to type host details by hand, or add a host in Settings → SSH first.'
                    : 'Pick a host from your strIDEterm host book below — saved hosts carry their auth, jump chain, and post-login command.'
                "
                @click="sshMode = 'saved'"
              >
                Saved host
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="sshMode === 'quick'"
                :class="['segmented__btn', { 'segmented__btn--active': sshMode === 'quick' }]"
                title="Type host / user / port / auth in-place — useful for one-off connections. Optionally save the result to the host book before connecting."
                @click="sshMode = 'quick'"
              >
                Quick connect
              </button>
            </div>

            <template v-if="sshMode === 'saved'">
              <div class="field saved-host-field">
                <div class="saved-host-field__label">SSH Host</div>
                <div class="saved-host-row">
                  <CustomSelect
                    v-model="selectedSshHostId"
                    class="saved-host-row__select"
                    placeholder="Select a host…"
                    :options="hostOptions"
                    @change="onHostSelected"
                  />
                  <button
                    type="button"
                    class="button button--ghost saved-host-row__edit"
                    :disabled="!selectedSshHostId"
                    title="Open the full SSH host editor for the currently selected host — change auth, port, jump chain, post-login command, etc. Returns to this dialog when saved."
                    @click="editSelectedHost"
                  >
                    Edit…
                  </button>
                </div>
              </div>
            </template>

            <template v-else>
              <fieldset class="quick-fields" :disabled="transferOpen">
                <div class="quick-grid">
                  <SshConnectionIdentityFields
                    v-model:host="quick.host"
                    v-model:username="quick.username"
                    host-placeholder="bastion.example.com"
                    :require-username="quickMode === 'ssh2'"
                    host-help="Enter a server address. With SSH on this computer or SSH in WSL, use an alias from that environment's SSH config. Built-in SSH needs a server address."
                    username-help="This is the account on the remote server. Built-in SSH requires it; with SSH on this computer or in WSL, leave it empty to use that environment's SSH config."
                    @host-input="autofillTitle"
                  />
                  <label class="field">
                    <span
                      >Connection method <HelpTooltip :text="connectionMethodHelp" label="Connection method help"
                    /></span>
                    <CustomSelect v-model="quick.launchVia" :options="launchViaOptions" />
                  </label>
                </div>

                <div v-if="quickMode === 'ssh2'" class="field auth-field">
                  <div class="auth-field__heading">
                    <span class="auth-field__label">Authentication</span>
                    <HelpTooltip :text="sshAuthenticationHelp" label="Authentication options help" />
                  </div>
                  <CustomSelect
                    v-model="quick.authMethod"
                    :options="authMethodOptions"
                    @update:model-value="authTouched = true"
                  />
                </div>

                <div v-if="quickMode === 'ssh2' && quick.authMethod === 'publickey'" class="field">
                  <span
                    >Key stored in strIDEterm
                    <HelpTooltip
                      text="Choose the private key whose matching public key is authorized on the server. Import or generate a key, then add its public key to your account on the server. A key passphrase is separate from your server login password."
                      label="Saved key help"
                  /></span>
                  <div class="input-row">
                    <CustomSelect v-model="quick.keyRef" placeholder="Select a key…" :options="keyOptions" /><button
                      type="button"
                      class="button button--ghost"
                      :disabled="!canManageKeys"
                      title="Import a private key into strIDEterm and select it for this Built-in SSH connection."
                      @click="appStore.openSshKeyImportDialog(selectKey, 'Back to New tab')"
                    >
                      Import…
                    </button>
                    <button
                      type="button"
                      class="button button--ghost"
                      :disabled="!canManageKeys"
                      title="Generate a private key in strIDEterm and select it for this Built-in SSH connection."
                      @click="appStore.openSshKeyGenerateDialog(selectKey, 'Back to New tab')"
                    >
                      Generate…
                    </button>
                    <button
                      v-if="!transferOpen"
                      type="button"
                      class="button button--ghost"
                      :disabled="!canTransferSelectedKey"
                      :title="
                        transferDisabledReason || 'Add this key to the remote account for the host currently entered.'
                      "
                      @click="openKeyTransfer"
                    >
                      Transfer public key…
                    </button>
                  </div>
                  <p class="field-help">
                    Sends only the public key; the private key stays here. The server password may be requested once.
                    This does not save the host.
                  </p>
                </div>
                <p v-if="quickMode !== 'ssh2'" class="system-auth-note">
                  Your SSH configuration controls sign-in. Password and verification prompts appear in the terminal.
                </p>
              </fieldset>
              <SshKeyTransferDialog
                v-if="transferOpen && transferDraft && transferKeyId"
                ref="keyTransferDialog"
                :key-id="transferKeyId"
                :profile-id="appStore.myActiveProfileId || 'default'"
                :draft="transferDraft"
                inline
                @cancel="transferOpen = false"
              />

              <details class="quick-advanced">
                <summary title="Set an SSH port override or choose a WSL distribution.">
                  Advanced connection options
                </summary>
                <label class="field"
                  ><span
                    >Port
                    <HelpTooltip
                      :text="
                        quickMode === 'ssh2'
                          ? 'Leave this blank to use the standard port 22. Enter a different number to connect to a nonstandard SSH port.'
                          : 'Leave this blank to use the port from your SSH configuration. Enter a number to override it; entering 22 explicitly replaces a different configured port.'
                      "
                      label="Port help" /></span
                  ><input
                    v-model.number="quick.port"
                    type="number"
                    min="1"
                    max="65535"
                    placeholder="Use SSH configuration"
                /></label>
                <label v-if="quick.launchVia === 'wsl'" class="field"
                  ><span
                    >WSL distribution
                    <HelpTooltip
                      text="Choose the WSL Linux environment that contains the SSH config, keys and agent for this connection. Blank uses the saved app default distribution, then the Windows default if no app default is set. Different distributions keep separate files and installed software."
                      label="WSL distribution help" /></span
                  ><CustomSelect v-model="quick.wslDistro" :options="wslDistroOptions"
                /></label>
              </details>

              <div class="save-row">
                <label
                  class="save-row__toggle"
                  title="Save these connection details to the SSH host book so you can select them again later."
                >
                  <input
                    v-model="saveToBook"
                    type="checkbox"
                    :disabled="appStore.isRemoteTransport || capabilities?.permissions?.canManageHosts === false"
                  />
                  <span>Save to host book</span>
                </label>
                <input
                  v-model="savedHostName"
                  class="save-row__input"
                  placeholder="e.g. prod-bastion"
                  title="Name used to find this connection in the saved host list."
                  :disabled="!saveToBook"
                  maxlength="60"
                />
              </div>
              <p v-if="quick.error" class="error-msg">{{ quick.error }}</p>
              <div class="quick-connection-test">
                <button
                  type="button"
                  class="button button--ghost"
                  :disabled="submitting || transferBusy || !canTestSsh"
                  :title="
                    canTestSsh
                      ? 'Open a connection test with these settings. No host will be saved.'
                      : testSshDisabledReason
                  "
                  @click="openQuickConnectionTest"
                >
                  Test connection
                </button>
                <span v-if="!canTestSsh" class="field-help">{{ testSshDisabledReason }}</span>
              </div>
            </template>

            <label class="field">
              <span
                >Initial command (optional)
                <HelpTooltip
                  :text="
                    quickMode === 'ssh2'
                      ? 'Runs on the server right after sign-in: it is typed into the terminal, so interactive programs such as claude or tmux work. It replaces the startup command of a saved host. Leave it blank for a normal shell.'
                      : 'Runs on the server right after sign-in and replaces the startup command of a saved host. A terminal is requested, so interactive programs such as claude or tmux work. Leave it blank for a normal shell; a one-shot command such as hostname prints its output and ends the session.'
                  "
                  label="Initial command help"
              /></span>
              <input
                v-model="commandInput"
                :placeholder="quickMode === 'ssh2' ? 'e.g. tmux attach' : 'e.g. hostname'"
                maxlength="500"
              />
            </label>
          </template>

          <template v-else>
            <label class="run-wsl-toggle">
              <input v-model="runInWsl" type="checkbox" />
              <span>Run in WSL</span>
            </label>
            <div v-if="runInWsl && !isRawWslCommand" class="advanced-fields">
              <label class="field">
                <span>Distro (optional)</span>
                <input v-model="wsl.distro" placeholder="e.g. Ubuntu-22.04 — leave blank for default" maxlength="60" />
              </label>
              <label class="field">
                <span>Working directory (optional)</span>
                <input v-model="wsl.cwd" placeholder="/home/you" maxlength="500" />
              </label>
              <label class="wsl-keep-open">
                <input v-model="wsl.keepOpen" type="checkbox" />
                <span>Keep shell open after the command exits</span>
              </label>
            </div>
          </template>

          <label v-if="showSshToolsOption" class="ssh-tools-toggle">
            <input v-model="sshMcpEnabled" type="checkbox" :disabled="!canEnableSshTools && !sshMcpEnabled" />
            <span>
              SSH tools for this tab
              <HelpTooltip
                text="Enable SSH tools for Claude Code or Codex launched as this tab's direct command. They can run commands on saved Built-in SSH hosts only; other tabs and manually launched agents are unaffected. Applies when the terminal starts. Restart the terminal after changing this setting. Not available for WSL or remote sessions."
                label="SSH tools for this tab help"
              />
              <small class="ssh-tools-toggle__summary">{{ sshToolsHint }}</small>
            </span>
          </label>
        </div>
      </component>

      <p v-if="connectionError" class="error-msg" role="alert">{{ connectionError }}</p>
      <footer class="dialog__footer edit-tab-dialog__footer">
        <button
          type="button"
          class="button button--ghost"
          title="Close this dialog. Unsaved tab changes will be confirmed first."
          :disabled="submitting"
          @click="requestClose"
        >
          Cancel
        </button>
        <button
          type="submit"
          class="button"
          :title="
            mode === 'new'
              ? 'Create a tab with this name and command.'
              : 'Save this tab name, command, and SSH tools setting.'
          "
          :disabled="submitting || transferBusy"
        >
          {{ submitting ? "Saving…" : mode === "new" ? "Create tab" : "Save" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import CustomSelect from "../common/CustomSelect.vue";
import { BADGE_ICONS, getTitleIcon, setTitleIcon } from "../../lib/badge-icons.js";
import { buildWslCommand, parseWslCommand, type WslState } from "./wsl-launcher.js";
import HelpTooltip from "../common/HelpTooltip.vue";
import SshConnectionIdentityFields from "../ssh/SshConnectionIdentityFields.vue";
import SshKeyTransferDialog from "../ssh/SshKeyTransferDialog.vue";
import type { SshKeyTransferStart } from "../../../electron/backend/ipc-schemas.js";
import { resolveSshLaunchVia } from "../../../electron/shared/ssh-connection.js";
import { validateSshConnectionIdentity } from "../../lib/ssh-connection-form.js";
import { sshAuthenticationHelp, sshDefaultMethodHelp } from "../../lib/ssh-help-text.js";
import { getAgentSshMcpEligibility } from "../../../electron/shared/agent-ssh.js";

interface SshHostState {
  title: string;
  command: string;
  sshMode: string;
  sshHostId: string;
}

interface Props {
  eyebrow?: string;
  title?: string;
  command?: string;
  mode?: string;
  presetTabType?: string;
  presetSshMode?: string;
  presetSshHostId?: string;
  cwdOverride?: string;
  sshMcpEnabled?: boolean;
  hasCustomLaunch?: boolean;
  /** Edit mode for a tab that launches an SSH host: only title/icon/command apply. */
  sshTab?: boolean;
  onEditSshHost?: ((host: unknown, state: SshHostState) => void) | null;
}

const props = withDefaults(defineProps<Props>(), {
  eyebrow: "Workspace",
  title: "",
  command: "",
  mode: "edit",
  presetTabType: "local",
  presetSshMode: "saved",
  presetSshHostId: "",
  cwdOverride: "",
  sshMcpEnabled: false,
  hasCustomLaunch: false,
  sshTab: false,
  onEditSshHost: null,
});

const emit = defineEmits<{
  cancel: [];
  submit: [payload: unknown];
}>();

const sshStore = useSshStore();
const appStore = useAppStore();
const sshRuntime = useSshStore();
const sshHosts = computed(() => sshStore.hosts || []);
const sshKeys = computed(() => sshStore.keys || []);

const hostOptions = computed(() =>
  sshHosts.value.map((h) => ({ value: h.id, label: `${h.name ?? h.host} (${h.host})` })),
);

const authMethodOptions = computed(() => [
  {
    value: "agent",
    label: `SSH Agent${capabilities.value && !capabilities.value.openSshAgent ? " · unavailable" : " (recommended)"}`,
    disabled: capabilities.value ? !capabilities.value.openSshAgent : false,
  },
  {
    value: "publickey",
    label: `Saved key${sshKeys.value.length === 0 ? " — import or generate one" : ""}`,
  },
  { value: "keyboard-interactive", label: "Password / prompt (MFA)" },
]);

const keyOptions = computed(() => sshKeys.value.map((k) => ({ value: k.id, label: k.label })));
const storedDefault = computed(() =>
  String(appStore.payload?.appState?.settings?.ssh?.defaultLaunchVia || "system-ssh"),
);
const quickMode = computed(() => resolveSshLaunchVia(quick.launchVia, storedDefault.value));
const capabilities = computed(() => sshRuntime.capabilities);
const launchViaOptions = computed(() => {
  const options = [
    { value: "default", label: `Use app default · ${quickLabel(storedDefault.value)}` },
    { value: "ssh2", label: "Built-in SSH (recommended)" },
    {
      value: "system-ssh",
      label: `SSH on this computer${capabilities.value && !capabilities.value.systemSsh ? " · unavailable" : ""}`,
      disabled: capabilities.value ? !capabilities.value.systemSsh : false,
    },
  ];
  if (capabilities.value?.platform === "win32")
    options.push({
      value: "wsl",
      label: `SSH in WSL${capabilities.value.wsl?.installed ? "" : " · unavailable"}`,
      disabled: !capabilities.value.wsl?.installed,
    });
  return options;
});
const wslDistroOptions = computed(() => [
  { value: "", label: "Default distribution" },
  ...(capabilities.value?.wsl?.distros || []).map((distro: string) => ({ value: distro, label: distro })),
]);
const connectionMethodHelp = sshDefaultMethodHelp;
const connectionError = ref("");
const sshMcpEnabled = ref(Boolean(props.sshMcpEnabled));
const agentSshEligibility = computed(() => getAgentSshMcpEligibility(commandInput.value));

function editSelectedHost() {
  const host = sshHosts.value.find((h) => h.id === selectedSshHostId.value);
  if (!host) return;
  // When the new-tab dialog supplied an onEditSshHost hook, let it coordinate
  // the swap + return flow so the user lands back on the new-tab dialog after
  // saving. Fallback (e.g. in edit-mode) is the one-shot open without return.
  if (props.onEditSshHost) {
    props.onEditSshHost(host, {
      title: titleInput.value,
      command: commandInput.value,
      sshMode: sshMode.value,
      sshHostId: selectedSshHostId.value,
    });
    return;
  }
  appStore.openSshHostEditor(host);
}

const titleRef = ref<HTMLInputElement | null>(null);
const titleInput = ref(props.title);
const commandInput = ref(props.command);
const showIconPicker = ref(false);
const submitting = ref(false);
const confirmingDiscard = ref(false);
const tabType = ref(props.presetTabType === "ssh" ? "ssh" : "local");
const advancedOpen = ref(props.mode !== "new" || props.presetTabType === "ssh");
const parsedWslPreset = props.presetTabType !== "ssh" && !props.sshTab ? parseWslCommand(props.command) : null;
const rawWslPreset =
  props.presetTabType !== "ssh" && !props.sshTab && !parsedWslPreset && /^wsl(?:\s|$)/i.test(props.command.trim());
const runInWsl = ref(props.presetTabType !== "ssh" && !props.sshTab && Boolean(parsedWslPreset || rawWslPreset));
const wsl = reactive<WslState>(parsedWslPreset ?? { distro: "", cwd: "", command: "", keepOpen: true });
if (parsedWslPreset) commandInput.value = parsedWslPreset.command;
const isRawWslCommand = computed(() => /^wsl(?:\s|$)/i.test(commandInput.value.trim()));
function onAdvancedToggle(event: Event) {
  advancedOpen.value = (event.currentTarget as HTMLDetailsElement).open;
}

function quickLabel(mode: string) {
  return mode === "system-ssh" ? "SSH on this computer" : mode === "wsl" ? "SSH in WSL" : "Built-in SSH";
}

const sshMode = ref(props.presetSshMode === "quick" ? "quick" : "saved");
const selectedSshHostId = ref(props.presetSshHostId || "");
const advancedSummary = computed(() => {
  if (tabType.value === "ssh") return "SSH";
  return runInWsl.value ? "WSL" : "";
});

const quick = reactive({
  host: "",
  port: undefined as number | undefined,
  username: "",
  launchVia: "default",
  wslDistro: "",
  authMethod: "agent",
  keyRef: "",
  error: "",
});
const canTestSsh = computed(
  () => !appStore.isRemoteTransport && capabilities.value?.permissions?.canManageHosts !== false,
);
const testSshDisabledReason = computed(
  () =>
    capabilities.value?.permissions?.reason ||
    (appStore.isRemoteTransport
      ? "Connection testing is available in the desktop app."
      : "Connection testing is unavailable."),
);

const canManageKeys = computed(
  () => !appStore.isRemoteTransport && capabilities.value?.permissions?.canManageHosts !== false,
);
const transferOpen = ref(false);
const keyTransferDialog = ref<{
  requestClose?: () => Promise<boolean>;
  isBusy?: () => boolean;
  $el?: HTMLElement;
} | null>(null);
const transferDraft = ref<NonNullable<SshKeyTransferStart["draft"]> | null>(null);
const transferKeyId = ref("");
const transferBusy = computed(
  () => transferOpen.value && (!keyTransferDialog.value || Boolean(keyTransferDialog.value.isBusy?.())),
);
const selectedManagedKey = computed(() => sshKeys.value.find((key) => key.id === quick.keyRef) || null);
const transferDisabledReason = computed(() => {
  if (!quick.host.trim()) return "Enter the server address or SSH alias first.";
  if (!quick.username.trim()) return "Enter the remote username before transferring a key.";
  if (!selectedManagedKey.value) return "Select or generate a key stored in strIDEterm first.";
  if (!selectedManagedKey.value.publicKey?.trim()) return "The selected key has no public-key data to transfer.";
  if (appStore.isRemoteTransport) return "Public-key transfer is available in the desktop app only.";
  return "";
});
const canTransferSelectedKey = computed(() => !transferDisabledReason.value);

function selectKey(result: unknown) {
  const record =
    result && typeof result === "object" ? (result as { key?: { id?: string }; id?: string; keyId?: string }) : {};
  const keyId = record.key?.id || record.id || record.keyId;
  if (keyId) {
    authTouched.value = true;
    quick.keyRef = keyId;
    quick.authMethod = "publickey";
  }
}

function openKeyTransfer() {
  if (!canTransferSelectedKey.value || !selectedManagedKey.value) return;
  transferDraft.value = buildInlineHost() as NonNullable<SshKeyTransferStart["draft"]>;
  transferKeyId.value = selectedManagedKey.value.id;
  transferOpen.value = true;
  void nextTick(() => {
    const element = keyTransferDialog.value?.$el;
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}

// Closes the inline transfer panel (it may confirm an abort). False means it stayed open.
async function closeTransferSetup(): Promise<boolean> {
  if (!transferOpen.value) return true;
  const close = keyTransferDialog.value?.requestClose;
  if (!close) return false;
  const closed = await close();
  return closed && !transferOpen.value;
}

const saveToBook = ref(false);
const savedHostName = ref("");
function currentDraft() {
  return JSON.stringify({
    titleInput: titleInput.value,
    commandInput: commandInput.value,
    tabType: tabType.value,
    runInWsl: runInWsl.value,
    wsl,
    sshMode: sshMode.value,
    selectedSshHostId: selectedSshHostId.value,
    quick,
    saveToBook: saveToBook.value,
    savedHostName: savedHostName.value,
    sshMcpEnabled: sshMcpEnabled.value,
  });
}
const initialDraft = ref("");
async function requestClose() {
  if (submitting.value || confirmingDiscard.value) return;
  if (!(await closeTransferSetup())) return;
  if (currentDraft() !== initialDraft.value) {
    confirmingDiscard.value = true;
    try {
      const discard = await appStore.confirmInApp({
        title: "Discard unsaved tab changes?",
        message: "Your tab details have not been saved.",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (!discard) return;
    } finally {
      confirmingDiscard.value = false;
    }
  }
  emit("cancel");
}
defineExpose({ requestClose });

// The command survives the switch: "Claude Code" then SSH means run claude on that host.
watch(tabType, (next, prev) => {
  if (next === prev) return;
  if (next === "ssh") {
    if (sshHosts.value.length === 0) sshMode.value = "quick";
    else if (!selectedSshHostId.value) {
      selectedSshHostId.value = sshHosts.value[0].id;
      onHostSelected();
    }
  } else if (!titleInput.value) {
    titleInput.value = "Shell";
  }
});

function onHostSelected() {
  const host = sshHosts.value.find((h) => h.id === selectedSshHostId.value);
  if (host && isDefaultTitle()) titleInput.value = `\u{1F310} ${host.name ?? host.host}`;
}

// A title is the dialog's own default (empty, "Shell", or one derived from a host) until the user
// or a tab template set something else; only a default one follows the chosen host.
function isDefaultTitle() {
  const trimmed = titleInput.value.trim();
  return ["", "Shell", "\u{1F4BB} Shell", "\u{1F310}"].includes(trimmed) || /^\u{1F310}\s/u.test(trimmed);
}

function autofillTitle() {
  if (isDefaultTitle() && quick.host.trim()) {
    titleInput.value = `\u{1F310} ${quick.username || ""}@${quick.host}`.trim();
  }
}

const currentIcon = computed(() => getTitleIcon(titleInput.value));
const showSshToolsOption = computed(() => !appStore.isRemoteTransport && tabType.value === "local");
const canEnableSshTools = computed(
  () => showSshToolsOption.value && !props.hasCustomLaunch && !runInWsl.value && agentSshEligibility.value.supported,
);
const sshToolsHint = computed(() => {
  if (runInWsl.value) return "Available for local Claude Code / Codex tabs; WSL is not supported yet.";
  if (props.hasCustomLaunch) return "Custom launch settings are not supported. Use the tab's direct Command field.";
  if (!agentSshEligibility.value.supported) return "Set Command to claude or codex to enable SSH tools.";
  return "Built-in SSH only. Enabled when this terminal starts.";
});

function pickIcon(icon: string) {
  titleInput.value = setTitleIcon(titleInput.value, icon);
  showIconPicker.value = false;
}

// Without a usable SSH agent the useful default is a saved key. Switch only
// while the user has not chosen an auth method themselves.
const authTouched = ref(false);
function applyAuthDefault() {
  if (authTouched.value || quick.authMethod !== "agent" || capabilities.value?.openSshAgent !== false) return;
  const untouched = currentDraft() === initialDraft.value;
  quick.authMethod = "publickey";
  if (untouched) initialDraft.value = currentDraft();
}
watch(capabilities, applyAuthDefault);

onMounted(async () => {
  initialDraft.value = currentDraft();
  if (sshHosts.value.length === 0) await sshStore.load();
  const untouched = currentDraft() === initialDraft.value;
  if (untouched && tabType.value === "ssh") {
    if (sshHosts.value.length === 0) sshMode.value = "quick";
    else if (!selectedSshHostId.value) {
      selectedSshHostId.value = sshHosts.value[0].id;
      onHostSelected();
    }
  }
  if (untouched) initialDraft.value = currentDraft();
  applyAuthDefault();
  requestAnimationFrame(() => {
    titleRef.value?.focus();
    titleRef.value?.select();
  });
});

function buildInlineHost(): Record<string, unknown> {
  const advanced: Record<string, unknown> = {
    launchVia: quick.launchVia,
    ...(quick.port !== undefined ? { portOverride: true } : {}),
  };
  const host: Record<string, unknown> = {
    host: quick.host.trim(),
    advanced,
  };
  if (quick.port !== undefined) host.port = Number(quick.port);
  if (quick.username.trim()) host.username = quick.username.trim();
  if (quickMode.value === "ssh2") {
    const methods = quick.authMethod === "publickey" ? ["publickey"] : [quick.authMethod];
    host.auth = { methods, ...(quick.authMethod === "publickey" ? { keyRef: quick.keyRef } : {}) };
  }
  if (quick.launchVia === "wsl") advanced.wsl = { distro: quick.wslDistro || null };
  return host;
}

async function openQuickConnectionTest() {
  if (submitting.value || !canTestSsh.value) return;
  if (!(await closeTransferSetup())) return;
  quick.error = "";
  const identityError = validateSshConnectionIdentity({
    host: quick.host,
    username: quick.username,
    requireUsername: quickMode.value === "ssh2",
    port: quick.port,
  });
  if (identityError) {
    quick.error = identityError;
    return;
  }
  if (quickMode.value === "ssh2" && quick.authMethod === "publickey") {
    if (!quick.keyRef || !sshKeys.value.some((key) => key.id === quick.keyRef)) {
      quick.error = "Select an available saved key or change authentication.";
      return;
    }
  }
  if (quickMode.value === "system-ssh" && capabilities.value && !capabilities.value.systemSsh) {
    quick.error = "System SSH was not found on the computer running strIDEterm.";
    return;
  }
  if (quickMode.value === "wsl" && capabilities.value && !capabilities.value.wsl?.installed) {
    quick.error = "WSL is not available on the computer running strIDEterm.";
    return;
  }
  const draft = buildInlineHost();
  // Connection tests use identity/authentication settings only. The separate
  // New Tab command is never included in the temporary connection request.
  appStore.openSubDialog("SshConnectionTestDialog", {
    profileId: appStore.myActiveProfileId || "default",
    draft,
    onCancel: appStore.backDialog,
  });
}

function canConnectHere(): boolean {
  const workspace = appStore.activeWorkspace as { kind: string; profileId?: string } | null;
  if (!workspace || !["terminal", "task"].includes(workspace.kind)) return false;
  if ((workspace.profileId || "default") !== (appStore.myActiveProfileId || "default")) return false;
  return true;
}

async function createSshTab(title: string, host: Record<string, unknown>, hostId?: string) {
  if (!canConnectHere()) {
    connectionError.value = "Choose a terminal workspace in the active profile before connecting.";
    return false;
  }
  await appStore.quickAddTemplateTab(commandInput.value.trim(), title, props.cwdOverride, {
    kind: "ssh",
    ...(hostId ? { sshHostId: hostId } : { sshInline: host }),
  });
  emit("cancel");
  return true;
}

async function handleSubmit() {
  const nextTitle = titleInput.value.trim();
  if (!nextTitle) return;
  if (!(await closeTransferSetup())) return;
  connectionError.value = "";

  // Classic local shell or saved SSH host — simple payload.
  if (tabType.value !== "ssh" || sshMode.value === "saved") {
    // CustomSelect has no native `required`, so guard the saved-host path
    // explicitly — we don't want to submit a saved-host tab with no host id.
    if (tabType.value === "ssh" && sshMode.value === "saved" && !selectedSshHostId.value) return;
    const plainCommand = commandInput.value.trim();
    const effectiveCommand =
      tabType.value === "local" && runInWsl.value
        ? isRawWslCommand.value
          ? plainCommand
          : buildWslCommand({ ...wsl, command: plainCommand }) || 'wsl -- bash -lic "exec bash"'
        : plainCommand;
    if (props.mode === "new" && tabType.value === "ssh") {
      submitting.value = true;
      try {
        await createSshTab(nextTitle, {}, selectedSshHostId.value);
      } catch (err) {
        connectionError.value = (err as Error).message || "Failed to create SSH tab.";
      } finally {
        submitting.value = false;
      }
      return;
    }
    if (sshMcpEnabled.value && showSshToolsOption.value && !canEnableSshTools.value) {
      connectionError.value =
        "SSH tools require a direct local Claude Code or Codex command. Turn off SSH tools or change Command.";
      return;
    }
    emit("submit", {
      title: nextTitle,
      command: effectiveCommand,
      kind: tabType.value === "ssh" ? "ssh" : undefined,
      sshHostId: tabType.value === "ssh" ? selectedSshHostId.value : undefined,
      sshMcpEnabled:
        tabType.value !== "local" ? false : appStore.isRemoteTransport ? props.sshMcpEnabled : sshMcpEnabled.value,
    });
    return;
  }

  // Quick-connect path. Validate minimally; the backend schema is the source
  // of truth but we want a useful inline error before round-tripping.
  quick.error = "";
  const identityError = validateSshConnectionIdentity({
    host: quick.host,
    username: quick.username,
    requireUsername: quickMode.value === "ssh2",
    port: quick.port,
  });
  if (identityError) {
    quick.error = identityError;
    return;
  }
  if (quickMode.value === "ssh2" && quick.authMethod === "publickey" && !quick.keyRef) {
    quick.error = "Select a key, or import or generate one.";
    return;
  }
  if (
    quickMode.value === "ssh2" &&
    quick.authMethod === "publickey" &&
    !sshKeys.value.some((key) => key.id === quick.keyRef)
  ) {
    quick.error = "The selected key is no longer available.";
    return;
  }
  if (quickMode.value === "wsl" && capabilities.value && !capabilities.value.wsl?.installed) {
    quick.error = "WSL is not available on the computer running strIDEterm.";
    return;
  }
  if (quickMode.value === "system-ssh" && capabilities.value && !capabilities.value.systemSsh) {
    quick.error = "System SSH was not found on the computer running strIDEterm. Install it or choose Built-in SSH.";
    return;
  }
  if (
    quickMode.value === "ssh2" &&
    quick.authMethod === "agent" &&
    capabilities.value &&
    !capabilities.value.openSshAgent
  ) {
    quick.error =
      "No supported SSH agent was found. Choose a saved key or password prompt, or configure an agent in Settings.";
    return;
  }
  const selectedDistro = quick.wslDistro || capabilities.value?.wsl?.default || "";
  if (
    quickMode.value === "wsl" &&
    selectedDistro &&
    capabilities.value?.wsl?.sshAvailableByDistro?.[selectedDistro] === false
  ) {
    quick.error = `SSH is not installed in WSL distribution ${selectedDistro}.`;
    return;
  }
  if (!canConnectHere()) {
    quick.error = "Choose a terminal workspace in the active profile before connecting.";
    return;
  }

  submitting.value = true;
  try {
    // "Save to host book" promotes the ad-hoc config to a saved host first,
    // then the panel just references it by id. Declined: inline sticks on
    // the panel and dies when the tab is removed.
    if (saveToBook.value) {
      const name = savedHostName.value.trim() || `${quick.username ? `${quick.username}@` : ""}${quick.host}`;
      const inline = buildInlineHost();
      const newHost = {
        name,
        host: inline.host,
        port: inline.port,
        username: inline.username,
        auth: inline.auth,
        jump: [],
        advanced: inline.advanced,
        tags: [],
      };
      if (appStore.isRemoteTransport || capabilities.value?.permissions?.canManageHosts === false) {
        quick.error = capabilities.value?.permissions?.reason || "Saving SSH hosts is available on the desktop app.";
        return;
      }
      const saved = (await sshStore.saveHost(newHost as unknown as Parameters<typeof sshStore.saveHost>[0])) as {
        id?: string;
      } | null;
      if (!saved) {
        quick.error = "Failed to save host to book.";
        return;
      }
      await createSshTab(nextTitle, {}, saved.id);
      return;
    }

    await createSshTab(nextTitle, buildInlineHost());
  } catch (err) {
    quick.error = (err as Error).message || "Failed to create tab";
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.edit-tab-dialog {
  width: min(520px, 100%);
  min-width: 0;
  max-width: 100%;
}
.edit-tab-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.new-tab-kind {
  display: flex;
  gap: 6px;
  margin: 0 0 12px;
  flex-shrink: 0;
}
.new-tab-kind .segmented__btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  white-space: nowrap;
}
.new-tab-kind svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ssh-tools-toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}
.ssh-tools-toggle input {
  flex: 0 0 auto;
  margin: 2px 0 0;
}
.ssh-tools-toggle > span {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}
.ssh-tools-toggle__summary {
  flex-basis: 100%;
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: normal;
  text-transform: none;
}
.input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.system-auth-note {
  margin: 0;
  padding: 9px;
  border-left: 3px solid var(--accent);
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
}
.quick-advanced {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.quick-advanced summary {
  padding: 6px 0;
  cursor: pointer;
}
.quick-advanced .field {
  margin-top: 10px;
}

.advanced-options {
  border-top: 1px solid var(--border);
}
.advanced-options > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}
.advanced-options > summary::-webkit-details-marker {
  display: none;
}
.advanced-options > summary::after {
  content: "▸";
  margin-left: auto;
  color: var(--muted);
  transition: transform 0.15s ease;
}
.advanced-options[open] > summary::after {
  transform: rotate(90deg);
}
.advanced-options__summary {
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.advanced-options__control {
  margin-bottom: 0;
}
.advanced-content {
  display: grid;
  gap: 16px;
  padding-bottom: 14px;
  min-width: 0;
}
.advanced-fields {
  display: grid;
  gap: 16px;
}

/* Segmented control — replaces ugly radio rows for binary toggles.
   Overrides the global `label { display: grid }` by using plain <button>s. */
.segmented {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
}
.segmented__btn {
  flex: 1;
  padding: 8px 14px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.12s,
    color 0.12s;
}
.segmented__btn:hover:not(:disabled):not(.segmented__btn--active) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}
.segmented__btn--active {
  background: var(--accent);
  color: #000;
}
.segmented__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Fields — standard label + input pair (overlay.css already grids them). */
.field {
  margin: 0;
}
.auth-field {
  display: grid;
  gap: 4px;
  position: relative;
}
.auth-field__heading {
  display: flex;
  align-items: center;
  gap: 6px;
}
.auth-field__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
}
.auth-help {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--muted);
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.auth-help:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.auth-help__content {
  position: absolute;
  z-index: 2;
  bottom: calc(100% + 8px);
  left: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  font-size: 12px;
  line-height: 1.45;
}
.auth-help__content::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 10px;
}
.auth-help__content p {
  margin: 0;
}
.auth-help__content p + p {
  margin-top: 12px;
}
.run-wsl-toggle,
.wsl-keep-open {
  display: flex !important;
  align-items: center;
  gap: 8px;
  margin: 0;
  cursor: pointer;
}
.run-wsl-toggle input[type="checkbox"],
.wsl-keep-open input[type="checkbox"] {
  width: auto;
  margin: 0;
  accent-color: var(--accent);
}
.run-wsl-toggle span,
.wsl-keep-open span {
  color: var(--text);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: normal;
  text-transform: none;
}
.auth-help__content strong {
  color: var(--text);
}

.title-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
.icon-btn {
  width: 40px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  font-size: 16px;
  padding: 0;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
.title-input {
  flex: 1;
  min-width: 0;
}
.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px;
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  max-height: 160px;
  overflow-y: auto;
}
.icon-picker__btn {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 15px;
  padding: 0;
}
.icon-picker__btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--border);
}

/* Saved-host: label stands alone on top (like a caption), then a flex row
   holds the dropdown and the Edit button side-by-side with matching heights. */
.saved-host-field__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  margin-bottom: 4px;
}
.saved-host-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.saved-host-row__select {
  flex: 1;
  min-width: 0;
}
.saved-host-row__edit {
  flex-shrink: 0;
  white-space: nowrap;
}

/* Quick-connect keeps host and username together, with method below. */
.quick-fields {
  display: grid;
  gap: 16px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.quick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-width: 0;
}
.quick-grid > .field {
  grid-column: 1 / -1;
}
.quick-grid :deep(.field),
.quick-grid :deep(input),
.quick-grid :deep(.custom-select),
.quick-grid :deep(.custom-select__button) {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
}
.quick-grid :deep(.field > span) {
  min-width: 0;
  overflow-wrap: anywhere;
}
.quick-grid :deep(.custom-select) {
  width: 100%;
}
.quick-connection-test {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.quick-connection-test .field-help {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* Save-row: checkbox toggle on the left, name input expanding to the right. */
.save-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 6px 0 14px;
  min-width: 0;
}
.save-row__toggle {
  display: flex !important;
  align-items: center;
  gap: 8px;
  margin: 0;
  cursor: pointer;
  white-space: nowrap;
}
.save-row__toggle input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.save-row__toggle span {
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text);
  font-weight: 500;
}
.save-row__input {
  flex: 1 1 11rem;
  min-width: 0;
}
.save-row__input:disabled {
  opacity: 0.5;
}

.error-msg {
  color: #ff6b6b;
  font-size: 13px;
  margin: 0;
}

.edit-tab-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

@media (max-width: 560px) {
  .edit-tab-dialog__form {
    gap: 12px;
  }
  .segmented__btn {
    padding: 10px 8px;
    white-space: normal;
  }
  .quick-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .quick-grid > .field {
    grid-column: auto;
  }
  .save-row {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .save-row__input {
    flex: 0 0 auto;
    width: 100%;
  }
  .new-tab-kind {
    flex-wrap: wrap;
  }
  .advanced-options > summary {
    min-height: 48px;
  }
}

/* The global `input { width: 100% }` from overlay.css is way too broad —
   checkboxes and radios should never stretch. This scoped override prevents
   the "giant radio circle" effect seen in the old radio-row design. */
:deep(input[type="checkbox"]),
:deep(input[type="radio"]) {
  width: auto;
  padding: 0;
}
</style>
