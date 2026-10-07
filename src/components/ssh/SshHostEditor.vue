<template>
  <div :class="embedded ? 'dialog ssh-host-editor ssh-host-editor--embedded' : 'dialog ssh-host-editor'">
    <header class="dialog__header">
      <div class="ssh-host-editor__heading">
        <p v-if="!embedded" class="eyebrow">SSH</p>
        <h2>{{ isNew ? "Add host" : "Edit host" }}</h2>
      </div>
      <div v-if="embedded" class="ssh-host-editor__heading-actions">
        <button
          type="button"
          class="button button--ghost"
          title="Return to SSH host management. Unsaved host changes will be confirmed first."
          :disabled="busy"
          @click="requestClose"
        >
          Back
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="busy || transferBusy || !canTest"
          :title="
            canTest
              ? 'Test sign-in using the host details currently entered. This does not save the host.'
              : testDisabledReason
          "
          @click="openConnectionTest"
        >
          Test connection
        </button>
        <button
          type="button"
          class="button"
          title="Save this SSH host to the shared host book."
          :disabled="busy || transferBusy"
          @click="save"
        >
          {{ busy ? "Saving…" : "Save host" }}
        </button>
      </div>
    </header>

    <div class="ssh-host-editor__content">
      <fieldset class="form-group ssh-host-editor__fields" :disabled="transferOpen">
        <SshConnectionIdentityFields
          :host="form.host"
          :username="form.username || ''"
          :require-username="effectiveMode === 'ssh2'"
          @update:host="form.host = $event"
          @update:username="updateUsername"
          @host-input="suggestName"
        />
        <div class="field">
          <label>Display name</label>
          <input
            v-model.trim="form.name"
            class="input"
            placeholder="Defaults to host or alias"
            title="Follows username@host, or the host when username is blank, until you enter your own name."
            @input="markNameEdited"
          />
        </div>
        <div class="field">
          <label>Connection method <HelpTooltip :text="help.method" label="Connection method help" /></label>
          <CustomSelect v-model="form.advanced.launchVia" :options="launchViaOptions" />
          <p class="field-help">{{ methodSummary }}</p>
          <p v-if="form.advanced.launchVia === 'default'" class="field-help">
            This host uses the saved app default ({{ modeLabel(effectiveMode) }}). Settings changes apply to the next
            connection.
          </p>
        </div>

        <template v-if="effectiveMode === 'ssh2'">
          <div class="field">
            <label>Authentication <HelpTooltip :text="help.auth" label="Authentication help" /></label>
            <CustomSelect v-model="simpleAuth" :options="authOptions" />
          </div>
          <div v-if="form.auth.methods.includes('publickey')" class="field">
            <label>Key stored in strIDEterm <HelpTooltip :text="help.key" label="Saved key help" /></label>
            <div class="input-row">
              <CustomSelect v-model="form.auth.keyRef" :options="keyOptions" placeholder="Select a key…" />
              <button
                type="button"
                class="button button--ghost"
                title="Import a private key into strIDEterm and select it for this host."
                @click="openKeyImport()"
              >
                Import…
              </button>
              <button
                type="button"
                class="button button--ghost"
                title="Generate a private key in strIDEterm and select it for this host."
                @click="openKeyGenerate()"
              >
                Generate…
              </button>
              <button
                v-if="!transferOpen"
                type="button"
                class="button button--ghost"
                :disabled="!canTransferSelectedKey"
                :title="transferDisabledReason || 'Add this key to the remote account for the host currently entered.'"
                @click="openKeyTransfer"
              >
                Transfer public key…
              </button>
            </div>
            <div class="ssh-host-editor__key-transfer-setup">
              <p class="field-help">
                Sends only the public key; the private key stays here. The server password may be requested once. This
                does not save the host.
              </p>
            </div>
            <p v-if="!ssh.keys.length" class="field-help">
              No app keys yet. Import or generate one, then add its public key to the server.
            </p>
          </div>
        </template>
      </fieldset>
      <SshKeyTransferDialog
        v-if="transferOpen && transferDraft && transferKeyId"
        ref="keyTransferDialog"
        :key-id="transferKeyId"
        :profile-id="store.myActiveProfileId || 'default'"
        :draft="transferDraft"
        inline
        @cancel="transferOpen = false"
      />
      <fieldset class="form-group ssh-host-editor__fields" :disabled="transferOpen">
        <template v-if="effectiveMode === 'ssh2'">
          <div v-if="form.auth.certRef" class="field cert-limitation" role="alert">
            <strong>This host has an SSH certificate attached.</strong> Built-in SSH does not currently use this
            certificate.
            <span
              >System SSH or WSL will use a certificate only when that environment's OpenSSH config associates it with
              the matching key. Importing certificate details here does not configure OpenSSH.</span
            >
            <button type="button" class="button button--ghost button--small" @click="form.auth.certRef = ''">
              Clear certificate reference
            </button>
          </div>
          <div v-if="form.auth.methods.includes('agent')" class="field">
            <label>Agent source <HelpTooltip :text="help.agent" label="Agent source help" /></label>
            <CustomSelect v-model="agentChoice" :options="agentOptions" />
          </div>
          <p v-if="isCombinedAuth" class="field-help">
            This saved host uses a legacy or combined authentication setup. Its methods are preserved until you change
            them below Advanced authentication.
          </p>
          <details v-if="isCombinedAuth" class="advanced-auth">
            <summary>Advanced authentication</summary>
            <label v-for="method in authMethodCheckboxes" :key="method.value" class="checkbox-label">
              <input v-model="form.auth.methods" type="checkbox" :value="method.value" />
              <span>{{ method.label }}</span>
            </label>
          </details>
        </template>
        <p v-else class="system-auth-note">
          Your SSH configuration controls sign-in. Password and verification prompts appear in the terminal.
        </p>

        <details class="advanced-options">
          <summary>Advanced</summary>
          <div class="form-group advanced-content">
            <div class="field">
              <label>Port <HelpTooltip :text="help.port" label="Port help" /></label>
              <input
                v-model.number="portInput"
                type="number"
                class="input"
                min="1"
                max="65535"
                placeholder="Use SSH configuration"
              />
            </div>
            <div v-if="effectiveMode === 'wsl'" class="field">
              <label>WSL distribution <HelpTooltip :text="help.wslDistro" label="WSL distribution help" /></label>
              <CustomSelect v-if="wslDistros.length" v-model="form.advanced.wsl.distro" :options="wslDistroOptions" />
              <input v-else v-model="form.advanced.wsl.distro" class="input" placeholder="Default distribution" />
              <label class="subfield-label"
                >Linux user <HelpTooltip :text="help.wslUser" label="WSL user help"
              /></label>
              <input v-model="form.advanced.wsl.user" class="input" placeholder="Use WSL default user" />
              <label class="subfield-label"
                >SSH executable inside WSL
                <HelpTooltip :text="help.wslExecutable" label="WSL SSH executable help" />
              </label>
              <input v-model="form.advanced.wsl.exec" class="input" placeholder="ssh or /usr/bin/ssh" />
            </div>
            <div v-else-if="effectiveMode === 'system-ssh'" class="field">
              <label
                >Custom SSH executable <HelpTooltip :text="help.executable" label="Custom SSH executable help"
              /></label>
              <input v-model="form.advanced.sshPath" class="input" placeholder="Use installed ssh" />
            </div>
            <div class="field">
              <label>Tags (comma separated)</label><input v-model="tagsString" class="input" placeholder="prod, web" />
            </div>
            <div class="field">
              <label
                >Keep connection alive (seconds)
                <HelpTooltip :text="help.keepalive" label="Keep connection alive help" /></label
              ><input v-model.number="keepaliveSeconds" type="number" class="input" min="0" />
            </div>
            <div class="field">
              <label>Startup command <HelpTooltip :text="commandHelp" label="Startup command help" /></label
              ><input
                v-model="form.advanced.command"
                class="input"
                :placeholder="effectiveMode === 'ssh2' ? 'e.g. tmux attach' : 'e.g. hostname'"
              />
            </div>
            <label class="checkbox-label risky"
              ><input v-model="form.advanced.agentForward" type="checkbox" /><span
                >Agent forwarding <HelpTooltip :text="help.forward" label="Agent forwarding help" /></span
            ></label>
            <p v-if="form.advanced.agentForward" class="field-help warning">
              Programs on this server can use your local agent to authenticate elsewhere. Enable only for servers you
              trust.
            </p>
            <div class="field">
              <label>Jump hosts <HelpTooltip :text="help.jump" label="Jump hosts help" /></label
              ><input v-model="jumpHostsText" class="input" placeholder="Saved host IDs, separated by commas" />
            </div>
          </div>
        </details>
      </fieldset>
    </div>

    <div v-if="errorMessage" class="dialog__error" role="alert">
      <span class="dialog__error-icon" aria-hidden="true">⚠</span
      ><span class="dialog__error-text">{{ errorMessage }}</span>
    </div>
    <footer class="dialog__footer ssh-host-editor__footer">
      <template v-if="!embedded">
        <button
          type="button"
          class="button button--ghost"
          title="Discard unsaved changes to this SSH host."
          :disabled="busy"
          @click="requestClose"
        >
          Cancel
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="busy || transferBusy || !canTest"
          :title="
            canTest
              ? 'Test sign-in using the host details currently entered. This does not save the host.'
              : testDisabledReason
          "
          @click="openConnectionTest"
        >
          Test connection
        </button>
        <button
          type="button"
          class="button"
          title="Save this SSH host to the shared host book."
          :disabled="busy || transferBusy"
          @click="save"
        >
          {{ busy ? "Saving…" : "Save" }}
        </button>
      </template>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import CustomSelect from "../common/CustomSelect.vue";
