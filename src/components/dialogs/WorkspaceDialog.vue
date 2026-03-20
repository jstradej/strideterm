<template>
  <div class="dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Workspace</p>
        <h2>{{ workspace ? 'Edit workspace' : 'Add workspace' }}</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>{{ isAzure ? 'Review checkout root' : 'Working directory' }}</span>
        <div class="input-with-action">
          <input name="cwd" v-model="draft.cwd" :placeholder="cwdPlaceholder" maxlength="500" @change="onCwdChange" />
          <button v-if="api?.browseDirectory" type="button" class="button button--ghost input-with-action__btn" @click="browseCwd">Browse</button>
        </div>
      </label>
      <label>
        <span>Name</span>
        <input name="name" v-model="draft.name" required maxlength="60" />
      </label>
      <div class="grid">
        <label>
          <span>Badge</span>
          <input name="icon" v-model="draft.icon" maxlength="4" />
          <div class="icon-picker">
            <button
              v-for="icon in BADGE_ICONS"
              :key="icon"
              type="button"
              class="button button--ghost icon-picker__btn"
              @click="draft.icon = icon"
            >{{ icon }}</button>
          </div>
        </label>
        <label>
          <span>Accent</span>
          <div class="accent-row">
            <input name="color" type="color" v-model="draft.color" class="color-input" />
            <span class="color-preview" :style="{ background: draft.color }"></span>
          </div>
        </label>
      </div>
      <label>
        <span>Notes</span>
        <textarea name="notes" v-model="draft.notes" rows="3" placeholder="What belongs in this workspace?" maxlength="500" />
      </label>

      <!-- Docker workspace: no manual panels -->
      <p v-if="isDocker" class="info-box">
        Docker tabs (shells, logs) are created from the Docker manager inside the workspace. No manual tab setup needed.
      </p>

      <!-- Terminal / Azure workspace: panel editor -->
      <template v-else>
        <p v-if="isAzure" class="info-box">
          This workspace is the Azure DevOps parent. Its checkout root is used for managed review checkouts, and these tabs are copied into each new review subworkspace.
        </p>
        <PanelEditor
          :panels="draft.panels"
          :tab-templates="tabTemplates"
          :heading="isAzure ? 'Review workspace tabs' : 'Terminal tabs'"
        />
      </template>

      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="button">Save workspace</button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { reactive, computed, inject } from "vue";
import { cloneWorkspace, createEmptyWorkspace } from "../../workspace-state.js";
import { APP_CONFIG } from "../../../config/app-config.js";
import { safeColor } from "../../app/helpers.js";
import PanelEditor from "./PanelEditor.vue";

const BADGE_ICONS = [
  "\u{1F4BB}", "\u{2328}", "\u{1F527}", "\u2699", "\u{1F6E0}", "\u{1F4E6}", "\u{1F528}",
  "\u{1F5A5}", "\u{1F4C4}", "\u{1F4DD}", "\u{270F}", "\u{2702}",
  "\u{1F33F}", "\u{1F500}", "\u{1F4CB}",
  "\u{1F433}", "\u{1F3D7}", "\u{2601}",
  "\u{1F310}", "\u{1F50C}", "\u{1F4E1}", "\u{1F680}",
  "\u{1F5C4}", "\u{1F4BE}", "\u{1F4CA}", "\u{1F4C8}",
  "\u{1F9EA}", "\u2705", "\u{1F50D}", "\u{1F41B}",
  "\u{1F916}", "\u{1F9E0}", "\u2728",
  "\u26A1", "\u{1F3AF}", "\u{1F512}", "\u{1F511}", "\u{1F4C1}", "\u{1F4A1}", "\u2B50", "\u{1F3A8}", "\u{1F525}", "\u{1F48E}",
  "\u{2764}", "\u{1F4AC}", "\u{1F514}", "\u{1F6A9}", "\u{1F5D1}",
];

const props = defineProps({
  workspace: { type: Object, default: null },
  tabTemplates: { type: Array, default: () => [] },
});

const emit = defineEmits(["cancel", "submit"]);

const api = inject("api");

const cwdPlaceholder = APP_CONFIG.ui.defaultProjectCwdPlaceholder;

// Build a mutable reactive draft
const rawDraft = props.workspace ? cloneWorkspace(props.workspace) : createEmptyWorkspace();
rawDraft.color = safeColor(rawDraft.color);
const draft = reactive(rawDraft);

const isDocker = computed(() => draft.kind === "docker");
const isAzure = computed(() => draft.kind === "azure");

async function browseCwd() {
  if (!api?.browseDirectory) return;
  const selected = await api.browseDirectory(draft.cwd || "");
  if (!selected) return;
  draft.cwd = selected;
  if (!draft.name.trim() || draft.name === APP_CONFIG.ui.defaultPanelTitle) {
    const dirName = selected.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (dirName) draft.name = dirName;
  }
}

function onCwdChange() {
  const value = draft.cwd.trim();
  if (value && !draft.name.trim()) {
    const dirName = value.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (dirName) draft.name = dirName;
  }
}

function handleSubmit() {
  const result = {
    ...draft,
    name: draft.name.trim(),
    icon: draft.icon.trim() || APP_CONFIG.ui.defaultProjectIcon,
    cwd: draft.cwd.trim(),
    notes: draft.notes.trim(),
  };

  if (!isDocker.value) {
    result.panels = draft.panels.map((panel) => ({
      ...panel,
      title: panel.title.trim() || APP_CONFIG.ui.defaultPanelTitle,
      command: panel.command.trim() || "",
      startup: APP_CONFIG.ui.defaultPanelStartup,
    }));
    if (result.panels.length === 0) {
      const panelId = `panel-${crypto.randomUUID()}`;
      result.panels = [{ id: panelId, title: APP_CONFIG.ui.defaultPanelTitle, command: "", shell: true, startup: APP_CONFIG.ui.defaultPanelStartup }];
    }
    if (!result.panels.some((p) => p.id === result.activePanelId)) {
      result.activePanelId = result.panels[0]?.id || null;
    }
  }

  emit("submit", result);
}
</script>

<style scoped>
.icon-picker {
  display: grid;
  grid-template-columns: repeat(auto-fill, 32px);
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
  margin-top: 6px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}
.icon-picker__btn {
  padding: 0;
  width: 32px;
  height: 32px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 3px;
}
.accent-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.color-input {
  width: 48px;
  height: 36px;
  padding: 2px;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
}
.color-preview {
  flex: 1;
  height: 36px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.info-box {
  color: var(--muted);
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
}
</style>
