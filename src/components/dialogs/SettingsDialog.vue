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
          <label
            class="settings-grid__field"
            title="Silence threshold before we decide the shell prompt has returned and raise a 'command finished' alert. Too low = spurious alerts mid-command. Default: 900 ms."
          >
            <span class="settings-grid__label">Prompt quiet (ms)</span>
            <input v-model.number="notifPromptQuietMs" type="number" min="0" step="100" class="settings-input" />
          </label>
          <label
            class="settings-grid__field"
            title="Silence threshold before an AI agent session is considered idle (default 20 s). Applies when no hook/OSC 133 signal is available."
          >
            <span class="settings-grid__label">Agent idle (ms)</span>
            <input v-model.number="notifAgentQuietMs" type="number" min="0" step="1000" class="settings-input" />
          </label>
          <label
            class="settings-grid__field"
            title="Shorter idle threshold used after a recent output burst — lets us react faster after the agent was clearly active. Default: 12 s."
          >
            <span class="settings-grid__label">Agent idle fast (ms)</span>
            <input v-model.number="notifAgentQuietFastMs" type="number" min="0" step="1000" class="settings-input" />
          </label>
          <label
            class="settings-grid__field"
            title="Minimum gap between two alerts from the same session. Prevents alert spam when a session rapidly flips between busy and idle. Default: 15 s."
          >
            <span class="settings-grid__label">Alert cooldown (ms)</span>
            <input v-model.number="notifAlertCooldownMs" type="number" min="0" step="1000" class="settings-input" />
          </label>
        </div>
        <small class="help-text">
          How long to wait before raising alerts. Prompt quiet = silence before shell prompt alert. Agent idle = silence
          before agent idle alert. Cooldown = minimum gap between alerts.
        </small>
        <div
          class="settings-check"
          title="Inject bash/zsh/PowerShell OSC 133 escape sequences into every PTY so strIDEterm can detect command completion instantly (zero false positives) instead of relying on silence timers."
        >
          <label class="settings-check__row">
            <input v-model="notifShellIntegration" type="checkbox" />
            <span>Shell integration (OSC 133)</span>
          </label>
          <small class="settings-check__help"
            >Auto-inject shell integration for instant command-completion detection.</small
          >
        </div>
        <div
          class="settings-check"
          title="Enable the local HTTP listener that receives notification events from Claude Code, Gemini CLI, and Codex CLI hooks. Required before you can Configure any provider below."
        >
          <label class="settings-check__row">
            <input v-model="notifAgentHook" type="checkbox" />
            <span>Agent notification hook</span>
          </label>
          <small class="settings-check__help">
            Start a local listener for instant agent idle detection. Enables the per-provider Configure buttons below
            (Claude Code, Gemini CLI, Codex CLI).
          </small>
        </div>
        <div
          class="settings-check"
          title="Verbose logging of detection decisions for diagnosing false positives / missed alerts. Writes to ~/.strideterm/logs/strideterm.log — paste excerpts into bug reports."
        >
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
          <div class="hook-section-title">Claude Code</div>
          <div class="hook-status-row">
            <span class="hook-status-badge" :class="'hook-status--' + hookStatus">
              {{ HOOK_STATUS_LABELS[hookStatus] || hookStatus }}
            </span>
            <button
              v-if="hookStatus !== 'configured'"
              type="button"
              class="button button--small"
              :disabled="hookBusy"
              title="Install strIDEterm hook entries into ~/.claude/settings.json so Claude Code fires Notification/Stop/SubagentStop/UserPromptSubmit events to the local listener. Merges with existing user hooks."
              @click="handleConfigureHook"
            >
              {{ hookBusy ? "Configuring..." : "Configure Claude Code" }}
            </button>
            <button
              v-else
              type="button"
              class="button button--ghost button--small"
              :disabled="hookBusy"
              title="Remove only strIDEterm's hook entries from ~/.claude/settings.json. Your own hooks stay intact."
              @click="handleRemoveHook"
            >
              Remove hook
            </button>
            <button
              v-if="hookStatus === 'configured' || hookStatus === 'partial'"
              type="button"
              class="button button--small"
              :disabled="hookBusy || hookTesting"
              title="End-to-end probe: spawns notify.mjs with a synthetic payload and measures round-trip latency to confirm the full pipeline (hook → HTTP listener → dispatcher) is live."
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
                  @click.prevent="
                    api?.openExternal?.('https://github.com/jstradej/strideterm#agent-notification-hooks')
                  "
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

          <div class="hook-section-title hook-section-title--spaced">Gemini CLI</div>
          <div class="hook-status-row">
            <span class="hook-status-badge" :class="'hook-status--' + geminiHookStatus">
              {{ HOOK_STATUS_LABELS[geminiHookStatus] || geminiHookStatus }}
            </span>
            <button
              v-if="geminiHookStatus !== 'configured'"
              type="button"
              class="button button--small"
              :disabled="geminiHookBusy"
              title="Install strIDEterm hook entries into ~/.gemini/settings.json. Registers AfterAgent, Notification, and BeforeAgent events (mapped to Claude-compatible names for the shared dispatcher). Preserves your existing Gemini settings."
              @click="handleConfigureGeminiHook"
            >
              {{ geminiHookBusy ? "Configuring..." : "Configure Gemini CLI" }}
            </button>
            <button
              v-else
              type="button"
              class="button button--ghost button--small"
              :disabled="geminiHookBusy"
              title="Remove only strIDEterm's hook entries from ~/.gemini/settings.json. Other Gemini config (MCP servers, extensions, user hooks) stays intact."
              @click="handleRemoveGeminiHook"
            >
              Remove hook
            </button>
            <button
              v-if="geminiHookStatus === 'configured' || geminiHookStatus === 'partial'"
              type="button"
              class="button button--small"
              :disabled="geminiHookBusy || geminiHookTesting"
              title="End-to-end probe through the shared notify.mjs. Confirms the Gemini hook → listener → dispatcher pipeline delivers events within 2 s."
              @click="handleTestGeminiHook"
            >
              {{ geminiHookTesting ? "Testing..." : "Test hook" }}
            </button>
          </div>
          <p
            v-if="geminiHookTestResult"
            class="hook-test-result"
            :class="geminiHookTestResult.ok ? 'hook-test-ok' : 'hook-test-fail'"
          >
            <span v-if="geminiHookTestResult.ok">✓ Hook delivered in {{ geminiHookTestResult.elapsedMs }} ms.</span>
            <span v-else>
              ✗ {{ hookTestFailLabel(geminiHookTestResult.reason) }}
              <span v-if="geminiHookTestResult.detail"> — {{ geminiHookTestResult.detail }}</span>
            </span>
          </p>
          <pre
            v-if="geminiHookTestResult && !geminiHookTestResult.ok && geminiHookTestResult.logTail"
            class="hook-log-tail"
            >{{ geminiHookTestResult.logTail }}</pre
          >
          <p v-if="geminiHookError" class="hook-error">{{ geminiHookError }}</p>
          <details class="hook-setup-details">
            <summary class="hook-setup-summary">Manual setup (advanced)</summary>
            <div class="hook-setup-content">
              <p>If auto-configure fails, add this to <code>~/.gemini/settings.json</code>:</p>
              <pre class="hook-setup-code">{{ geminiHookConfigJson }}</pre>
              <button type="button" class="button button--ghost hook-copy-btn" @click="copyGeminiHookConfig">
                {{ geminiHookCopied ? "Copied!" : "Copy to clipboard" }}
              </button>
            </div>
          </details>

          <div class="hook-section-title hook-section-title--spaced">Codex CLI</div>
          <p v-if="codexHookStatus === 'flag-missing'" class="hook-warn">
            Hooks are registered but the <code>codex_hooks</code> feature flag is not set in
            <code>~/.codex/config.toml</code>. Click Configure to fix.
          </p>
          <p class="hook-info">Requires Codex CLI 0.121.0+ on Windows.</p>
          <div class="hook-status-row">
            <span class="hook-status-badge" :class="'hook-status--' + codexHookStatus">
              {{ HOOK_STATUS_LABELS[codexHookStatus] || codexHookStatus }}
            </span>
            <button
              v-if="codexHookStatus !== 'configured'"
              type="button"
              class="button button--small"
              :disabled="codexHookBusy"
              title="Writes two files: (1) [features] codex_hooks = true into ~/.codex/config.toml (required for Codex to load hooks), (2) Stop + UserPromptSubmit entries into ~/.codex/hooks.json. Merges with existing settings."
              @click="handleConfigureCodexHook"
            >
              {{ codexHookBusy ? "Configuring..." : "Configure Codex CLI" }}
            </button>
            <button
              v-else
              type="button"
              class="button button--ghost button--small"
              :disabled="codexHookBusy"
              title="Remove only strIDEterm's hook entries from ~/.codex/hooks.json. The codex_hooks feature flag in config.toml is left alone — other hooks you may have rely on it."
              @click="handleRemoveCodexHook"
            >
              Remove hook
            </button>
            <button
              v-if="codexHookStatus === 'configured' || codexHookStatus === 'partial'"
              type="button"
              class="button button--small"
              :disabled="codexHookBusy || codexHookTesting"
              title="End-to-end probe through the shared notify.mjs. Confirms the Codex hook → listener → dispatcher pipeline delivers events within 2 s."
              @click="handleTestCodexHook"
            >
              {{ codexHookTesting ? "Testing..." : "Test hook" }}
            </button>
          </div>
          <p
            v-if="codexHookTestResult"
            class="hook-test-result"
            :class="codexHookTestResult.ok ? 'hook-test-ok' : 'hook-test-fail'"
          >
            <span v-if="codexHookTestResult.ok">✓ Hook delivered in {{ codexHookTestResult.elapsedMs }} ms.</span>
            <span v-else>
              ✗ {{ hookTestFailLabel(codexHookTestResult.reason) }}
              <span v-if="codexHookTestResult.detail"> — {{ codexHookTestResult.detail }}</span>
            </span>
          </p>
          <pre
            v-if="codexHookTestResult && !codexHookTestResult.ok && codexHookTestResult.logTail"
            class="hook-log-tail"
            >{{ codexHookTestResult.logTail }}</pre
          >
          <p v-if="codexHookError" class="hook-error">{{ codexHookError }}</p>
          <details class="hook-setup-details">
            <summary class="hook-setup-summary">Manual setup (advanced)</summary>
            <div class="hook-setup-content">
              <p>
                If auto-configure fails, (1) add <code>[features]<br />codex_hooks = true</code> to
                <code>~/.codex/config.toml</code>, then (2) add this to <code>~/.codex/hooks.json</code>:
              </p>
              <pre class="hook-setup-code">{{ codexHookConfigJson }}</pre>
              <button type="button" class="button button--ghost hook-copy-btn" @click="copyCodexHookConfig">
                {{ codexHookCopied ? "Copied!" : "Copy to clipboard" }}
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

    <!-- Git tab -->
    <div v-else-if="activeTab === 'git'" class="settings-tab-content">
      <div
        class="settings-check"
        title="When enabled, the Git tab shows all actions regardless of the current repository state (no context-based hiding). Useful for power users who prefer the raw unfiltered view."
      >
        <label class="settings-check__row">
          <input v-model="gitShowAllActions" type="checkbox" />
          <span>Show all actions</span>
        </label>
        <small class="settings-check__help">
          When off (default), actions that don't apply to the current state are hidden (e.g. Pull is hidden when there's
          no upstream, Push is hidden when in detached HEAD). Turn on to show all actions at all times — only structural
          impossibilities are still hidden (e.g. Push when there's no remote at all).
        </small>
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
  { id: "git", label: "Git" },
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
const gitShowAllActions = ref(props.settings.git?.ui?.showAllActions ?? false);
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
  "flag-missing": "Feature flag missing",
  error: "Error",
  unknown: "Checking...",
};