import HelpTooltip from "../common/HelpTooltip.vue";
import SshConnectionIdentityFields from "./SshConnectionIdentityFields.vue";
import type { SshHost as BaseSshHost } from "../../../electron/shared/types/ssh.js";
import { resolveSshLaunchVia } from "../../../electron/shared/ssh-connection.js";
import { validateSshConnectionIdentity } from "../../lib/ssh-connection-form.js";
import { sshAuthenticationHelp, sshDefaultMethodHelp } from "../../lib/ssh-help-text.js";
import { useSshPanelNavigation } from "./ssh-panel-navigation.js";
import SshKeyTransferDialog from "./SshKeyTransferDialog.vue";
import type { SshKeyTransferStart } from "../../../electron/backend/ipc-schemas.js";

type SshHost = Omit<
  BaseSshHost,
  "id" | "createdAt" | "updatedAt" | "lastConnectedAt" | "port" | "auth" | "advanced"
> & {
  id?: string;
  name?: string;
  label?: string;
  tags?: string[];
  hostKeyPolicy?: string;
  advanced: Omit<NonNullable<BaseSshHost["advanced"]>, "keepaliveIntervalMs" | "wsl"> & {
    keepaliveIntervalMs?: number | null;
    launchVia?: string;
    portOverride?: boolean;
    command?: string;
    agentForward?: boolean;
    sshPath?: string;
    wsl: { distro?: string | null; user?: string | null; exec?: string };
  };
  auth: { methods: string[]; keyRef?: string; certRef?: string; agent?: string; [key: string]: unknown };
  createdAt?: string;
  updatedAt?: string;
  lastConnectedAt?: string | null;
  port?: number;
  [key: string]: unknown;
};
const props = withDefaults(
  defineProps<{ host?: SshHost | null; backLabel?: string; embedded?: boolean; onSaved?: (_host: SshHost) => void }>(),
  {
    host: null,
    backLabel: "Back to hosts",
    embedded: false,
  },
);
const embedded = computed(() => props.embedded);
const emit = defineEmits<{ cancel: [] }>();
const ssh = useSshStore();
const store = useAppStore();
const panelNavigation = useSshPanelNavigation();
// A host without an id (a quick-connect tab being saved) is prefilled but still created.
const isNew = !props.host?.id;
const original = props.host ? (JSON.parse(JSON.stringify(props.host)) as SshHost) : null;
const nameWasEdited = ref(!isNew);
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
const form = reactive<SshHost>(
  original || {
    host: "",
    name: "",
    username: "",
    port: undefined,
    jump: [],
    tags: [],
    auth: { methods: ["agent"], keyRef: "", certRef: "" },
    advanced: { launchVia: "default", command: "", agentForward: false, wsl: {} },
  },
);
form.name ||= String(form.label || "");
form.auth ||= { methods: ["agent"], agent: "auto" };
form.advanced ||= { launchVia: "default", command: "", agentForward: false, wsl: {} };
form.advanced.wsl ||= {};
if (form.advanced.launchVia === undefined) form.advanced.launchVia = "ssh2";

