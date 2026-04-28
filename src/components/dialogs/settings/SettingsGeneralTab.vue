<template>
  <div class="settings-general-tab">
    <div>
      <span class="section-label">Theme</span>
      <div class="button-row">
        <button
          v-for="theme in themes"
          :key="theme"
          type="button"
          :class="['button', 'button-row__item', form.theme === theme ? 'button--active' : 'button--ghost']"
          @click="form.theme = theme"
        >
          {{ theme }}
        </button>
      </div>
    </div>

    <div>
      <span class="section-label">External editor</span>
      <div class="input-with-action">
        <input v-model="form.externalEditor" placeholder="e.g. code, notepad++, vim" class="settings-input" />
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
        <input
          v-model="form.remoteAccess.cloudflaredPath"
          placeholder="Leave empty to use PATH"
          class="settings-input"
        />
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
      <CustomSelect v-model="form.logLevel" class="settings-input settings-select" :options="logLevelOptions" />
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
          <input
            v-model.number="form.notifications.promptQuietMs"
            type="number"
            min="0"
            step="100"
            class="settings-input"
          />
        </label>
        <label
          class="settings-grid__field"
          title="Silence threshold before an AI agent session is considered idle (default 20 s). Applies when no hook/OSC 133 signal is available."
        >
          <span class="settings-grid__label">Agent idle (ms)</span>
          <input
            v-model.number="form.notifications.agentQuietMs"
            type="number"
            min="0"
            step="1000"
            class="settings-input"
          />
        </label>
        <label
          class="settings-grid__field"
          title="Shorter idle threshold used after a recent output burst — lets us react faster after the agent was clearly active. Default: 12 s."
        >
          <span class="settings-grid__label">Agent idle fast (ms)</span>
          <input
            v-model.number="form.notifications.agentQuietFastMs"
            type="number"
            min="0"
            step="1000"
            class="settings-input"
          />
        </label>
        <label
          class="settings-grid__field"
          title="Minimum gap between two alerts from the same session. Prevents alert spam when a session rapidly flips between busy and idle. Default: 15 s."
        >
          <span class="settings-grid__label">Alert cooldown (ms)</span>
          <input
            v-model.number="form.notifications.alertCooldownMs"
            type="number"
            min="0"
            step="1000"
            class="settings-input"
          />
        </label>
      </div>
      <small class="help-text">
        How long to wait before raising alerts. Prompt quiet = silence before shell prompt alert. Agent idle = silence
        before agent idle alert. Cooldown = minimum gap between alerts.
      </small>

      <div
        class="settings-check"
        title="Suppress 'command finished' alerts from plain shell sessions. AI agent sessions (Claude Code, Codex, Gemini, Copilot) still alert. Override per-panel in the panel editor for shell tabs where you do want the ping (e.g. long builds)."
      >
        <label class="settings-check__row">
          <input v-model="form.notifications.agentsOnly" type="checkbox" />
          <span>Notify only from AI agents</span>
        </label>
        <small class="settings-check__help">
          Hide shell-completion pings globally. Per-panel override available in the panel editor.
        </small>
      </div>

      <div
        class="settings-check"
        title="Inject bash/zsh/PowerShell OSC 133 escape sequences into every PTY so strIDEterm can detect command completion instantly (zero false positives) instead of relying on silence timers."
      >
        <label class="settings-check__row">
          <input v-model="form.notifications.shellIntegration" type="checkbox" />
          <span>Shell integration (OSC 133)</span>
        </label>
        <small class="settings-check__help"
          >Auto-inject shell integration for instant command-completion detection.</small
        >
      </div>

      <div
        class="settings-check"
        title="Enable the local HTTP listener that receives notification events from Claude Code, Gemini CLI, Codex CLI, and GitHub Copilot hooks. Required before you can Configure any provider below."
      >
        <label class="settings-check__row">
          <input v-model="form.notifications.agentHook" type="checkbox" />
          <span>Agent notification hook</span>
        </label>
        <small class="settings-check__help">
          Start a local listener for instant agent idle detection. Enables the per-provider Configure buttons below
          (Claude Code, Gemini CLI, Codex CLI, GitHub Copilot).
        </small>
      </div>

      <div
        class="settings-check"
        title="Verbose logging of detection decisions for diagnosing false positives / missed alerts. Writes to ~/.strideterm/logs/strideterm.log — paste excerpts into bug reports."
      >
        <label class="settings-check__row">
          <input v-model="form.notifications.debug" type="checkbox" />
          <span>Debug logging</span>
        </label>
        <small class="settings-check__help">
          Promote detection decisions (which tier, which guards passed/failed) to info-level logs. Useful when
          diagnosing false positives — paste log excerpts into bug reports.
        </small>
      </div>

      <details v-if="hookSettings.metricsSnapshot" class="metrics-details">
        <summary class="metrics-summary">Notification metrics</summary>
        <div class="metrics-grid">
          <div class="metrics-cell">
            <span class="metrics-label">Uptime</span>
            <span class="metrics-value">{{
              hookSettings.formatMetricsUptime(hookSettings.metricsSnapshot.uptimeMs)
            }}</span>
          </div>
          <div class="metrics-cell">
            <span class="metrics-label">Hooks received</span>
            <span class="metrics-value">{{ hookSettings.metricsSnapshot.hooksReceived }}</span>
          </div>
          <div class="metrics-cell">
            <span class="metrics-label">Alerts total</span>
            <span class="metrics-value">{{ hookSettings.metricsSnapshot.alertsTotal }}</span>
          </div>
          <div class="metrics-cell">
            <span class="metrics-label">T1 / T2 / T3</span>
            <span class="metrics-value">
              {{ hookSettings.metricsSnapshot.alertsByTier[1] || 0 }} /
              {{ hookSettings.metricsSnapshot.alertsByTier[2] || 0 }} /
              {{ hookSettings.metricsSnapshot.alertsByTier[3] || 0 }}
            </span>
          </div>
          <div class="metrics-cell">
            <span class="metrics-label">Urgent / Normal</span>
            <span class="metrics-value">
              {{ hookSettings.metricsSnapshot.alertsByUrgency.urgent || 0 }} /
              {{ hookSettings.metricsSnapshot.alertsByUrgency.normal || 0 }}
            </span>
          </div>
          <div class="metrics-cell">
            <span class="metrics-label">Dismissed w/o interaction</span>
            <span class="metrics-value">{{ hookSettings.metricsSnapshot.dismissedWithoutInteraction }}</span>
          </div>
        </div>
        <button type="button" class="button button--ghost button--small" @click="hookSettings.refreshMetrics">
          Refresh
        </button>
      </details>

      <div v-if="form.notifications.agentHook" class="hook-setup-section">
        <SettingsHookProviderSection
          v-for="(provider, index) in hookSettings.providers"
          :key="provider.id"
          :provider="provider"
          :status-labels="hookSettings.statusLabels"
          :hook-test-fail-label="hookSettings.hookTestFailLabel"
          :api="api"
          :spaced="index > 0"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import type { Transport } from "../../../transport.js";