const hookTesting = ref(false);
const hookTestResult = ref(null);

// --- Gemini hook state (parallel to Claude) ---
const geminiHookStatus = ref("unknown");
const geminiHookError = ref("");
const geminiHookBusy = ref(false);
const geminiHookTesting = ref(false);
const geminiHookTestResult = ref(null);

// --- Codex hook state (parallel to Claude/Gemini) ---
const codexHookStatus = ref("unknown");
const codexHookError = ref("");
const codexHookBusy = ref(false);
const codexHookTesting = ref(false);
const codexHookTestResult = ref(null);

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

// Gemini CLI uses the Claude-compatible nested shape (matcher + hooks array) with
// millisecond timeouts. AfterAgent only honors "*" for the matcher. Event names
// map onto Claude aliases via argv[2] so the shared dispatcher works.
const geminiHookConfigJson = `{
  "hooks": {
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "strideterm-Stop",
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" Stop",
            "timeout": 5000
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "strideterm-Notification",
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" Notification",
            "timeout": 5000
          }
        ]
      }
    ],
    "BeforeAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "strideterm-UserPromptSubmit",
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" UserPromptSubmit",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}`;
const geminiHookCopied = ref(false);
async function copyGeminiHookConfig() {
  try {
    await navigator.clipboard.writeText(geminiHookConfigJson);
    geminiHookCopied.value = true;
    setTimeout(() => {
      geminiHookCopied.value = false;
    }, 2000);
  } catch {
    // Clipboard API not available
  }
}

