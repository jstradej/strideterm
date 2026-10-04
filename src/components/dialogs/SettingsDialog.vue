<template>
  <div class="dialog settings-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Application</p>
        <h2>Settings</h2>
      </div>
    </div>

    <!-- Tab bar -->
    <div class="settings-tab-bar" aria-label="Settings sections">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="settings-tab-btn"
        :class="{ 'settings-tab-btn--active': activeTab === tab.id }"
        :aria-pressed="activeTab === tab.id"
        :title="tab.title"
        @click="switchTab(tab.id)"
      >
        <svg
          v-if="tab.id === 'general'"
          class="settings-tab-btn__icon"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M4 5h12M4 10h12M4 15h12" />
          <circle cx="7" cy="5" r="1.5" />
          <circle cx="13" cy="10" r="1.5" />
          <circle cx="9" cy="15" r="1.5" />
        </svg>
        <svg
          v-else-if="tab.id === 'templates'"
          class="settings-tab-btn__icon"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="3" y="3" width="8" height="10" rx="1.5" />
          <path d="M7 16h8a2 2 0 0 0 2-2V6" />
        </svg>
        <svg
          v-else-if="tab.id === 'git'"
          class="settings-tab-btn__icon"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="5" cy="4" r="2" />
          <circle cx="5" cy="16" r="2" />
          <circle cx="15" cy="6" r="2" />
          <path d="M5 6v8a4 4 0 0 0 4-4V6a4 4 0 0 1 4-4" />
        </svg>
        <svg
          v-else-if="tab.id === 'ssh'"
          class="settings-tab-btn__icon"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="7" cy="8" r="4" />
          <path d="m10 11 6 6m-2-2 2-2m-4 0 2-2" />
        </svg>
        <svg
          v-else-if="tab.id === 'telegram'"
          class="settings-tab-btn__icon"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m2.5 9 15-6-4.8 14-3.1-5.2L2.5 9Z" />
          <path d="m9.6 11.8 5-5" />
        </svg>
        <svg
          v-else-if="tab.id === 'mobile'"
          class="settings-tab-btn__icon"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="5" y="2" width="10" height="16" rx="2" />
          <path d="M8 5h4m-2 10h.01" />
        </svg>
        <svg v-else class="settings-tab-btn__icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 9v5m0-8h.01" />
        </svg>
        <span>{{ tab.label }}</span>
      </button>
    </div>

    <div v-if="activeTab === 'general'" class="settings-tab-content">
      <SettingsGeneralTab :api="api" :themes="THEMES" :log-levels="LOG_LEVELS" :hook-settings="hookSettings" />
    </div>

    <div v-else-if="activeTab === 'templates'" class="form settings-tab-content">
      <SettingsTemplatesTab />
    </div>

    <div v-else-if="activeTab === 'git'" class="settings-tab-content">
      <SettingsGitTab />
    </div>

    <div v-else-if="activeTab === 'ssh'" class="settings-tab-content">
      <SettingsSshTab ref="sshSettingsTab" />
    </div>

    <div v-else-if="activeTab === 'telegram'" class="settings-tab-content">
      <SettingsTelegramTab :telegram-settings="settings.integrations?.telegram" :profiles="profiles" />
    </div>

    <div v-else-if="activeTab === 'mobile'" class="settings-tab-content">
      <SettingsMobileTab :profiles="profiles" :initial-view="initialMobileView" />
    </div>

    <div v-else-if="activeTab === 'about'" class="settings-tab-content">
      <SettingsAboutTab
        :api="api"
        :app-version="appVersion"
        :repository-url="repositoryUrl"
        :checking-update="checkingUpdate"
        :update-info="updateInfo"
        @check-updates="handleCheckForUpdates"
      />
    </div>

    <footer class="dialog__footer settings-footer">
      <p v-if="saveError" class="save-error">{{ saveError }}</p>
      <span class="footer-actions">
        <button
          type="button"
          class="button button--ghost"
          title="Discard unsaved settings and close. Saved host and key changes are kept."
          @click="requestCancel"
        >
          Cancel settings
        </button>
        <button
          type="button"
          class="button"
          title="Save pending settings and close. Host and key changes are saved separately."
          :disabled="saving"
          @click="handleSave"
        >
          Save settings
        </button>
      </span>
    </footer>
    <div v-if="cancelChoiceOpen" class="settings-discard-backdrop" role="presentation">
      <section
        class="settings-discard-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="settings-discard-title"
      >
        <h3 id="settings-discard-title">Unsaved Settings changes</h3>
        <p>Save these changes before leaving Settings?</p>
        <div class="settings-discard-actions">
          <button type="button" class="button button--ghost" :disabled="saving" @click="cancelChoiceOpen = false">
            Stay
          </button>
          <button type="button" class="button button--ghost" :disabled="saving" @click="discardSettings">
            Discard
          </button>
          <button type="button" class="button" :disabled="saving" @click="saveAndLeave">Save and leave</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, provide, reactive, ref, toRaw, watch } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import SettingsAboutTab from "./settings/SettingsAboutTab.vue";
