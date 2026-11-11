<template>
  <section class="panel-editor">
    <div class="section-head">
      <div>
        <p class="eyebrow">Panels</p>
        <h3>{{ heading }}</h3>
      </div>
    </div>
    <div class="template-buttons">
      <button
        v-for="tmpl in resolvedTemplates"
        :key="tmpl.title"
        type="button"
        class="button button--ghost template-btn"
        :title="`Add a new ${tmpl.title} tab to this workspace${tmpl.command ? ` — runs '${tmpl.command}' on startup.` : '.'}`"
        @click="addPanelFromTemplate(tmpl)"
      >
        {{ tmpl.icon }} {{ tmpl.title }}
      </button>
      <button
        v-if="allowSsh"
        type="button"
        :class="['button', 'button--ghost', 'template-btn', { 'template-btn--active': sshPickerOpen }]"
        data-testid="panel-editor-ssh"
        title="Add a tab that connects to one of your saved SSH hosts. Pick the host in the row that opens below."
        :aria-expanded="sshPickerOpen"
        @click="toggleSshPicker"
      >
        🔐 SSH…
      </button>
      <button
        type="button"
        class="button button--ghost template-btn"
        title="Add a blank tab — pick the title, command, and icon yourself in the editor below."
        @click="addPanel"
      >
        + Custom
      </button>
    </div>
    <div v-if="allowSsh && sshPickerOpen" class="ssh-host-picker" data-testid="panel-editor-ssh-hosts">
      <template v-if="sshHosts.length">
        <button
          v-for="host in sshHosts"
          :key="host.id"
          type="button"
          class="button button--ghost template-btn"
          :title="`Add an SSH tab that connects to ${hostLabel(host)}.`"
          @click="addSshPanel(host)"
        >
          🔐 {{ host.name || host.host }}
        </button>
      </template>
      <span v-else-if="sshHostsLoading" class="ssh-host-picker__note">Loading saved SSH hosts…</span>
      <span v-else class="ssh-host-picker__note">
        No saved SSH hosts yet. Add one in Settings → SSH, or add the SSH tab later with + in the tab bar, which also
        offers Quick connect.
      </span>
    </div>
    <div class="panel-list">
      <article v-for="(panel, index) in panels" :key="panel.id" class="panel-card">
        <div class="panel-card__header">
          <strong>Tab {{ index + 1 }}</strong>
          <button
            type="button"
            class="button button--ghost"
            title="Remove this tab from the workspace template — its PTY session is killed when the workspace is saved."
            @click="removePanel(panel.id)"
          >
            Remove
          </button>
        </div>
        <label>
          <span>Title</span>
          <div class="panel-title-row">
            <button
              type="button"
              class="panel-icon-btn"
              title="Open the icon picker for this tab — pick an emoji that represents what the tab is for."
              @click="togglePanelIconPicker(panel.id)"
            >
              {{ panelIconValue(panel.title) || "💻" }}
            </button>
            <input v-model="panel.title" maxlength="60" class="panel-title-input" />
          </div>
          <div v-if="panelIconPickerOpen.has(panel.id)" class="panel-icon-picker">
            <button
              v-for="icon in BADGE_ICONS"
              :key="icon"
              type="button"
              class="panel-icon-picker__btn"
              :title="`Use ${icon} as the tab icon.`"
              @click="pickPanelIcon(panel, icon)"
            >
              {{ icon }}
            </button>
          </div>
        </label>

        <template v-if="panel.launch?.kind === 'ssh'">
          <p class="panel-card__ssh-host">SSH host: {{ sshPanelHostLabel(panel) }}</p>
          <label>
            <span
              >Remote directory (optional)
              <HelpTooltip
                text="The folder on the server where this tab starts, e.g. ~/projects/app. Right after sign-in strIDEterm changes to it and runs the initial command there. Needs a Unix-like shell on the server (Linux or macOS). If the folder does not exist, the terminal shows the error and the initial command does not run."
                label="Remote directory help"
            /></span>
            <input
              :value="panel.launch.remoteCwd || ''"
              data-testid="panel-editor-remote-cwd"
              placeholder="e.g. ~/projects/app"
              :maxlength="REMOTE_CWD_MAX_LENGTH"
              @input="setRemoteCwd(panel, ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label>
            <span
              >Initial command (optional)
              <HelpTooltip
                text="Runs on the server right after sign-in, in the remote directory when one is set, and replaces the host's own startup command for this tab. Leave it blank to use the host's startup command, or a normal shell."
                label="Initial command help"
            /></span>
            <input v-model="panel.command" maxlength="500" placeholder="e.g. claude" />
          </label>
        </template>
        <WslCommandFields v-else v-model:command="panel.command" compact />

        <label
          class="panel-card__toggle"
          title="Force notifications on for this panel even when 'Notify only from AI agents' is enabled globally. Useful for shell tabs where you do want the 'command finished' ping (e.g. long-running build scripts)."
        >
          <input v-model="panel.alertsForceOn" type="checkbox" />
          <span>Always notify on this panel (override global agents-only)</span>
        </label>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { APP_CONFIG } from "../../../config/app-config.js";
import { BADGE_ICONS, getTitleIcon, setTitleIcon } from "../../lib/badge-icons.js";
import type { PanelLaunch } from "../../../electron/shared/types/state.js";
import { REMOTE_CWD_MAX_LENGTH } from "../../../electron/shared/ssh-remote-cwd.js";
import { useSshStore } from "../../stores/ssh.js";
import HelpTooltip from "../common/HelpTooltip.vue";
import WslCommandFields from "./WslCommandFields.vue";

