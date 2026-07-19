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

        <WslCommandFields v-model:command="panel.command" compact />

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
</style>