import SettingsGeneralTab from "./settings/SettingsGeneralTab.vue";
import SettingsGitTab from "./settings/SettingsGitTab.vue";
import SettingsSshTab from "./settings/SettingsSshTab.vue";
import SettingsTelegramTab from "./settings/SettingsTelegramTab.vue";
import SettingsMobileTab from "./settings/SettingsMobileTab.vue";
import SettingsTemplatesTab from "./settings/SettingsTemplatesTab.vue";
import { useAgentHookSettings } from "./settings/useAgentHookSettings.js";

const BASE_TABS = [
  { id: "general", label: "General", title: "Theme, logging, notification timing, agent hooks." },
  { id: "templates", label: "Tab Templates", title: "Reusable tab presets shown in the “New tab” menu." },
  { id: "git", label: "Git", title: "Git UI options (e.g. always show all actions in the Git pane)." },
  { id: "ssh", label: "SSH", title: "SSH host/key configuration used by remote terminals." },
  {
    id: "telegram",
    label: "Telegram",
    title:
      "Forward strIDEterm alerts to a Telegram bot and act on them (start a task, open a PR review) by replying or pressing inline buttons. No public URL needed — long-polling.",
  },
];
const MOBILE_TAB = {
  id: "mobile",
  label: "Mobile",
  title:
    "Account and subscription for the hosted control plane, plus pairing strIDEterm Mobile for push notifications and typed remote actions.",
};
const ABOUT_TAB = { id: "about", label: "About", title: "Version, repository link, and update check." };

const THEMES = ["dark", "light", "system"];
const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];

interface TelegramConnectionSetting {
  id: string;
  label: string;
  botTokenRef: string;
  chatId: string;
  enabled: boolean;
  notificationsEnabled?: boolean;
  pollSeconds: number;
  profileId?: string;
  forwardKinds: string[];
}

interface ProfileSetting {
  id: string;
  name: string;
  color?: string;
}

interface SettingsObj {
  theme?: string;
  logLevel?: string;
  externalEditor?: string;
  clipboardImagePasteEnabled?: boolean;
  clipboardImagePasteDir?: string;
  remoteAccess?: { cloudflaredPath?: string };
  notifications?: {
    promptQuietMs?: number;
    agentQuietMs?: number;
    agentQuietFastMs?: number;
    alertCooldownMs?: number;
    shellIntegration?: boolean;
    agentHook?: boolean;
    debug?: boolean;
    agentsOnly?: boolean;
    subagentCompletion?: boolean;
    autoApprovePermissions?: boolean;
  };
  git?: { ui?: { showAllActions?: boolean } };
  externalPathOpener?: { mode?: string; command?: string };
  ssh?: {
    preferAgent?: boolean;
    agentPath?: string;
    certExpiryWarnHours?: number;
    defaultLaunchVia?: string;
    wslDefaultDistro?: string;
    wslSshExec?: string;
    systemSshPath?: string;
    defaultAgentMode?: string;
    requireEncryptedStorage?: boolean;
  };
  integrations?: {
    telegram?: {
      enabled?: boolean;
      defaultPollSeconds?: number;
      connections?: TelegramConnectionSetting[];
    };
  };
}

interface TabTemplate {
  id?: string;
  title?: string;
  command?: string;
  icon?: string;
}

interface Props {
  settings?: SettingsObj;
  tabTemplates?: TabTemplate[];
  profiles?: ProfileSetting[];
  appVersion?: string;
  repositoryUrl?: string;
  versionCheck?: { versionsBehind: number; latestVersion: string; latestUrl: string } | null;
  saveError?: string;
  saveCompleted?: number;
  /** Tab to open on mount. Defaults to `"general"`. */
  initialTab?: string;
  initialMobileView?: "overview" | "phones" | "account";
}

const props = withDefaults(defineProps<Props>(), {
  settings: () => ({}),
  tabTemplates: () => [],
  profiles: () => [],
  appVersion: "",
  repositoryUrl: "",
  initialTab: "general",
  versionCheck: null,
  saveError: "",
});

const emit = defineEmits<{
  cancel: [];
  save: [settings: unknown];
}>();

const api = inject<Transport>(apiKey);
const hookSettings = reactive(useAgentHookSettings(api));

