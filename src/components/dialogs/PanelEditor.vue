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
        type="button"
        class="button button--ghost template-btn"
        title="Add a blank tab — pick the title, command, and icon yourself in the editor below."
        @click="addPanel"
      >
        + Custom
      </button>
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

        <!-- Launch mode toggle: plain shell vs. WSL helper. The WSL helper
             builds the `wsl -- bash -lic "cd … && …; exec bash"` boilerplate
             from structured fields so users don't have to remember the
             quoting. Mirrors the toggle in EditTabDialog. -->
        <div class="segmented panel-card__launch-mode" role="tablist" aria-label="Launch mode">
          <button
            type="button"
            role="tab"
            :aria-selected="getLaunchMode(panel) === 'shell'"
            :class="['segmented__btn', { 'segmented__btn--active': getLaunchMode(panel) === 'shell' }]"
            title="Run the command directly in your default shell."
            @click="setLaunchMode(panel, 'shell')"
          >
            💻 Shell
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="getLaunchMode(panel) === 'wsl'"
            :class="['segmented__btn', { 'segmented__btn--active': getLaunchMode(panel) === 'wsl' }]"
            title="Wrap your command in `wsl -- bash -lic '…'` with optional distro, working directory, and keep-shell-open flag."
            @click="setLaunchMode(panel, 'wsl')"
          >
            🐧 WSL
          </button>
        </div>

        <template v-if="getLaunchMode(panel) === 'shell'">
          <label>
            <span>Command</span>
            <input v-model="panel.command" placeholder="optional boot command" maxlength="500" />
          </label>
        </template>
        <template v-else>
          <div class="wsl-grid">
            <label>
              <span>Distro (optional)</span>
              <input
                :value="wslStateFor(panel).distro"
                placeholder="e.g. Ubuntu-22.04 — leave blank for default"
                maxlength="60"
                title="Optional WSL distribution name (passed as `wsl -d <distro>`). Leave blank to use your configured default distro."
                @input="updateWsl(panel, 'distro', ($event.target as HTMLInputElement).value)"
              />
            </label>
            <label>
              <span>Working directory (optional)</span>
              <input
                :value="wslStateFor(panel).cwd"
                placeholder="/home/you"
                maxlength="500"
                title="Optional `cd <path>` to run before your command. Use a Linux-style path inside the WSL distro."
                @input="updateWsl(panel, 'cwd', ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
          <label>
            <span>Command</span>
            <input
              :value="wslStateFor(panel).command"
              placeholder="claude --dangerously-skip-permissions"
              maxlength="500"
              title="The actual command to run inside the WSL shell — no quoting needed, strIDEterm handles it."
              @input="updateWsl(panel, 'command', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="wsl-keep-open">
            <input
              type="checkbox"
              :checked="wslStateFor(panel).keepOpen"
              @change="updateWsl(panel, 'keepOpen', ($event.target as HTMLInputElement).checked)"
            />
            <span>
              Keep shell open after the command exits
              <small>Appends `; exec bash` so the WSL terminal stays open instead of closing on exit.</small>
            </span>
          </label>
          <div
            class="wsl-preview"
            title="The actual command strIDEterm will run. The structured fields above are just a helper — you can edit this directly for anything they don't cover (e.g. extra wsl flags)."
          >
            <span class="wsl-preview__label">Generated command</span>
            <input
              :value="panel.command"
              class="wsl-preview__code wsl-preview__code--input"
              placeholder="(empty — nothing will run)"
              maxlength="500"
              spellcheck="false"
              @input="panel.command = ($event.target as HTMLInputElement).value"
            />
          </div>
        </template>

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
import { ref, computed, reactive, watch } from "vue";
import { APP_CONFIG } from "../../../config/app-config.js";
import { buildWslCommand, parseWslCommand, type WslState } from "./wsl-launcher.js";
import { BADGE_ICONS, getTitleIcon, setTitleIcon } from "../../lib/badge-icons.js";

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
}

const props = withDefaults(defineProps<Props>(), {
  tabTemplates: () => [],
  heading: "Terminal tabs",
});

const emit = defineEmits<{
  "update:panels": [panels: PanelEntry[]];
}>();

const panelIconPickerOpen = ref(new Set<string>());

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

// --- WSL launcher per-panel state ------------------------------------------
// Each panel keeps its own structured WSL fields. The flat panel.command is
// the persisted source of truth (round-trippable via parseWslCommand /
// buildWslCommand); these reactive maps just hold the editor state so the
// user can toggle Shell↔WSL without losing what they've typed.

const wslStates = reactive<Record<string, WslState>>({});
const panelLaunchModes = reactive<Record<string, "shell" | "wsl">>({});

function isWslLike(cmd: string): boolean {
  return /^wsl(\s|$)/i.test((cmd || "").trim());
}

