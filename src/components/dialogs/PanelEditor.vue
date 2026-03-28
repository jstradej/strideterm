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
        @click="addPanelFromTemplate(tmpl)"
      >
        {{ tmpl.icon }} {{ tmpl.title }}
      </button>
      <button type="button" class="button button--ghost template-btn" @click="addPanel">+ Custom</button>
    </div>
    <div class="panel-list">
      <article v-for="(panel, index) in panels" :key="panel.id" class="panel-card">
        <div class="panel-card__header">
          <strong>Tab {{ index + 1 }}</strong>
          <button type="button" class="button button--ghost" @click="removePanel(panel.id)">Remove</button>
        </div>
        <label>
          <span>Title</span>
          <div class="panel-title-row">
            <button type="button" class="panel-icon-btn" title="Pick icon" @click="togglePanelIconPicker(panel.id)">
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
              @click="pickPanelIcon(panel, icon)"
            >
              {{ icon }}
            </button>
          </div>
        </label>
        <label>
          <span>Command</span>
          <input v-model="panel.command" placeholder="optional boot command" maxlength="500" />
        </label>
      </article>
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from "vue";
import { APP_CONFIG } from "../../../config/app-config.js";

const BADGE_ICONS = [
  "\u{1F4BB}",
  "\u{2328}",
  "\u{1F527}",
  "\u2699",
  "\u{1F6E0}",
  "\u{1F4E6}",
  "\u{1F528}",
  "\u{1F5A5}",
  "\u{1F4C4}",
  "\u{1F4DD}",
  "\u{270F}",
  "\u{2702}",
  "\u{1F33F}",
  "\u{1F500}",
  "\u{1F4CB}",
  "\u{1F433}",
  "\u{1F3D7}",
  "\u{2601}",
  "\u{1F310}",
  "\u{1F50C}",
  "\u{1F4E1}",
  "\u{1F680}",
  "\u{1F5C4}",
  "\u{1F4BE}",
  "\u{1F4CA}",
  "\u{1F4C8}",
  "\u{1F9EA}",
  "\u2705",
  "\u{1F50D}",
  "\u{1F41B}",
  "\u{1F916}",
  "\u{1F9E0}",
  "\u2728",
  "\u26A1",
  "\u{1F3AF}",
  "\u{1F512}",
  "\u{1F511}",
  "\u{1F4C1}",
  "\u{1F4A1}",
  "\u2B50",
  "\u{1F3A8}",
  "\u{1F525}",
  "\u{1F48E}",
  "\u{2764}",
  "\u{1F4AC}",
  "\u{1F514}",
  "\u{1F6A9}",
  "\u{1F5D1}",
];

const DEFAULT_TAB_TEMPLATES = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
  { title: "Claude Code", command: "claude", icon: "\u{1F916}" },
  { title: "Browser", command: "https://", icon: "\u{1F310}" },
  { title: "Files", command: "__files__", icon: "\u{1F4C2}" },
];

const props = defineProps({
  panels: { type: Array, required: true },
  tabTemplates: { type: Array, default: () => [] },
  heading: { type: String, default: "Terminal tabs" },
});

const emit = defineEmits(["update:panels"]);

const panelIconPickerOpen = ref(new Set());

const resolvedTemplates = computed(() =>
  Array.isArray(props.tabTemplates) && props.tabTemplates.length ? props.tabTemplates : DEFAULT_TAB_TEMPLATES,
);

function panelIconValue(title) {
  const match = String(title || "").match(/^([\p{Emoji}\p{S}])\s*/u);
  return match ? match[1] : "";
}

function togglePanelIconPicker(panelId) {
  const next = new Set(panelIconPickerOpen.value);
  if (next.has(panelId)) next.delete(panelId);
  else next.add(panelId);
  panelIconPickerOpen.value = next;
}

function pickPanelIcon(panel, icon) {
  panel.title = icon + " " + panel.title.replace(/^[\p{Emoji}\p{S}]\s*/u, "");
  const next = new Set(panelIconPickerOpen.value);
  next.delete(panel.id);
  panelIconPickerOpen.value = next;
}

function addPanel() {
  props.panels.push({
    id: `panel-${crypto.randomUUID()}`,
    title: APP_CONFIG.ui.newPanelTitle,
    command: "",
    shell: true,
    startup: APP_CONFIG.ui.manualPanelStartup,
  });
}

function addPanelFromTemplate(tmpl) {
  props.panels.push({
    id: `panel-${crypto.randomUUID()}`,
    title: tmpl.icon ? `${tmpl.icon} ${tmpl.title}` : tmpl.title,
    command: tmpl.command || "",
    shell: true,
    startup: APP_CONFIG.ui.manualPanelStartup,
  });
}

function removePanel(panelId) {
  const index = props.panels.findIndex((p) => p.id === panelId);
  if (index !== -1) props.panels.splice(index, 1);
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
</style>
