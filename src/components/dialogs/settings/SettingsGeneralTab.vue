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
          :title="`Switch the app to the ${theme} theme — affects sidebar, dialogs, terminal colours, and the Electron title bar.`"
          @click="form.theme = theme"
        >
          {{ theme }}
        </button>
      </div>
    </div>

    <div>
      <span class="section-label">Terminal font size</span>
      <input
        v-model.number="form.terminalFontSize"
        type="number"
        min="8"
        max="32"
        step="1"
        class="settings-input settings-input--narrow"
        title="Font size for terminal windows (8–32 px). Also adjustable with Ctrl/Cmd + scroll wheel, Ctrl/Cmd + 0 to reset, or pinch on touch screens."
      />
      <small class="help-text">
        Font size for terminal windows (8–32 px). Desktop and remote/mobile clients use separate values. Also: Ctrl/Cmd
        + scroll to zoom, Ctrl/Cmd + 0 to reset to 13, pinch on touch screens.
      </small>
    </div>

    <div v-if="!api?.isRemote">
      <span class="section-label">External editor</span>
      <div class="input-with-action">
        <input v-model="form.externalEditor" placeholder="e.g. code, notepad++, vim --wait" class="settings-input" />
        <button
          v-if="api?.browseFile"
          type="button"
          class="button button--ghost input-with-action__btn"
          title="Open a file picker to locate your preferred external editor binary on disk."
          @click="browseEditor"
        >
          Browse
        </button>
      </div>
      <small class="help-text">
        When set, clicking on a <strong>file</strong> path in terminal output spawns this binary with the file path
        appended as the last argument (no shell). <code>code --wait</code> becomes
        <code>spawn("code", ["--wait", &lt;path&gt;])</code>. Quote binaries with spaces:
        <code>"C:\Program Files\App\app.exe"</code>. Directory clicks always use the OS default. For
        <code>{{ "${path}:${line}" }}</code
        >-style placeholders use "Terminal path links" → Custom command below. Leave empty to fall through to "Terminal
        path links".
      </small>
    </div>

    <!--
      Desktop-only: the path-opener setting drives the renderer's response to
      a path-link click in xterm output, which only fires inside the Electron
      app. The remote/HTTP transport drops this field server-side anyway (see
      REMOTE_BLOCKED_TOP_LEVEL_FIELDS in remote-server.ts), so showing the
      controls in a remote browser would let the user fiddle with values that
      silently never persist. Hide instead — same shape as the customPublicUrl
      decision (N-2026-05-06-1).
    -->
    <div v-if="!api?.isRemote">
      <span class="section-label">Terminal path links</span>
      <div class="path-opener-modes">
        <label
          v-for="opt in pathOpenerModes"
          :key="opt.value"
          class="path-opener-mode"
          :class="{ 'path-opener-mode--active': form.externalPathOpener.mode === opt.value }"
          :title="opt.tooltip"
        >
          <input
            v-model="form.externalPathOpener.mode"
            type="radio"
            name="external-path-opener-mode"
            :value="opt.value"
          />
          <span class="path-opener-mode__label">{{ opt.label }}</span>
          <small class="path-opener-mode__hint">{{ opt.hint }}</small>
        </label>
      </div>
      <div v-if="form.externalPathOpener.mode === 'command'" class="path-opener-command">
        <input
          v-model="form.externalPathOpener.command"
          placeholder="e.g. code -g ${path}:${line}:${column}"
          class="settings-input"
          title="Command template for opening file paths clicked in terminals. Tokens are split argv-style (no shell), so no metacharacters get interpreted. Substitutable placeholders: ${path}, ${line}, ${column}. Quote arguments containing spaces."
        />
        <small class="help-text">
          Substitutable placeholders: <code>${path}</code>, <code>${line}</code>, <code>${column}</code>. The template
          is parsed argv-style (no shell), so no metacharacters get interpreted. Examples:
          <code>code -g ${path}:${line}:${column}</code> (VS Code), <code>nvim +${line} ${path}</code> (Neovim),
          <code>subl ${path}:${line}:${column}</code> (Sublime).
        </small>
      </div>
      <small v-else class="help-text">
        How clicked file paths in terminal output get opened. Internal viewer requires the active workspace to have a
        Files tab — open one if it doesn't.
      </small>
    </div>

    <div v-if="!api?.isRemote">
      <span class="section-label">Clipboard image paste</span>
      <div class="settings-check" title="Master switch for the image-aware terminal paste behaviour described below.">
        <label class="settings-check__row">
          <input v-model="form.clipboardImagePasteEnabled" type="checkbox" />
          <span>Save pasted screenshots and type the file path into the terminal</span>
        </label>
        <small class="settings-check__help">
          When you press Ctrl/Cmd+V (or right-click paste) and the clipboard holds a screenshot, the image is saved as
          <code>strideterm-&lt;timestamp&gt;.png</code> and the path is typed into the terminal — so CLIs like Claude
          Code or Codex can read it off disk. Files already on disk that are also present in the clipboard (Snipping
          Tool, ShareX, Greenshot) are used in place — no duplicate save. Turn this off for plain xterm paste behaviour.
        </small>
      </div>
      <div class="clipboard-paste-dir" :class="{ 'clipboard-paste-dir--dim': !form.clipboardImagePasteEnabled }">
        <div class="input-with-action">
          <input
            v-model="form.clipboardImagePasteDir"
            :placeholder="`Leave empty for OS default (${clipboardImagePasteDefault})`"
            class="settings-input"
            :disabled="!form.clipboardImagePasteEnabled"
            title="Folder where strIDEterm saves a PNG when you paste a screenshot into a terminal. The terminal then receives the file path so CLI tools like Claude Code can read the image. Leave empty to use the platform default."
          />
          <button
            v-if="api?.browseDirectory"
            type="button"
            class="button button--ghost input-with-action__btn"
            :disabled="!form.clipboardImagePasteEnabled"
            title="Pick the folder where pasted clipboard screenshots get saved."
            @click="browseClipboardImageDir"
          >
            Browse
          </button>
        </div>
        <small class="help-text">
          Folder where the screenshot file is saved. Leave empty to use the OS default (<code>~/Desktop</code> on macOS,
          <code>~/Pictures/Screenshots</code> on Windows/Linux). A leading <code>~/</code> is expanded to your home
          directory.
        </small>
      </div>
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
          title="Open a file picker to locate the cloudflared binary used for Cloudflare quick-tunnels. Leave empty to fall back to PATH lookup."
          @click="browseCloudflared"
        >
          Browse
        </button>
      </div>
      <small class="help-text"
        >Used for Cloudflare Quick Tunnel detection and launch. Leave empty to fall back to PATH. Download cloudflared
        from <code>https://developers.cloudflare.com/tunnel/downloads/</code>.</small
      >
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
        title="Also notify when a sub-agent (e.g. a Claude Code Task tool) finishes mid-turn. Off by default: sub-agent completions are easy to mistake for the final result — usually only the end-of-turn notification matters."
      >
        <label class="settings-check__row">
          <input v-model="form.notifications.subagentCompletion" type="checkbox" />
          <span>Notify on sub-agent completion</span>
        </label>
        <small class="settings-check__help">
          Off = only the final end-of-turn notification. On = one extra ping per finished sub-agent (kind subagent_done,
          filterable per Telegram connection).
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
        <button
          type="button"
          class="button button--ghost button--small"
          title="Re-poll the notification metrics counters (hooks received, alerts emitted by tier and urgency, dismissals without interaction). Counters are kept in memory and reset when strIDEterm restarts."
          @click="hookSettings.refreshMetrics"
        >
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