const settingsDefault = computed(() =>
  String(store.payload?.appState?.settings?.ssh?.defaultLaunchVia || "system-ssh"),
);
const effectiveMode = computed(() => resolveSshLaunchVia(form.advanced.launchVia, settingsDefault.value));
const caps = computed(() => ssh.capabilities);
const launchViaOptions = computed(() => {
  const options = [
    { value: "default", label: `Use app default · ${modeLabel(settingsDefault.value)}` },
    { value: "ssh2", label: "Built-in SSH (recommended)" },
    {
      value: "system-ssh",
      label: `SSH on this computer${caps.value && !caps.value.systemSsh ? " · unavailable" : ""}`,
      disabled: caps.value ? !caps.value.systemSsh : false,
    },
  ];
  if (caps.value?.platform === "win32")
    options.push({
      value: "wsl",
      label: `SSH in WSL${caps.value.wsl?.installed ? "" : " · unavailable"}`,
      disabled: !caps.value.wsl?.installed,
    });
  return options;
});
const authOptions = [
  { value: "agent", label: "SSH agent" },
  { value: "key", label: "Key stored in strIDEterm" },
  { value: "keyboard-interactive", label: "Password / verification code" },
  { value: "advanced", label: "Advanced combination (preserved)" },
];
const authMethodCheckboxes = [
  { value: "agent", label: "SSH agent" },
  { value: "publickey", label: "Saved key" },
  { value: "password", label: "Password" },
  { value: "keyboard-interactive", label: "Password / verification code" },
];
const agentOptions = computed(() => [
  {
    value: "default",
    label: `Use app default · ${String(store.payload?.appState?.settings?.ssh?.defaultAgentMode || "auto")}`,
  },
  { value: "auto", label: "Automatic" },
  { value: "pageant", label: "Pageant" },
  { value: "pipe", label: "OpenSSH agent pipe (Windows)" },
  { value: "socket", label: "Unix socket (macOS/Linux)" },
  { value: "off", label: "Off" },
]);
const agentWasEdited = ref(false);
const agentChoice = computed({
  get: () => form.auth?.agent || "default",
  set: (value: string) => {
    agentWasEdited.value = true;
    form.auth!.agent = value === "default" ? undefined : value;
  },
});
const keyOptions = computed(() => [
  { value: "", label: "Select a key…" },
  ...ssh.keys.map((key) => ({ value: key.id, label: key.label })),
]);
const selectedManagedKey = computed(() => ssh.keys.find((key) => key.id === form.auth?.keyRef) || null);
const transferDisabledReason = computed(() => {
  if (effectiveMode.value !== "ssh2") return "Public-key transfer is available only for Built-in SSH hosts.";
  if (!form.host.trim()) return "Enter the server address or SSH alias first.";
  if (!form.username?.trim()) return "Enter the remote username before transferring a key.";
  if (!selectedManagedKey.value) return "Select or generate a key stored in strIDEterm first.";
  if (!selectedManagedKey.value.publicKey?.trim()) return "The selected key has no public-key data to transfer.";
  if (store.isRemoteTransport) return "Public-key transfer is available in the desktop app only.";
  return "";
});
const canTransferSelectedKey = computed(() => !transferDisabledReason.value);
const simpleAuth = computed({
  get: () => {
    const methods = form.auth!.methods || [];
    if (methods.length !== 1 || !["publickey", "agent", "keyboard-interactive"].includes(methods[0])) return "advanced";
    if (methods[0] === "publickey") return "key";
    return methods[0];
  },
  set: (value: string) => {
    if (value === "advanced") return;
    form.auth!.methods = [value === "key" ? "publickey" : value];
  },
});
const isCombinedAuth = computed(
  () =>
    (form.auth?.methods?.length || 0) !== 1 ||
    !["publickey", "agent", "keyboard-interactive"].includes(form.auth?.methods?.[0] || ""),
);
const wslDistros = computed<string[]>(() => ssh.capabilities?.wsl?.distros || []);
const wslDistroOptions = computed(() => [
  { value: "", label: "Default distribution" },
  ...wslDistros.value.map((name) => ({ value: name, label: name })),
]);
const portWasEdited = ref(false);
const keepaliveWasEdited = ref(false);
const portInput = computed({
  get: () => (effectiveMode.value !== "ssh2" && form.advanced.portOverride === false ? "" : (form.port ?? "")),
  set: (value: number | string) => {
    portWasEdited.value = true;
    form.port = value === "" ? undefined : Number(value);
    form.advanced!.portOverride = value !== "";
  },
});
const keepaliveSeconds = computed({
  get: () =>
    form.advanced?.keepaliveIntervalMs === undefined
      ? ""
      : Math.round(Number(form.advanced.keepaliveIntervalMs) / 1000),
  set: (value: number | string) => {
    keepaliveWasEdited.value = true;
    form.advanced!.keepaliveIntervalMs = value === "" ? undefined : Math.max(0, Number(value) || 0) * 1000;
  },
});
const tagsString = computed({
  get: () => (form.tags || []).join(", "),
  set: (value: string) => {
    form.tags = value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  },
});
const jumpHostsText = computed({
  get: () => (form.jump || []).join(", "),
  set: (value: string) => {
    form.jump = value
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
  },
});
const methodSummary = computed(() =>
  effectiveMode.value === "system-ssh"
    ? "Uses OpenSSH configuration, keys and aliases on this computer; sign-in prompts appear in the terminal."
    : effectiveMode.value === "wsl"
      ? "Uses Linux OpenSSH configuration and keys inside WSL; sign-in prompts appear in the terminal."
      : "Uses strIDEterm sign-in prompts and app-managed keys; does not need OpenSSH installed.",
);
const commandHelp = computed(() =>
  effectiveMode.value === "ssh2"
    ? "After sign-in, Built-in SSH types this command into the terminal. For example, use “tmux attach” to start tmux. Leave blank for a normal shell; commands that exit may leave the terminal at a shell prompt."
    : "After connecting, OpenSSH runs this command on the remote server instead of opening the usual interactive shell. For example, use “hostname” to print the server name and end the session. OpenSSH does not request a terminal for this command; interactive programs such as tmux need OpenSSH configured to request a terminal.",
);
const methodHelp = sshDefaultMethodHelp;
const help = {
  host: "Enter a server address. With SSH on this computer or SSH in WSL, you can also enter an alias from that environment's SSH config, such as prod. Built-in SSH needs a server address.",
  username:
    "This is the account on the remote server. Built-in SSH requires it. With SSH on this computer or in WSL, leave it empty to let that environment's SSH config choose the account.",
  method: methodHelp,
  auth: sshAuthenticationHelp,
  key: "Choose the private key whose matching public key is authorized on the server. Import or generate a key here, then add its public key to your account on the server. A key passphrase unlocks the private key; it is separate from your server login password.",
  agent:
    "An SSH agent keeps keys ready for use without asking for each key's passphrase. Use app default to follow Settings; Automatic checks for a running agent. OpenSSH agent pipe uses the Windows OpenSSH agent service, Pageant is the PuTTY agent, and Unix socket connects to an agent socket on macOS or Linux. Off ignores agents. The agent must be available to strIDEterm on this computer.",
  port: "For Built-in SSH, leave blank to use port 22; enter a number to use another port. For SSH on this computer or in WSL, leave blank to use the configured port; a number overrides it. Entering 22 explicitly replaces a different configured port with port 22.",
  keepalive:
    "Sends a small check while the connection is idle, which can help routers and servers keep an inactive session open. It does not reconnect a dropped session. Leave blank to use the client's default; enter 0 to turn these checks off.",
  forward:
    "Lets programs on this server use your local SSH agent to connect to other servers as you. This can expose your agent to anyone who can control your account here. Enable only when you trust the server and need to connect onward from it.",
  wslDistro:
    "Choose the WSL Linux environment that contains the SSH config, keys and agent for this connection. Blank uses the saved app default distribution, then the Windows default if no app default is set. Different distributions keep separate files and installed software.",
  wslUser:
    "This is the Linux account used inside WSL to start SSH and read its config and keys. It is not the username you use to sign in to the remote server; set that in the Username field above.",
  executable:
    "Leave empty to use the normal OpenSSH command in the selected environment. Set a full path only if you need a different installation; it may use a different config and keys.",
  wslExecutable:
    "Leave empty to use ssh inside the selected WSL distribution, or enter a Linux path such as /usr/bin/ssh. Windows executable paths do not work inside Linux.",
  jump: "Enter saved host IDs that this connection should pass through, separated by commas. Use this for a bastion or gateway between your computer and the destination. Each ID must belong to a saved host; aliases and display names are not accepted.",
};
const busy = ref(false);
const errorMessage = ref("");
const confirmingDiscard = ref(false);
const canTest = computed(() => !store.isRemoteTransport && caps.value?.permissions?.canManageHosts !== false);
const testDisabledReason = computed(() =>
  canTest.value ? undefined : caps.value?.permissions?.reason || "Connection testing is available in the desktop app.",
);