// Codex CLI hooks — same nested shape as Claude (matcher + hooks array).
// Requires `codex_hooks = true` in ~/.codex/config.toml to load.
const codexHookConfigJson = `{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" Stop",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" UserPromptSubmit",
            "timeout": 5
          }
        ]
      }
    ]
  }
}`;
const codexHookCopied = ref(false);
async function copyCodexHookConfig() {
  try {
    await navigator.clipboard.writeText(codexHookConfigJson);
    codexHookCopied.value = true;
    setTimeout(() => {
      codexHookCopied.value = false;
    }, 2000);
  } catch {
    // Clipboard API not available
  }
}

async function refreshHookStatus() {
  if (!api?.getClaudeHookStatus) {
    hookStatus.value = "unknown";
    return;
  }
  try {
    const result = await api.getClaudeHookStatus();
    hookStatus.value = result.status || "unknown";
  } catch {
    hookStatus.value = "error";
  }
}

async function refreshGeminiHookStatus() {
  if (!api?.getGeminiHookStatus) {
    geminiHookStatus.value = "unknown";
    return;
  }
  try {
    const result = await api.getGeminiHookStatus();
    geminiHookStatus.value = result.status || "unknown";
  } catch {
    geminiHookStatus.value = "error";
  }
}

async function refreshCodexHookStatus() {
  if (!api?.getCodexHookStatus) {
    codexHookStatus.value = "unknown";
    return;
  }
  try {
    const result = await api.getCodexHookStatus();
    codexHookStatus.value = result.status || "unknown";
  } catch {
    codexHookStatus.value = "error";
  }
}