function ensurePanelMode(panel: PanelEntry) {
  if (panelLaunchModes[panel.id]) return;
  const parsed = parseWslCommand(panel.command || "");
  if (parsed) {
    wslStates[panel.id] = { ...parsed };
    panelLaunchModes[panel.id] = "wsl";
    return;
  }
  if (isWslLike(panel.command)) {
    // Bare `wsl` or `wsl -d <distro>` from the template — open in WSL mode
    // with whatever distro flag we can extract. keepOpen=false so the build
    // returns "" for an unedited form and panel.command stays as the
    // original bare command on submit.
    const distroMatch = /^wsl\s+-d\s+(\S+)/i.exec((panel.command || "").trim());
    wslStates[panel.id] = {
      distro: distroMatch?.[1] || "",
      cwd: "",
      command: "",
      keepOpen: false,
    };
    panelLaunchModes[panel.id] = "wsl";
    return;
  }
  wslStates[panel.id] = { distro: "", cwd: "", command: "", keepOpen: true };
  panelLaunchModes[panel.id] = "shell";
}

watch(
  () => props.panels.map((p) => p.id).join("|"),
  () => {
    for (const panel of props.panels) ensurePanelMode(panel);
  },
  { immediate: true },
);

function getLaunchMode(panel: PanelEntry): "shell" | "wsl" {
  ensurePanelMode(panel);
  return panelLaunchModes[panel.id];
}

function wslStateFor(panel: PanelEntry): WslState {
  ensurePanelMode(panel);
  return wslStates[panel.id];
}

function setLaunchMode(panel: PanelEntry, mode: "shell" | "wsl") {
  ensurePanelMode(panel);
  if (panelLaunchModes[panel.id] === mode) return;
  if (mode === "wsl") {
    // Seed inner command from the current panel.command if it's plain text
    // (not already a WSL wrapper) so the user doesn't lose what they typed
    // when toggling. Parsing the wrapper would also work but the typical
    // case is "user typed `claude`, clicked WSL" — preserve `claude`.
    const parsed = parseWslCommand(panel.command || "");
    if (parsed) {
      wslStates[panel.id] = { ...parsed };
    } else if (panel.command?.trim() && !wslStates[panel.id].command && !isWslLike(panel.command)) {
      wslStates[panel.id].command = panel.command.trim();
    }
  } else {
    // Switching back to Shell: keep the generated WSL wrapper in
    // panel.command so the user keeps their work — they can edit it inline
    // or delete it and start over.
    const generated = buildWslCommand(wslStates[panel.id]);
    if (generated) panel.command = generated;
  }
  panelLaunchModes[panel.id] = mode;
  syncPanelCommand(panel);
}

function updateWsl<K extends keyof WslState>(panel: PanelEntry, field: K, value: WslState[K]) {
  ensurePanelMode(panel);
  wslStates[panel.id][field] = value;
  syncPanelCommand(panel);
}

function syncPanelCommand(panel: PanelEntry) {
  if (panelLaunchModes[panel.id] !== "wsl") return;
  const generated = buildWslCommand(wslStates[panel.id]);
  // Only overwrite when the user actually filled something in. An empty
  // generated string means all WSL fields are blank — in that case keep
  // whatever the panel.command already is (e.g. the bare `wsl` from the
  // template) so toggling into WSL mode and not editing doesn't destroy it.
  if (generated) panel.command = generated;
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
  delete wslStates[panelId];
  delete panelLaunchModes[panelId];
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
  background: rgba(255, 255, 255, 0.04);
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
  background: rgba(255, 255, 255, 0.04);
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

/* Launch-mode segmented control — mirrors EditTabDialog's style so the two
   places that edit a panel.command stay visually consistent. */
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
  padding: 6px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.12s,
    color 0.12s;
}
.segmented__btn:hover:not(.segmented__btn--active) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}
.segmented__btn--active {
  background: var(--accent);
  color: #000;
}

/* WSL launcher fields — same layout idea as EditTabDialog. */
.wsl-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 10px;
}
.wsl-keep-open {
  display: flex !important;
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  cursor: pointer;
  padding: 4px 0;
}
.wsl-keep-open input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 2px 0 0 0;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.wsl-keep-open span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text);
  font-weight: 500;
}
.wsl-keep-open small {
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
.wsl-preview {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}
.wsl-preview__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
}
.wsl-preview__code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text);
  word-break: break-all;
  white-space: pre-wrap;
}
/* Editable form of the preview — same monospace look, but a real input so
   the user can override anything the structured fields can't express. */
.wsl-preview__code--input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(var(--tint), 0.04);
  outline: none;
}
.wsl-preview__code--input:focus {
  border-color: var(--accent);
  background: rgba(var(--tint), 0.06);
}
</style>