async function openConnectionTest() {
  if (busy.value || transferBusy.value || !canTest.value) return;
  if (transferOpen.value && !(await closeTransferSetup())) return;
  errorMessage.value = "";
  const identityError = validateSshConnectionIdentity({
    host: form.host,
    username: form.username,
    requireUsername: effectiveMode.value === "ssh2",
    port: form.port,
  });
  if (identityError) {
    errorMessage.value = identityError;
    return;
  }
  if (effectiveMode.value === "ssh2" && form.auth?.methods?.includes("publickey")) {
    if (!form.auth.keyRef || !ssh.keys.some((key) => key.id === form.auth!.keyRef)) {
      errorMessage.value = "Select an available saved key or change authentication.";
      return;
    }
  }
  if (effectiveMode.value === "ssh2" && form.auth?.certRef) {
    errorMessage.value =
      "Built-in SSH cannot use this certificate. Choose System SSH or WSL and configure the matching key and certificate in that environment's OpenSSH config.";
    return;
  }
  const draft = JSON.parse(JSON.stringify(form)) as Record<string, unknown>;
  delete draft.id;
  delete draft.createdAt;
  delete draft.updatedAt;
  delete draft.lastConnectedAt;
  const advanced = { ...((draft.advanced as Record<string, unknown> | undefined) || {}) };
  delete advanced.command;
  draft.advanced = advanced;
  const props = {
    profileId: store.myActiveProfileId || "default",
    draft,
    onCancel: panelNavigation ? undefined : store.backDialog,
  };
  if (panelNavigation) panelNavigation.open("SshConnectionTestDialog", props);
  else store.openSubDialog("SshConnectionTestDialog", props);
}