// Mobile pairing/device management is Electron/desktop-only (plan §10.5) —
// the remote-HTTP transport never implements createMobilePairingInvitation
// (see transport.test.ts's KNOWN_DESKTOP_ONLY_METHODS), so the tab is simply
// absent there rather than showing controls that would silently no-op —
// same v-if-on-bridge-method precedent as WorkspaceDialog's browseDirectory.
const TABS = computed(() => [...BASE_TABS, ...(api?.createMobilePairingInvitation ? [MOBILE_TAB] : []), ABOUT_TAB]);

const activeTab = ref(props.initialTab || "general");
const sshSettingsTab = ref<{ requestClose?: () => Promise<boolean> } | null>(null);
const form = reactive({
  theme: props.settings.theme || "dark",
  logLevel: props.settings.logLevel || "warn",
  externalEditor: props.settings.externalEditor || "",
  clipboardImagePasteEnabled: props.settings.clipboardImagePasteEnabled !== false,
  clipboardImagePasteDir: props.settings.clipboardImagePasteDir || "",
  remoteAccess: {
    cloudflaredPath: props.settings.remoteAccess?.cloudflaredPath || "",
  },
  notifications: {
    promptQuietMs: props.settings.notifications?.promptQuietMs ?? 2500,
    agentQuietMs: props.settings.notifications?.agentQuietMs ?? 45000,
    agentQuietFastMs: props.settings.notifications?.agentQuietFastMs ?? 25000,
    alertCooldownMs: props.settings.notifications?.alertCooldownMs ?? 15000,
    shellIntegration: props.settings.notifications?.shellIntegration ?? true,
    agentHook: props.settings.notifications?.agentHook ?? true,
    debug: props.settings.notifications?.debug ?? false,
    agentsOnly: props.settings.notifications?.agentsOnly ?? true,
    subagentCompletion: props.settings.notifications?.subagentCompletion ?? false,
    autoApprovePermissions: props.settings.notifications?.autoApprovePermissions ?? false,
  },
  git: {
    ui: {
      showAllActions: props.settings.git?.ui?.showAllActions ?? false,
    },
  },
  externalPathOpener: {
    mode:
      props.settings.externalPathOpener?.mode === "command" || props.settings.externalPathOpener?.mode === "internal"
        ? props.settings.externalPathOpener.mode
        : "system",
    command: props.settings.externalPathOpener?.command || "",
  },
  ssh: {
    preferAgent: props.settings.ssh?.preferAgent ?? true,
    agentPath: props.settings.ssh?.agentPath ?? "",
    certExpiryWarnHours: props.settings.ssh?.certExpiryWarnHours ?? 2,
    defaultLaunchVia: props.settings.ssh?.defaultLaunchVia || "system-ssh",
    wslDefaultDistro: props.settings.ssh?.wslDefaultDistro || "",
    wslSshExec: props.settings.ssh?.wslSshExec || "",
    defaultAgentMode: props.settings.ssh?.defaultAgentMode || "auto",
    systemSshPath: props.settings.ssh?.systemSshPath || "",
    requireEncryptedStorage: props.settings.ssh?.requireEncryptedStorage ?? true,
  },
  terminalFontSize: api?.isRemote
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((props.settings as any).terminalFontSizeRemote ?? 13)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((props.settings as any).terminalFontSizeLocal ?? 13),
});

// -- Version check --
const checkingUpdate = ref(false);
const manualCheckResult = ref<unknown>(null);

const updateInfo = computed(() => {
  const check = (manualCheckResult.value || props.versionCheck) as
    { versionsBehind: number; latestVersion: string; latestUrl: string } | null | undefined;
  if (!check) return null;
  if (check.versionsBehind === 0) {
    return { kind: "update-banner--current", message: "You are on the latest version.", url: "" };
  }
  const label = check.versionsBehind === 1 ? "1 version" : `${check.versionsBehind} versions`;
  return {
    kind: "update-banner--behind",
    message: `You are ${label} behind. Latest: v${check.latestVersion}`,
    url: check.latestUrl,
  };
});

async function handleCheckForUpdates() {
  if (!api?.checkForUpdates) return;
  checkingUpdate.value = true;
  try {
    manualCheckResult.value = await api.checkForUpdates();
  } catch {
    manualCheckResult.value = null;
  } finally {
    checkingUpdate.value = false;
  }
}
const templates = reactive((Array.isArray(props.tabTemplates) ? props.tabTemplates : []).map((t) => ({ ...t })));
const initialSnapshot = JSON.stringify({ form: toRaw(form), templates: toRaw(templates) });
const cancelChoiceOpen = ref(false);
const saving = ref(false);
const leaveAfterSave = ref(false);
watch(
  () => props.saveError,
  (error) => {
    if (error) {
      saving.value = false;
      leaveAfterSave.value = false;
    }
  },
);
watch(
  () => props.saveCompleted,
  (completed) => {
    if (!completed || !saving.value) return;
    saving.value = false;
    if (leaveAfterSave.value) emit("cancel");
    leaveAfterSave.value = false;
  },
);
const hasUnsavedChanges = computed(
  () => JSON.stringify({ form: toRaw(form), templates: toRaw(templates) }) !== initialSnapshot,
);

