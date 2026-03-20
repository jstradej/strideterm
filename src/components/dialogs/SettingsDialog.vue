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
      >{{ tab.label }}</button>
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
          >{{ theme }}</button>
        </div>
      </div>
      <div>
        <span class="section-label">Cloudflared binary</span>
        <div class="input-with-action">
          <input v-model="cloudflaredPath" placeholder="Leave empty to use PATH" class="settings-input" />
          <button v-if="api?.browseFile" type="button" class="button button--ghost input-with-action__btn" @click="browseCloudflared">Browse</button>
        </div>
        <small class="help-text">Used for Cloudflare Quick Tunnel detection and launch.</small>
      </div>
    </div>

    <!-- Templates tab -->
    <div v-else-if="activeTab === 'templates'" class="form settings-tab-content">
      <p class="templates-description">These templates appear when adding tabs to workspaces and in the quick-add (+) dropdown.</p>
      <div class="template-list">
        <div
          v-for="(tmpl, i) in templates"
          :key="tmpl.id || i"
          class="template-row"
        >
          <span class="template-icon">{{ tmpl.icon }}</span>
          <input v-model="tmpl.title" placeholder="Title" maxlength="40" class="template-input" />
          <input v-model="tmpl.command" placeholder="Command" maxlength="500" class="template-input" />
          <button
            type="button"
            class="template-remove-btn"
            @click="templates.splice(i, 1)"
          >&times;</button>
        </div>
        <button type="button" class="button button--ghost add-template-btn" @click="addTemplate">+ Add template</button>
      </div>
    </div>

    <!-- About tab -->
    <div v-else-if="activeTab === 'about'" class="settings-tab-content about-content">
      <h1 class="about-title">str<em class="about-accent">IDE</em>term</h1>
      <p class="about-subtitle">Multi-workspace terminal hub for developers</p>
      <p class="about-version">Version {{ appVersion }}</p>
      <p v-if="repositoryUrl" class="about-link">
        <a :href="repositoryUrl" target="_blank" rel="noopener noreferrer" class="link-accent">GitHub Repository</a>
      </p>
    </div>

    <footer class="dialog__footer settings-footer">
      <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
      <button type="button" class="button" @click="handleSave">Save</button>
    </footer>
  </div>
</template>

<script setup>
import { ref, reactive, inject } from "vue";

const TABS = [
  { id: "general", label: "General" },
  { id: "templates", label: "Tab Templates" },
  { id: "about", label: "About" },
];

const THEMES = ["dark", "light", "system"];

const props = defineProps({
  settings: { type: Object, default: () => ({}) },
  tabTemplates: { type: Array, default: () => [] },
  appVersion: { type: String, default: "" },
  repositoryUrl: { type: String, default: "" },
});

const emit = defineEmits(["cancel", "save"]);

const api = inject("api");

const activeTab = ref("general");
const selectedTheme = ref(props.settings.theme || "dark");
const cloudflaredPath = ref(props.settings.remoteAccess?.cloudflaredPath || "");
const templates = reactive(
  (Array.isArray(props.tabTemplates) ? props.tabTemplates : []).map((t) => ({ ...t })),
);

function switchTab(tabId) {
  activeTab.value = tabId;
}

function addTemplate() {
  templates.push({ id: `tmpl-${Date.now()}`, title: "", command: "", icon: "\u{1F4BB}" });
}

async function browseCloudflared() {
  if (!api?.browseFile) return;
  const selected = await api.browseFile({ defaultPath: cloudflaredPath.value });
  if (selected) cloudflaredPath.value = selected;
}

function handleSave() {
  emit("save", {
    theme: selectedTheme.value,
    remoteAccess: { cloudflaredPath: cloudflaredPath.value },
    tabTemplates: templates.filter((t) => t.title || t.command),
  });
}
</script>

<style scoped>
.settings-dialog {
  width: min(540px, 100%);
  height: min(600px, 80vh);
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
  transition: background 0.12s, color 0.12s;
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
  display: grid;
  gap: 16px;
  align-content: start;
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
.link-accent {
  color: var(--accent);
}
.settings-footer {
  flex-shrink: 0;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}
</style>