async function handleConfigureHook() {
  if (!api?.configureClaudeHook) return;
  hookBusy.value = true;
  hookError.value = "";
  try {
    const result = await api.configureClaudeHook();
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
  if (!api?.removeClaudeHook) return;
  hookBusy.value = true;
  hookError.value = "";
  try {
    const result = await api.removeClaudeHook();
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
  if (!api?.testClaudeHook) return;
  hookTesting.value = true;
  hookTestResult.value = null;
  try {
    const result = await api.testClaudeHook();
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

async function handleConfigureGeminiHook() {
  if (!api?.configureGeminiHook) return;
  geminiHookBusy.value = true;
  geminiHookError.value = "";
  try {
    const result = await api.configureGeminiHook();
    if (result.ok) {
      geminiHookStatus.value = "configured";
    } else {
      geminiHookError.value = result.error || "Configuration failed.";
      geminiHookStatus.value = "error";
    }
  } catch (error) {
    geminiHookError.value = error.message || "Unexpected error during configuration.";
    geminiHookStatus.value = "error";
  } finally {
    geminiHookBusy.value = false;
  }
}

async function handleRemoveGeminiHook() {
  if (!api?.removeGeminiHook) return;
  geminiHookBusy.value = true;
  geminiHookError.value = "";
  try {
    const result = await api.removeGeminiHook();
    if (result.ok) {
      geminiHookStatus.value = "not-configured";
    } else {
      geminiHookError.value = result.error || "Removal failed.";
    }
  } catch (error) {
    geminiHookError.value = error.message || "Unexpected error during removal.";
  } finally {
    geminiHookBusy.value = false;
  }
}

async function handleTestGeminiHook() {
  if (!api?.testGeminiHook) return;
  geminiHookTesting.value = true;
  geminiHookTestResult.value = null;
  try {
    const result = await api.testGeminiHook();
    geminiHookTestResult.value = result;
    if (result?.ok) await refreshGeminiHookStatus();
  } catch (error) {
    geminiHookTestResult.value = { ok: false, reason: "exception", detail: error?.message || String(error) };
  } finally {
    geminiHookTesting.value = false;
  }
}

async function handleConfigureCodexHook() {
  if (!api?.configureCodexHook) return;
  codexHookBusy.value = true;
  codexHookError.value = "";
  try {
    const result = await api.configureCodexHook();
    if (result.ok) {
      codexHookStatus.value = "configured";
    } else {
      codexHookError.value = result.error || "Configuration failed.";
      codexHookStatus.value = "error";
    }
  } catch (error) {
    codexHookError.value = error.message || "Unexpected error during configuration.";
    codexHookStatus.value = "error";
  } finally {
    codexHookBusy.value = false;
  }
}

async function handleRemoveCodexHook() {
  if (!api?.removeCodexHook) return;
  codexHookBusy.value = true;
  codexHookError.value = "";
  try {
    const result = await api.removeCodexHook();
    if (result.ok) {
      codexHookStatus.value = "not-configured";
    } else {
      codexHookError.value = result.error || "Removal failed.";
    }
  } catch (error) {
    codexHookError.value = error.message || "Unexpected error during removal.";
  } finally {
    codexHookBusy.value = false;
  }
}

async function handleTestCodexHook() {
  if (!api?.testCodexHook) return;
  codexHookTesting.value = true;
  codexHookTestResult.value = null;
  try {
    const result = await api.testCodexHook();
    codexHookTestResult.value = result;
    if (result?.ok) await refreshCodexHookStatus();
  } catch (error) {
    codexHookTestResult.value = { ok: false, reason: "exception", detail: error?.message || String(error) };
  } finally {
    codexHookTesting.value = false;
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
  refreshGeminiHookStatus();
  refreshCodexHookStatus();
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
    git: { ui: { showAllActions: gitShowAllActions.value } },
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
.hook-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.65;
}
.hook-section-title--spaced {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
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
.hook-status--script-missing,
.hook-status--flag-missing {
  color: var(--danger);
  background: rgba(255, 80, 80, 0.12);
}
.hook-warn {
  color: var(--warning, #e8a540);
  font-size: 12px;
  margin: 0;
}
.hook-info {
  color: var(--muted);
  font-size: 11px;
  margin: 0;
  opacity: 0.8;
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