import SettingsHookProviderSection from "./SettingsHookProviderSection.vue";
import CustomSelect from "../../common/CustomSelect.vue";

interface Props {
  api?: Transport | null;
  themes: string[];
  logLevels: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hookSettings: { providers: any[]; [key: string]: any };
}

const props = withDefaults(defineProps<Props>(), {
  api: null,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const form = inject<Record<string, any>>("settingsForm")!;

const logLevelOptions = computed(() => props.logLevels.map((level) => ({ value: level, label: level })));

async function browseEditor() {
  if (!props.api?.browseFile) return;
  const selected = await props.api.browseFile({ defaultPath: form.externalEditor });
  if (selected) form.externalEditor = selected;
}

async function browseCloudflared() {
  if (!props.api?.browseFile) return;
  const selected = await props.api.browseFile({ defaultPath: form.remoteAccess.cloudflaredPath });
  if (selected) form.remoteAccess.cloudflaredPath = selected;
}
</script>

<style scoped>
.settings-general-tab {
  display: grid;
  gap: 20px;
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

.settings-check {
  margin-top: 12px;
}

.settings-check__row {
  display: flex;
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

.hook-setup-section {
  margin-top: 8px;
  display: grid;
  gap: 8px;
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

.button--small {
  padding: 4px 10px;
  font-size: 12px;
}
</style>
