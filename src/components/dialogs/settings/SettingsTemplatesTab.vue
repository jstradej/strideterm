<template>
  <div>
    <p class="templates-description">
      These templates appear when adding tabs to workspaces and in the quick-add (+) dropdown.
    </p>
    <div class="template-list">
      <div v-for="(template, index) in templates" :key="template.id || index" class="template-row">
        <span class="template-icon">{{ template.icon }}</span>
        <input
          v-model="template.title"
          placeholder="Title"
          maxlength="40"
          class="template-input"
          title="Tab title shown in the workspace tab bar and in the + Tab quick-add menu."
        />
        <input
          v-model="template.command"
          placeholder="Command"
          maxlength="500"
          class="template-input"
          title="Shell command run when this tab is activated. Leave empty for an interactive shell."
        />
        <button
          type="button"
          class="template-remove-btn"
          title="Remove this tab template from the list. Existing workspaces that already use it are unaffected."
          @click="templates.splice(index, 1)"
        >
          &times;
        </button>
      </div>
      <button
        type="button"
        class="button button--ghost add-template-btn"
        title="Add a new tab template — appears in the + Tab quick-add menu and in the New Workspace dialog."
        @click="addTemplate"
      >
        + Add template
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";

interface TabTemplate {
  id?: string;
  title?: string;
  command?: string;
  icon?: string;
}

const templates = inject<TabTemplate[]>("settingsTemplates")!;

function addTemplate() {
  templates.push({ id: `tmpl-${Date.now()}`, title: "", command: "", icon: "\u{1F4BB}" });
}
</script>

<style scoped>
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
</style>
