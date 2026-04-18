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
        @click="switchTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- General tab -->
    <div v-if="activeTab === 'general'" class="settings-tab-content">
      <div>
        <span class="section-label">Theme</span>
        <div class="button-row">
          <button
            v-for="theme in THEMES"
            :key="theme"
            type="button"
            :class="['button', 'button-row__item', selectedTheme === theme ? 'button--active' : 'button--ghost']"
            @click="selectedTheme = theme"
          >
            {{ theme }}
          </button>
        </div>
      </div>
      <div>
        <span class="section-label">External editor</span>
        <div class="input-with-action">
          <input v-model="externalEditor" placeholder="e.g. code, notepad++, vim" class="settings-input" />
          <button
            v-if="api?.browseFile"
            type="button"
            class="button button--ghost input-with-action__btn"
            @click="browseEditor"
          >
            Browse
          </button>
        </div>
        <small class="help-text"
          >Command or path used to open files from Git changes. Leave empty to use OS default.</small
        >
      </div>
      <div>
        <span class="section-label">Cloudflared binary</span>
        <div class="input-with-action">
          <input v-model="cloudflaredPath" placeholder="Leave empty to use PATH" class="settings-input" />
          <button
            v-if="api?.browseFile"
            type="button"
            class="button button--ghost input-with-action__btn"
            @click="browseCloudflared"
          >
            Browse
          </button>
        </div>
        <small class="help-text">Used for Cloudflare Quick Tunnel detection and launch.</small>
      </div>
      <div>
        <span class="section-label">Log Level</span>
        <select v-model="logLevel" class="settings-input settings-select">
          <option v-for="lvl in LOG_LEVELS" :key="lvl" :value="lvl">{{ lvl }}</option>
        </select>
        <small class="help-text"
          >Controls verbosity of application logging. Logs are written to ~/.strideterm/logs/.</small
        >
      </div>
      <div>
        <span class="section-label">Notification Timing</span>
        <div class="settings-grid">
          <label class="settings-grid__field">
            <span class="settings-grid__label">Prompt quiet (ms)</span>
            <input v-model.number="notifPromptQuietMs" type="number" min="0" step="100" class="settings-input" />
          </label>
          <label class="settings-grid__field">
            <span class="settings-grid__label">Agent idle (ms)</span>
            <input v-model.number="notifAgentQuietMs" type="number" min="0" step="1000" class="settings-input" />
          </label>
          <label class="settings-grid__field">
            <span class="settings-grid__label">Agent idle fast (ms)</span>
            <input v-model.number="notifAgentQuietFastMs" type="number" min="0" step="1000" class="settings-input" />
          </label>
          <label class="settings-grid__field">
            <span class="settings-grid__label">Alert cooldown (ms)</span>
            <input v-model.number="notifAlertCooldownMs" type="number" min="0" step="1000" class="settings-input" />
          </label>
        </div>
        <small class="help-text">
          How long to wait before raising alerts. Prompt quiet = silence before shell prompt alert. Agent idle = silence
          before agent idle alert. Cooldown = minimum gap between alerts.
        </small>
        <div class="settings-check">
          <label class="settings-check__row">
            <input v-model="notifShellIntegration" type="checkbox" />
            <span>Shell integration (OSC 133)</span>
          </label>
          <small class="settings-check__help"
            >Auto-inject shell integration for instant command-completion detection.</small
          >
        </div>
        <div class="settings-check">
          <label class="settings-check__row">
            <input v-model="notifAgentHook" type="checkbox" />
            <span>Agent notification hook</span>
          </label>
          <small class="settings-check__help"
            >Start a local listener for instant agent idle detection via Claude Code notification hooks.</small
          >
        </div>
        <div class="settings-check">
          <label class="settings-check__row">
            <input v-model="notifDebug" type="checkbox" />
            <span>Debug logging</span>
          </label>
          <small class="settings-check__help"
            >Promote detection decisions (which tier, which guards passed/failed) to info-level logs. Useful when
            diagnosing false positives — paste log excerpts into bug reports.</small
          >
        </div>
        <details v-if="metricsSnapshot" class="metrics-details">
          <summary class="metrics-summary">Notification metrics</summary>
          <div class="metrics-grid">
            <div class="metrics-cell">
              <span class="metrics-label">Uptime</span>
              <span class="metrics-value">{{ formatMetricsUptime(metricsSnapshot.uptimeMs) }}</span>
            </div>
            <div class="metrics-cell">
              <span class="metrics-label">Hooks received</span>
              <span class="metrics-value">{{ metricsSnapshot.hooksReceived }}</span>
            </div>
            <div class="metrics-cell">
              <span class="metrics-label">Alerts total</span>
              <span class="metrics-value">{{ metricsSnapshot.alertsTotal }}</span>
            </div>
            <div class="metrics-cell">
              <span class="metrics-label">T1 / T2 / T3</span>
              <span class="metrics-value">
                {{ metricsSnapshot.alertsByTier[1] || 0 }} / {{ metricsSnapshot.alertsByTier[2] || 0 }} /
                {{ metricsSnapshot.alertsByTier[3] || 0 }}
              </span>
            </div>
            <div class="metrics-cell">
              <span class="metrics-label">Urgent / Normal</span>
              <span class="metrics-value">
                {{ metricsSnapshot.alertsByUrgency.urgent || 0 }} / {{ metricsSnapshot.alertsByUrgency.normal || 0 }}
              </span>
            </div>
            <div class="metrics-cell">
              <span class="metrics-label">Dismissed w/o interaction</span>
              <span class="metrics-value">{{ metricsSnapshot.dismissedWithoutInteraction }}</span>
            </div>
          </div>
          <button type="button" class="button button--ghost button--small" @click="refreshMetrics">Refresh</button>
        </details>
        <div v-if="notifAgentHook" class="hook-setup-section">
          <div class="hook-status-row">
            <span class="hook-status-badge" :class="'hook-status--' + hookStatus">
              {{ HOOK_STATUS_LABELS[hookStatus] || hookStatus }}
            </span>
            <button
              v-if="hookStatus !== 'configured'"
              type="button"
              class="button button--small"
              :disabled="hookBusy"
              @click="handleConfigureHook"
            >
              {{ hookBusy ? "Configuring..." : "Configure Claude Code" }}
            </button>
            <button
              v-else
              type="button"
              class="button button--ghost button--small"
              :disabled="hookBusy"
              @click="handleRemoveHook"
            >
              Remove hook
            </button>
            <button
              v-if="hookStatus === 'configured' || hookStatus === 'partial'"
              type="button"
              class="button button--small"
              :disabled="hookBusy || hookTesting"
              @click="handleTestHook"
            >
              {{ hookTesting ? "Testing..." : "Test hook" }}
            </button>
          </div>
          <p
            v-if="hookTestResult"
            class="hook-test-result"
            :class="hookTestResult.ok ? 'hook-test-ok' : 'hook-test-fail'"
          >
            <span v-if="hookTestResult.ok">✓ Hook delivered in {{ hookTestResult.elapsedMs }} ms.</span>
            <span v-else>
              ✗ {{ hookTestFailLabel(hookTestResult.reason) }}
              <span v-if="hookTestResult.detail"> — {{ hookTestResult.detail }}</span>
            </span>
          </p>
          <pre v-if="hookTestResult && !hookTestResult.ok && hookTestResult.logTail" class="hook-log-tail">{{
            hookTestResult.logTail
          }}</pre>
          <p v-if="hookError" class="hook-error">{{ hookError }}</p>
          <details class="hook-setup-details">
            <summary class="hook-setup-summary">Manual setup (advanced)</summary>
            <div class="hook-setup-content">
              <p>
                If auto-configure fails, add this to <code>~/.claude/settings.json</code> and place the
                <a
                  href="#"
                  class="link-accent"
                  @click.prevent="api?.openExternal?.('https://github.com/jstradej/strideterm#agent-hook')"
                  >notify script</a
                >
                at the referenced path:
              </p>
              <pre class="hook-setup-code">{{ hookConfigJson }}</pre>
              <button type="button" class="button button--ghost hook-copy-btn" @click="copyHookConfig">
                {{ hookCopied ? "Copied!" : "Copy to clipboard" }}
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>

    <!-- Templates tab -->
    <div v-else-if="activeTab === 'templates'" class="form settings-tab-content">
      <p class="templates-description">
        These templates appear when adding tabs to workspaces and in the quick-add (+) dropdown.
      </p>
      <div class="template-list">
        <div v-for="(tmpl, i) in templates" :key="tmpl.id || i" class="template-row">
          <span class="template-icon">{{ tmpl.icon }}</span>
          <input v-model="tmpl.title" placeholder="Title" maxlength="40" class="template-input" />
          <input v-model="tmpl.command" placeholder="Command" maxlength="500" class="template-input" />
          <button type="button" class="template-remove-btn" @click="templates.splice(i, 1)">&times;</button>
        </div>
        <button type="button" class="button button--ghost add-template-btn" @click="addTemplate">+ Add template</button>
      </div>
    </div>

    <!-- About tab -->
    <div v-else-if="activeTab === 'about'" class="settings-tab-content about-content">
      <h1 class="about-title">str<em class="about-accent">IDE</em>term</h1>
      <p class="about-subtitle">Multi-workspace terminal hub for developers</p>
      <p class="about-version">Version {{ appVersion }}</p>

      <div v-if="updateInfo" class="update-banner" :class="updateInfo.kind">
        <p class="update-banner__text">{{ updateInfo.message }}</p>
        <a
          v-if="updateInfo.url"
          :href="updateInfo.url"
          class="link-accent"
          @click.prevent="api?.openExternal?.(updateInfo.url)"
          >View release</a
        >
      </div>
      <p v-else-if="checkingUpdate" class="about-version">Checking for updates...</p>

      <button
        type="button"
        class="button button--ghost check-update-btn"
        :disabled="checkingUpdate"
        @click="handleCheckForUpdates"
      >
        {{ checkingUpdate ? "Checking..." : "Check for updates" }}
      </button>

      <p v-if="repositoryUrl" class="about-link">
        <a :href="repositoryUrl" target="_blank" rel="noopener noreferrer" class="link-accent">GitHub Repository</a>
      </p>
    </div>

    <footer class="dialog__footer settings-footer">
      <p v-if="saveError" class="save-error">{{ saveError }}</p>
      <span class="footer-actions">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="button" class="button" @click="handleSave">Save</button>
      </span>
    </footer>
  </div>