const DEFAULT_TAB_TEMPLATES = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
  { title: "Claude Code", command: "claude", icon: "\u{1F916}" },
  { title: "Codex", command: "codex", icon: "\u{1F9E0}" },
  { title: "Gemini CLI", command: "gemini", icon: "✨" },
  { title: "GitHub Copilot", command: "copilot", icon: "\u{1F419}" },
  { title: "OpenCode", command: "opencode", icon: "\u{1F9EC}" },
  { title: "Browser", command: "https://", icon: "\u{1F310}" },
  { title: "Files", command: "__files__", icon: "\u{1F4C2}" },
];

interface PanelEntry {
  id: string;
  title: string;
  command: string;
  shell?: boolean;
  startup?: string;
  alertsForceOn?: boolean;
  launch?: PanelLaunch | null;
}

interface SshHostEntry {
  id: string;
  host: string;
  name?: string;
  username?: string;
}

interface TabTemplate {
  title: string;
  command: string;
  icon?: string;
}

interface Props {
  panels: PanelEntry[];
  tabTemplates?: TabTemplate[];
  heading?: string;
  allowSsh?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  tabTemplates: () => [],
  heading: "Terminal tabs",
  allowSsh: false,
});

const emit = defineEmits<{
  "update:panels": [panels: PanelEntry[]];
}>();

const panelIconPickerOpen = ref(new Set<string>());
const sshStore = useSshStore();
const sshPickerOpen = ref(false);
const sshHostsLoading = ref(false);
const sshHosts = computed(() => (sshStore.hosts || []) as SshHostEntry[]);

function hostLabel(host: SshHostEntry) {
  const target = host.username ? `${host.username}@${host.host}` : host.host;
  return host.name && host.name !== host.host ? `${host.name} (${target})` : target;
}

function sshPanelHostLabel(panel: PanelEntry) {
  const launch = panel.launch;
  if (launch?.sshInline) return launch.sshInline.name || launch.sshInline.host || "Quick connect";
  const host = sshHosts.value.find((h) => h.id === launch?.sshHostId);
  return host ? hostLabel(host) : "a saved host that no longer exists";
}

// Direct nested-prop mutation, like panel.title and panel.command above.
function setRemoteCwd(panel: PanelEntry, value: string) {
  if (panel.launch) panel.launch.remoteCwd = value;
}

function toggleSshPicker() {
  sshPickerOpen.value = !sshPickerOpen.value;
  if (!sshPickerOpen.value || sshHosts.value.length > 0) return;
  sshHostsLoading.value = true;
  // load() reports its own failure as a toast.
  void sshStore.load().finally(() => {
    sshHostsLoading.value = false;
  });
}

function addSshPanel(host: SshHostEntry) {
  sshPickerOpen.value = false;
  emit("update:panels", [
    ...props.panels,
    {
      id: `panel-${crypto.randomUUID()}`,
      title: `🔐 ${host.name || host.host}`,
      command: "",
      shell: true,
      startup: APP_CONFIG.ui.manualPanelStartup,
      launch: { kind: "ssh", sshHostId: host.id },
    },
  ]);
}

const resolvedTemplates = computed(() =>
  Array.isArray(props.tabTemplates) && props.tabTemplates.length ? props.tabTemplates : DEFAULT_TAB_TEMPLATES,
);

function panelIconValue(title: string) {
  return getTitleIcon(title);
}

function togglePanelIconPicker(panelId: string) {
  const next = new Set(panelIconPickerOpen.value);
  if (next.has(panelId)) next.delete(panelId);
  else next.add(panelId);
  panelIconPickerOpen.value = next;
}

function pickPanelIcon(panel: PanelEntry, icon: string) {
  panel.title = setTitleIcon(panel.title, icon);
  const next = new Set(panelIconPickerOpen.value);
  next.delete(panel.id);
  panelIconPickerOpen.value = next;
}

function addPanel() {
  emit("update:panels", [
    ...props.panels,
    {
      id: `panel-${crypto.randomUUID()}`,
      title: APP_CONFIG.ui.newPanelTitle,
      command: "",
      shell: true,
      startup: APP_CONFIG.ui.manualPanelStartup,
    },
  ]);
}

function addPanelFromTemplate(tmpl: TabTemplate) {
  emit("update:panels", [
    ...props.panels,
    {
      id: `panel-${crypto.randomUUID()}`,
      title: tmpl.icon ? `${tmpl.icon} ${tmpl.title}` : tmpl.title,
      command: tmpl.command || "",
      shell: true,
      startup: APP_CONFIG.ui.manualPanelStartup,
    },
  ]);
}

function removePanel(panelId: string) {
  emit(
    "update:panels",
    props.panels.filter((p) => p.id !== panelId),
  );
}
</script>

<style scoped>
.template-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.template-btn--active {
  border-color: var(--accent);
}
.ssh-host-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
}
.ssh-host-picker__note {
  font-size: 12px;
  color: var(--muted);
}
.panel-card__ssh-host {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.template-btn {
  font-size: 12px;
  padding: 4px 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.panel-title-row {
  display: flex;
  gap: 4px;
  align-items: stretch;
}
.panel-icon-btn {
  width: 36px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(var(--tint), 0.04);
  cursor: pointer;
  font-size: 16px;
  padding: 0;
}
.panel-title-input {
  flex: 1;
  min-width: 0;
}
.panel-icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 6px;
  margin: -4px 0 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
}
.panel-icon-picker__btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(var(--tint), 0.04);
  cursor: pointer;
  font-size: 14px;
  padding: 0;
}

/* Override the global `label { display: grid }` so the "Always notify"
   checkbox sits inline (checkbox first, text after) instead of being
   stacked vertically with the text as a tiny uppercase label. */
.panel-card__toggle {
  display: flex !important;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin: 0;
  cursor: pointer;
}
.panel-card__toggle input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.panel-card__toggle span {
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text);
  font-weight: 500;
}
</style>
