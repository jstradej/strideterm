<template>
  <div class="dialog settings-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Application</p>
        <h2>Settings</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <!-- Tab bar -->
    <div class="settings-tab-bar">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="settings-tab-btn"
        :class="{ 'settings-tab-btn--active': activeTab === tab.id }"
        :title="tab.title"
        @click="switchTab(tab.id)"
      >
        {{ tab.label }}
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
      <SettingsSshTab />
    </div>

    <div v-else-if="activeTab === 'telegram'" class="settings-tab-content">
      <SettingsTelegramTab :telegram-settings="settings.integrations?.telegram" :profiles="profiles" />
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
          title="Discard every change made in this session and close the Settings dialog. Already-applied auto-saving controls (e.g. Configure hook) are not reverted."
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="button"
          title="Persist every changed field in this dialog to ~/.strideterm/strideterm-state.json and apply them. The dialog stays open afterwards so you can keep tweaking."
          @click="handleSave"
        >
          Save
        </button>
      </span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, provide, reactive, ref, toRaw } from "vue";
import type { Transport } from "../../transport.js";
import SettingsAboutTab from "./settings/SettingsAboutTab.vue";
import SettingsGeneralTab from "./settings/SettingsGeneralTab.vue";
import SettingsGitTab from "./settings/SettingsGitTab.vue";
import SettingsSshTab from "./settings/SettingsSshTab.vue";
import SettingsTelegramTab from "./settings/SettingsTelegramTab.vue";
import SettingsTemplatesTab from "./settings/SettingsTemplatesTab.vue";
import { useAgentHookSettings } from "./settings/useAgentHookSettings.js";

const TABS = [
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
  { id: "about", label: "About", title: "Version, repository link, and update check." },
];

const THEMES = ["dark", "light", "system"];
const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];

interface TelegramConnectionSetting {
  id: string;
  label: string;
  botTokenRef: string;
  chatId: string;
  enabled: boolean;
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
  remoteAccess?: { cloudflaredPath?: string };
  notifications?: {
    promptQuietMs?: number;
    agentQuietMs?: number;
    agentQuietFastMs?: number;
    alertCooldownMs?: number;
    shellIntegration?: boolean;
    agentHook?: boolean;
    debug?: boolean;
  };
  git?: { ui?: { showAllActions?: boolean } };
  externalPathOpener?: { mode?: string; command?: string };
  ssh?: {
    preferAgent?: boolean;
    agentPath?: string;
    allowSystemSshFallback?: boolean;
    certExpiryWarnHours?: number;
    defaultLaunchVia?: string;
    wslDefaultDistro?: string;
    systemSshPath?: string;
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
  /** Tab to open on mount. Defaults to `"general"`. */
  initialTab?: string;
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

const api = inject<Transport>("api");
const hookSettings = reactive(useAgentHookSettings(api));

const activeTab = ref(props.initialTab || "general");
const form = reactive({
  theme: props.settings.theme || "dark",
  logLevel: props.settings.logLevel || "warn",
  externalEditor: props.settings.externalEditor || "",
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
    allowSystemSshFallback: props.settings.ssh?.allowSystemSshFallback ?? true,
    certExpiryWarnHours: props.settings.ssh?.certExpiryWarnHours ?? 2,
    defaultLaunchVia: props.settings.ssh?.defaultLaunchVia || "ssh2",
    wslDefaultDistro: props.settings.ssh?.wslDefaultDistro || "",
    systemSshPath: props.settings.ssh?.systemSshPath || "",
    requireEncryptedStorage: props.settings.ssh?.requireEncryptedStorage ?? true,
  },
});

// -- Version check --
const checkingUpdate = ref(false);
const manualCheckResult = ref<unknown>(null);

const updateInfo = computed(() => {
  const check = (manualCheckResult.value || props.versionCheck) as
    | { versionsBehind: number; latestVersion: string; latestUrl: string }
    | null
    | undefined;
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

provide("settingsForm", form);
provide("settingsTemplates", templates);

function switchTab(tabId: string) {
  activeTab.value = tabId;
}

function handleSave() {
  emit("save", {
    theme: form.theme,
    logLevel: form.logLevel,
    externalEditor: form.externalEditor,
    remoteAccess: { cloudflaredPath: form.remoteAccess.cloudflaredPath },
    notifications: {
      promptQuietMs: form.notifications.promptQuietMs,
      agentQuietMs: form.notifications.agentQuietMs,
      agentQuietFastMs: form.notifications.agentQuietFastMs,
      alertCooldownMs: form.notifications.alertCooldownMs,
      shellIntegration: form.notifications.shellIntegration,
      agentHook: form.notifications.agentHook,
      debug: form.notifications.debug,
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
      allowSystemSshFallback: form.ssh.allowSystemSshFallback,
      certExpiryWarnHours: form.ssh.certExpiryWarnHours,
      defaultLaunchVia: form.ssh.defaultLaunchVia,
      wslDefaultDistro: form.ssh.wslDefaultDistro,
      systemSshPath: form.ssh.systemSshPath,
      requireEncryptedStorage: form.ssh.requireEncryptedStorage,
    },
  });
}
</script>

<style scoped>
.settings-dialog {
  width: min(620px, 100%);
  height: min(680px, 85vh);
  display: flex;
  flex-direction: column;
}
.settings-tab-bar {
  display: flex;
  gap: 6px;
  margin: 12px 0 16px;
  padding: 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
}
.settings-tab-btn {
  flex: 1;
  padding: 7px 12px;
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
</style>