</template>

<script setup>
import { ref, reactive, computed, inject, toRaw, onMounted, onBeforeUnmount } from "vue";

const TABS = [
  { id: "general", label: "General" },
  { id: "templates", label: "Tab Templates" },
  { id: "about", label: "About" },
];

const THEMES = ["dark", "light", "system"];
const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"];

const props = defineProps({
  settings: { type: Object, default: () => ({}) },
  tabTemplates: { type: Array, default: () => [] },
  appVersion: { type: String, default: "" },
  repositoryUrl: { type: String, default: "" },
  versionCheck: { type: Object, default: null },
  saveError: { type: String, default: "" },
});

const emit = defineEmits(["cancel", "save"]);

const api = inject("api");

const activeTab = ref("general");
const selectedTheme = ref(props.settings.theme || "dark");
const logLevel = ref(props.settings.logLevel || "warn");
const externalEditor = ref(props.settings.externalEditor || "");
const cloudflaredPath = ref(props.settings.remoteAccess?.cloudflaredPath || "");
const notifPromptQuietMs = ref(props.settings.notifications?.promptQuietMs ?? 2500);
const notifAgentQuietMs = ref(props.settings.notifications?.agentQuietMs ?? 45000);
const notifAgentQuietFastMs = ref(props.settings.notifications?.agentQuietFastMs ?? 25000);
const notifAlertCooldownMs = ref(props.settings.notifications?.alertCooldownMs ?? 15000);
const notifShellIntegration = ref(props.settings.notifications?.shellIntegration ?? true);
const notifAgentHook = ref(props.settings.notifications?.agentHook ?? true);
const notifDebug = ref(props.settings.notifications?.debug ?? false);
const metricsSnapshot = ref(null);
let metricsTimer = null;