const pathOpenerModes = [
  {
    value: "system",
    label: "System default",
    hint: "Open with the OS-registered handler (Finder, Explorer, xdg-open).",
    tooltip: "Hand the path to the OS default opener (`shell.openPath`). Always works; no editor configuration needed.",
  },
  {
    value: "command",
    label: "Custom command",
    hint: "Run your own editor — VS Code, Neovim, Sublime…",
    tooltip:
      "Run a command template you define below. Parsed argv-style (no shell). Use ${path}/${line}/${column} placeholders.",
  },
  {
    value: "internal",
    label: "Internal viewer",
    hint: "Open in strIDEterm's Files tab if the active workspace has one.",
    tooltip:
      "Switch to the active workspace's Files tab and select the file there. Falls back to a hint toast when no Files tab exists.",
  },
];

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

// Hint text only — backend has the authoritative copy of this default.
// Keep the two in sync if either changes.
const clipboardImagePasteDefault = computed(() => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  return ua.includes("mac") ? "~/Desktop" : "~/Pictures/Screenshots";
});

async function browseClipboardImageDir() {
  if (!props.api?.browseDirectory) return;
  const selected = (await props.api.browseDirectory(form.clipboardImagePasteDir || undefined)) as string | undefined;
  if (selected) form.clipboardImagePasteDir = selected;
}
</script>

<style scoped>
.settings-general-tab {
  display: grid;
  gap: 20px;
}

/* Visual separator between top-level sections — keeps the increasingly
   long General tab scannable. Last child has no border so the dialog
   footer doesn't sit on a double line. */
.settings-general-tab > div:not(:last-child) {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.clipboard-paste-dir {
  margin-top: 12px;
  transition: opacity 0.12s ease;
}

.clipboard-paste-dir--dim {
  opacity: 0.5;
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

.settings-input--narrow {
  width: 80px;
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

.path-opener-modes {
  display: grid;
  gap: 6px;
}

.path-opener-mode {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  column-gap: 8px;
  row-gap: 2px;
  align-items: start;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.02);
  transition: background 0.12s ease;
}

.path-opener-mode:hover {
  background: rgba(255, 255, 255, 0.04);
}

.path-opener-mode--active {
  border-color: var(--accent);
  background: rgba(var(--tint), 0.08);
}

.path-opener-mode input[type="radio"] {
  grid-row: 1 / 3;
  margin: 0;
  padding: 0;
  border: none;
  background: none;
  accent-color: var(--accent);
  width: auto;
  align-self: center;
}

.path-opener-mode__label {
  font-size: 13px;
  color: var(--text);
}

.path-opener-mode__hint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
}

.path-opener-command {
  margin-top: 8px;
  display: grid;
  gap: 4px;
}

.path-opener-command code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}

.help-text code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
</style>