function modeLabel(mode: string) {
  return mode === "system-ssh" ? "SSH on this computer" : mode === "wsl" ? "SSH in WSL" : "Built-in SSH";
}
function suggestName() {
  if (isNew && !nameWasEdited.value) form.name = suggestedName();
}
function suggestedName(): string {
  const host = form.host.trim();
  if (!host) return "";
  const username = form.username?.trim();
  return username ? `${username}@${host}` : host;
}
function updateUsername(username: string) {
  form.username = username;
  suggestName();
}
function markNameEdited() {
  nameWasEdited.value = true;
}
function openKeyTransfer() {
  if (!canTransferSelectedKey.value || !selectedManagedKey.value) return;
  const draft = JSON.parse(JSON.stringify(form)) as Record<string, unknown>;
  delete draft.id;
  delete draft.createdAt;
  delete draft.updatedAt;
  delete draft.lastConnectedAt;
  draft.host = form.host.trim();
  draft.name = form.name?.trim() || undefined;
  transferDraft.value = draft as NonNullable<SshKeyTransferStart["draft"]>;
  transferKeyId.value = selectedManagedKey.value.id;
  transferOpen.value = true;
  void nextTick(() => {
    const element = keyTransferDialog.value?.$el;
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
}
function selectImportedKey(result: unknown) {
  const record =
    result && typeof result === "object" ? (result as { key?: { id?: string }; id?: string; keyId?: string }) : {};
  const keyId = record.key?.id || record.id || record.keyId;
  if (keyId) {
    form.auth!.keyRef = keyId;
    form.auth!.methods = ["publickey"];
  }
}

function openKeyImport() {
  const props = { onImported: selectImportedKey, backLabel: "Back to host" };
  if (panelNavigation) panelNavigation.open("SshKeyImportDialog", props);
  else store.openSshKeyImportDialog(selectImportedKey, "Back to host");
}

function openKeyGenerate() {
  const props = { onGenerated: selectImportedKey, backLabel: "Back to host" };
  if (panelNavigation) panelNavigation.open("SshKeyGenerateDialog", props);
  else store.openSshKeyGenerateDialog(selectImportedKey, "Back to host");
}

const initialDraft = JSON.stringify(form);
async function requestClose() {
  if (busy.value || confirmingDiscard.value) return;
  if (transferOpen.value) {
    if (!(await closeTransferSetup())) return;
  }
  if (JSON.stringify(form) !== initialDraft) {
    confirmingDiscard.value = true;
    try {
      const discard = await store.confirmInApp({
        title: "Discard SSH host changes?",
        message: "Your changes to this host have not been saved.",
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
async function closeTransferSetup(): Promise<boolean> {
  const requestClose = keyTransferDialog.value?.requestClose;
  if (!requestClose) return false;
  const closed = await requestClose();
  return closed && !transferOpen.value;
}
defineExpose({ requestClose });

onMounted(() => {
  void ssh.load();
});

async function save() {
  if (busy.value || transferBusy.value) return;
  if (transferOpen.value && !(await closeTransferSetup())) return;
  errorMessage.value = "";
  const identityError = validateSshConnectionIdentity({
    host: form.host,
    username: form.username,
    requireUsername: effectiveMode.value === "ssh2",
    port: form.port,
  });
  if (identityError) {
    errorMessage.value = identityError;
    return;
  }
  if (effectiveMode.value === "ssh2" && form.auth?.methods?.includes("publickey") && !form.auth.keyRef) {
    errorMessage.value = "Select or import a saved key.";
    return;
  }
  if (
    effectiveMode.value === "ssh2" &&
    form.auth?.methods?.includes("publickey") &&
    form.auth.keyRef &&
    !ssh.keys.some((key) => key.id === form.auth!.keyRef)
  ) {
    errorMessage.value = "The selected key is no longer available. Choose another key or change authentication.";
    return;
  }
  if (effectiveMode.value === "ssh2" && form.auth?.certRef) {
    errorMessage.value =
      "Built-in SSH cannot use this attached certificate. To use it with System SSH or WSL, configure the matching key and certificate in that environment's OpenSSH config; selecting that method alone does not configure the certificate. Clear the app reference only if you intend to remove it.";
    return;
  }
  busy.value = true;
  try {
    const payload = JSON.parse(JSON.stringify(form)) as SshHost;
    payload.host = payload.host.trim();
    payload.name = payload.name?.trim() || payload.host;
    const updatePayload = payload as unknown as Record<string, unknown>;
    if (portWasEdited.value && payload.port === undefined && !isNew) updatePayload.port = null;
    if (keepaliveWasEdited.value && payload.advanced?.keepaliveIntervalMs === undefined && !isNew)
      (payload.advanced as unknown as Record<string, unknown>).keepaliveIntervalMs = null;
    if (agentWasEdited.value && payload.auth?.agent === undefined && !isNew)
      (payload.auth as unknown as Record<string, unknown>).agent = null;
    const result = await ssh.saveHost(payload);
    if (result && typeof result === "object" && "id" in result) props.onSaved?.(result as SshHost);
    emit("cancel");
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to save host.";
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.ssh-host-editor {
  width: min(600px, 100%);
  height: min(720px, 88vh);
  display: flex;
  flex-direction: column;
}
.ssh-host-editor--embedded {
  width: 100%;
  height: auto;
  max-height: none;
  overflow: visible;
}
.ssh-host-editor--embedded :deep(.dialog__header) {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px 0;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.ssh-host-editor--embedded .ssh-host-editor__content {
  flex: initial;
  min-height: auto;
  overflow: visible;
  padding-top: 12px;
}
.ssh-host-editor__heading-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}
.ssh-host-editor--embedded .ssh-host-editor__footer {
  display: none;
}
.ssh-host-editor__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0 4px 4px 0;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ssh-host-editor__fields {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.ssh-host-editor__key-transfer-setup {
  display: grid;
  justify-items: start;
  gap: 4px;
}
.ssh-host-editor__key-transfer-setup .field-help {
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field > label {
  display: block;
  margin: 0;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
}
.input {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
  font: inherit;
}
.input-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.input-row :deep(.custom-select) {
  flex: 1 1 180px;
  min-width: min(180px, 100%);
}
.field-help {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
  margin: 2px 0 0;
}
.system-auth-note {
  margin: 0;
  padding: 10px;
  border-left: 3px solid var(--accent);
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
}
.advanced-options,
.advanced-auth {
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.advanced-options summary,
.advanced-auth summary {
  cursor: pointer;
  font-weight: 600;
}
.advanced-content {
  padding: 12px 0 2px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.checkbox-label input {
  width: auto;
  margin: 0;
}
/* Match the field labels (.field > label) instead of the global small-caps `label span`. */
.checkbox-label > span {
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}
.warning {
  color: #fbbf24;
}
.ssh-host-editor__footer {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