async function refreshMetrics() {
  try {
    if (api?.getNotificationMetrics) {
      metricsSnapshot.value = await api.getNotificationMetrics();
    }
  } catch {
    // Best-effort — metrics viewer just shows "—" if fetch fails.
  }
}
const hookCopied = ref(false);
const hookStatus = ref("unknown"); // "configured" | "not-configured" | "script-missing" | "error" | "unknown"
const hookError = ref("");

// -- Version check --
const checkingUpdate = ref(false);
const manualCheckResult = ref(null);

const updateInfo = computed(() => {
  const check = manualCheckResult.value || props.versionCheck;
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
const hookBusy = ref(false);
const templates = reactive((Array.isArray(props.tabTemplates) ? props.tabTemplates : []).map((t) => ({ ...t })));

function switchTab(tabId) {
  activeTab.value = tabId;
}

function addTemplate() {
  templates.push({ id: `tmpl-${Date.now()}`, title: "", command: "", icon: "\u{1F4BB}" });
}

async function browseEditor() {
  if (!api?.browseFile) return;
  const selected = await api.browseFile({ defaultPath: externalEditor.value });
  if (selected) externalEditor.value = selected;
}

async function browseCloudflared() {
  if (!api?.browseFile) return;
  const selected = await api.browseFile({ defaultPath: cloudflaredPath.value });
  if (selected) cloudflaredPath.value = selected;
}

const HOOK_STATUS_LABELS = {
  configured: "Configured",
  partial: "Partial — upgrade available",
  "not-configured": "Not configured",
  "script-missing": "Script missing",
  error: "Error",
  unknown: "Checking...",
};

const hookTesting = ref(false);
const hookTestResult = ref(null);

const hookConfigJson = `{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}`;

async function refreshHookStatus() {
  if (!api?.getAgentHookStatus) {
    hookStatus.value = "unknown";
    return;
  }
  try {
    const result = await api.getAgentHookStatus();
    hookStatus.value = result.status || "unknown";
  } catch {
    hookStatus.value = "error";
  }
}

async function handleConfigureHook() {
  if (!api?.configureAgentHook) return;
  hookBusy.value = true;
  hookError.value = "";
  try {
    const result = await api.configureAgentHook();
    if (result.ok) {
      hookStatus.value = "configured";
    } else {
      hookError.value = result.error || "Configuration failed.";
      hookStatus.value = "error";
    }
  } catch (error) {
    hookError.value = error.message || "Unexpected error during configuration.";
    hookStatus.value = "error";
  } finally {
    hookBusy.value = false;
  }
}

async function handleRemoveHook() {
  if (!api?.removeAgentHook) return;
  hookBusy.value = true;
  hookError.value = "";
  try {
    const result = await api.removeAgentHook();
    if (result.ok) {
      hookStatus.value = "not-configured";
    } else {
      hookError.value = result.error || "Removal failed.";
    }
  } catch (error) {
    hookError.value = error.message || "Unexpected error during removal.";
  } finally {
    hookBusy.value = false;
  }
}

async function handleTestHook() {
  if (!api?.testAgentHook) return;
  hookTesting.value = true;
  hookTestResult.value = null;
  try {
    const result = await api.testAgentHook();
    hookTestResult.value = result;
    if (result?.ok) {
      // Test passed — refresh status in case it went from partial → configured.
      await refreshHookStatus();
    }
  } catch (error) {
    hookTestResult.value = { ok: false, reason: "exception", detail: error?.message || String(error) };
  } finally {
    hookTesting.value = false;
  }
}

function hookTestFailLabel(reason) {
  switch (reason) {
    case "timeout":
      return "Hook did not arrive within 2s";
    case "notify-server-unavailable":
      return "Notify server is not running — enable Agent hook first";
    case "configure-failed":
      return "Could not configure Claude Code settings";
    case "config-error":
      return "Error reading Claude Code settings";
    case "spawn-failed":
    case "spawn-error":
      return "Could not launch notify.mjs — Node.js may be missing";
    case "exception":
      return "Unexpected error";
    default:
      return `Failed (${reason || "unknown"})`;
  }
}

async function copyHookConfig() {
  try {
    await navigator.clipboard.writeText(hookConfigJson);
    hookCopied.value = true;
    setTimeout(() => {
      hookCopied.value = false;
    }, 2000);
  } catch {
    // Clipboard API not available
  }
}

function formatMetricsUptime(ms) {
  const sec = Math.floor((ms || 0) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
}

onMounted(() => {
  refreshHookStatus();
  refreshMetrics();
  // Poll metrics every 10s while the dialog is open.
  metricsTimer = setInterval(refreshMetrics, 10_000);
});

onBeforeUnmount(() => {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
});

function handleSave() {
  emit("save", {
    theme: selectedTheme.value,
    logLevel: logLevel.value,
    externalEditor: externalEditor.value,
    remoteAccess: { cloudflaredPath: cloudflaredPath.value },
    notifications: {
      promptQuietMs: notifPromptQuietMs.value,
      agentQuietMs: notifAgentQuietMs.value,
      agentQuietFastMs: notifAgentQuietFastMs.value,
      alertCooldownMs: notifAlertCooldownMs.value,
      shellIntegration: notifShellIntegration.value,
      agentHook: notifAgentHook.value,
      debug: notifDebug.value,
    },
    tabTemplates: templates.filter((t) => t.title || t.command).map((t) => ({ ...toRaw(t) })),
  });
}
</script>

<style scoped>
.settings-dialog {
  width: min(540px, 100%);
  height: min(680px, 85vh);
  display: flex;
  flex-direction: column;
}
.settings-tab-bar {
  display: flex;
  gap: 2px;
  margin: 12px 0 16px;
  padding: 3px;
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
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
  align-content: start;
  padding-bottom: 4px;
  padding-right: 4px;
}
.section-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  display: block;
  margin-bottom: 6px;
}
.button-row {
  display: flex;
  gap: 4px;
}
.button-row__item {
  flex: 1;
  text-transform: capitalize;
}
.settings-input {
  padding: 6px 10px;
}
.settings-select {
  appearance: auto;
  max-width: 180px;
  cursor: pointer;
}
.help-text {
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
  display: block;
}
.templates-description {
  color: var(--muted);
  font-size: 13px;
  margin-bottom: 8px;
}
.template-list {
  display: grid;
  gap: 8px;
}
.template-row {
  display: grid;
  grid-template-columns: 40px 1fr 1fr auto;
  gap: 6px;
  align-items: center;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.template-icon {
  font-size: 20px;
  text-align: center;
}
.template-input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  font: inherit;
  font-size: 13px;
  box-sizing: border-box;
}
.template-remove-btn {
  color: var(--danger);
  background: none;
  border: 1px solid var(--border);
  border-radius: 3px;
  width: 28px;
  height: 28px;
  cursor: pointer;
  font-size: 16px;
  display: grid;
  place-items: center;
}
.add-template-btn {
  justify-self: start;
}
.about-content {
  text-align: center;
  padding: 24px 0;
}
.about-title {
  font-size: 28px;
}
.about-accent {
  color: var(--accent);
  font-style: normal;
}
.about-subtitle {
  color: var(--muted);
  margin: 8px 0;
}
.about-version {
  font-size: 13px;
  color: var(--muted);
}
.about-link {
  margin-top: 16px;
}
.update-banner {
  margin: 12px 0;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
}
.update-banner--current {
  background: rgba(76, 175, 80, 0.1);
  color: #81c784;
}
.update-banner--behind {
  background: rgba(255, 163, 71, 0.1);
  color: #ffb347;
}
.update-banner__text {
  margin: 0 0 4px;
}
.check-update-btn {
  margin-top: 12px;
}
.link-accent {
  color: var(--accent);
}
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.settings-grid__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.settings-grid__label {
  font-size: 12px;
  color: var(--muted);
}
.settings-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  cursor: pointer;
}
.settings-checkbox input {
  accent-color: var(--accent);
}
.settings-check {
  margin-top: 12px;
}
.settings-check__row {
  display: flex;
  grid-template-columns: none;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.settings-check__row input[type="checkbox"] {
  width: auto;
  padding: 0;
  border: none;
  background: none;
  accent-color: var(--accent);
  flex-shrink: 0;
  margin: 0;
}
.settings-check__row span {
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text);
}
.settings-check__help {
  display: block;
  margin-top: 4px;
  padding-left: 24px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
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
.hook-setup-section {
  margin-top: 8px;
  display: grid;
  gap: 8px;
}
.hook-status-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.hook-status-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}
.hook-status--configured {
  color: var(--success, #4caf50);
  background: rgba(76, 175, 80, 0.12);
}
.hook-status--not-configured,
.hook-status--unknown {
  color: var(--muted);
  background: rgba(255, 255, 255, 0.06);
}
.hook-status--error,
.hook-status--script-missing {
  color: var(--danger);
  background: rgba(255, 80, 80, 0.12);
}
.hook-error {
  color: var(--danger);
  font-size: 12px;
  margin: 0;
}
.hook-test-result {
  font-size: 12px;
  margin: 4px 0 0;
}
.hook-test-ok {
  color: var(--success, #6edfb6);
}
.hook-test-fail {
  color: var(--danger);
}
.hook-log-tail {
  font-size: 11px;
  max-height: 140px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.25);
  padding: 6px 8px;
  border-radius: 4px;
  margin: 4px 0 0;
  white-space: pre-wrap;
  font-family: var(--mono, monospace);
}
.button--small {
  padding: 4px 10px;
  font-size: 12px;
}
.hook-setup-details {
  margin-top: 2px;
}
.hook-setup-summary {
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}
.hook-setup-content {
  margin-top: 8px;
}
.hook-setup-content p {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
.hook-setup-code {
  font-size: 11px;
  line-height: 1.4;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border);
  overflow-x: auto;
  white-space: pre;
}
.hook-copy-btn {
  margin-top: 6px;
  font-size: 12px;
}
.metrics-details {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}
.metrics-summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--muted);
  user-select: none;
}
.metrics-grid {
  margin-top: 8px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
}
.metrics-cell {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  padding: 3px 0;
}
.metrics-label {
  color: var(--muted);
}
.metrics-value {
  font-variant-numeric: tabular-nums;
  color: inherit;
}
</style>