provide("settingsForm", form);
provide("settingsTemplates", templates);

async function guardSshSettings(): Promise<boolean> {
  if (activeTab.value !== "ssh" || !sshSettingsTab.value?.requestClose) return true;
  return sshSettingsTab.value.requestClose();
}

async function switchTab(tabId: string) {
  if (tabId === activeTab.value) return;
  if (!(await guardSshSettings())) return;
  activeTab.value = tabId;
}

async function handleSave() {
  if (saving.value) return;
  if (!(await guardSshSettings())) return;
  saving.value = true;
  leaveAfterSave.value = true;
  emit("save", {
    theme: form.theme,
    logLevel: form.logLevel,
    externalEditor: form.externalEditor,
    clipboardImagePasteEnabled: form.clipboardImagePasteEnabled,
    clipboardImagePasteDir: form.clipboardImagePasteDir,
    remoteAccess: { cloudflaredPath: form.remoteAccess.cloudflaredPath },
    notifications: {
      promptQuietMs: form.notifications.promptQuietMs,
      agentQuietMs: form.notifications.agentQuietMs,
      agentQuietFastMs: form.notifications.agentQuietFastMs,
      alertCooldownMs: form.notifications.alertCooldownMs,
      shellIntegration: form.notifications.shellIntegration,
      agentHook: form.notifications.agentHook,
      debug: form.notifications.debug,
      agentsOnly: form.notifications.agentsOnly,
      subagentCompletion: form.notifications.subagentCompletion,
      autoApprovePermissions: form.notifications.autoApprovePermissions,
    },
    tabTemplates: templates.filter((t) => t.title || t.command).map((t) => ({ ...toRaw(t) })),
    git: { ui: { showAllActions: form.git.ui.showAllActions } },
    externalPathOpener: {
      mode: form.externalPathOpener.mode,
      command: form.externalPathOpener.command,
    },
    ssh: {
      preferAgent: form.ssh.preferAgent,
      agentPath: form.ssh.agentPath,
      certExpiryWarnHours: form.ssh.certExpiryWarnHours,
      defaultLaunchVia: form.ssh.defaultLaunchVia,
      wslDefaultDistro: form.ssh.wslDefaultDistro,
      wslSshExec: form.ssh.wslSshExec,
      defaultAgentMode: form.ssh.defaultAgentMode,
      systemSshPath: form.ssh.systemSshPath,
      requireEncryptedStorage: form.ssh.requireEncryptedStorage,
    },
    ...(api?.isRemote
      ? { terminalFontSizeRemote: Number(form.terminalFontSize) || 13 }
      : { terminalFontSizeLocal: Number(form.terminalFontSize) || 13 }),
  });
}

async function requestCancel() {
  if (saving.value) return;
  if (!(await guardSshSettings())) return;
  if (hasUnsavedChanges.value) cancelChoiceOpen.value = true;
  else emit("cancel");
}

async function requestClose() {
  await requestCancel();
}

function discardSettings() {
  if (saving.value) return;
  cancelChoiceOpen.value = false;
  emit("cancel");
}

function saveAndLeave() {
  cancelChoiceOpen.value = false;
  leaveAfterSave.value = true;
  handleSave();
}
defineExpose({ requestClose });
</script>

<style scoped>
/* Tracks the window like the Remote Access dialog (90e01240): 620px was a postage stamp on a wide
   screen. The clamp keeps the old size in a small window, and the overlay still caps it. */
.settings-dialog {
  width: min(100%, clamp(620px, 60vw, 1100px));
  height: min(900px, calc(100dvh - 40px));
  display: flex;
  flex-direction: column;
}
.settings-tab-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 16px;
  padding: 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
}
.settings-tab-btn {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 9px;
  border: none;
  border-radius: 4px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
  background: transparent;
  color: var(--muted);
}
.settings-tab-btn__icon {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.settings-tab-btn--active {
  background: var(--accent);
  color: #000;
}
.settings-tab-content {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding-bottom: 4px;
  padding-right: 4px;
}
.settings-footer {
  flex-shrink: 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  margin-top: auto;
  flex-wrap: wrap;
}
.footer-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.save-error {
  color: var(--danger);
  font-size: 13px;
  width: 100%;
  margin-bottom: 4px;
}
.settings-discard-backdrop {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.65);
}
.settings-discard-dialog {
  width: min(420px, 100%);
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-elevated);
  box-shadow: 0 12px 34px #0009;
}
.settings-discard-dialog h3 {
  margin: 0 0 8px;
}
.settings-discard-dialog p {
  color: var(--muted);
}
.settings-discard-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
</style>
