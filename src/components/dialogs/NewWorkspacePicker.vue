<template>
  <div class="dialog" style="width: min(540px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">New Workspace</p>
        <h2>Choose a template</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <div style="display: grid; gap: 8px; margin-top: 14px">
      <button
        type="button"
        class="project"
        style="--accent: #ffa424; border: 1px solid var(--border); cursor: pointer"
        title="Open the workspace editor with no preset — pick a working directory, name, and tab list manually. The most flexible option."
        @click="emit('pick-empty')"
      >
        <span class="project__badge" style="background: rgba(255, 164, 36, 0.24); font-size: 16px">+</span>
        <span class="project__meta">
          <span class="project__title-row"><strong>Empty Workspace</strong></span>
          <small style="color: var(--muted)">Start from scratch with a blank terminal workspace.</small>
        </span>
      </button>
      <button
        type="button"
        class="project"
        style="--accent: #7c4dff; border: 1px solid var(--border); cursor: pointer"
        title="Create a Worker + Judge agent task workspace — supervised AI loop that runs a Worker agent against a project, runs verification commands between rounds, and asks an independent Judge to confirm completion."
        @click="emit('pick-task')"
      >
        <span class="project__badge" style="background: rgba(124, 77, 255, 0.24); font-size: 16px">&#x1F916;</span>
        <span class="project__meta">
          <span class="project__title-row"><strong>Agent Task Runner</strong></span>
          <small style="color: var(--muted)"
            >Worker + Judge dual-agent workspace with automated verification loop.</small
          >
        </span>
      </button>
      <button
        v-for="plugin in pluginsWithTemplates"
        :key="plugin.id"
        type="button"
        class="project"
        :style="`--accent:${plugin.color};border:1px solid var(--border);cursor:pointer;`"
        :title="`Materialise the ${plugin.name} plugin's workspace template${plugin.description ? ' — ' + plugin.description : ''}.`"
        @click="emit('pick-plugin', plugin.id)"
      >
        <span class="project__badge">{{ plugin.icon }}</span>
        <span class="project__meta">
          <span class="project__title-row"
            ><strong>{{ plugin.name }}</strong></span
          >
          <small style="color: var(--muted)">{{ plugin.description || "Plugin workspace template" }}</small>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

interface PluginEntry {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  description?: string;
  workspaceDefaults?: unknown;
  error?: unknown;
}

interface Props {
  plugins?: PluginEntry[];
}

const props = withDefaults(defineProps<Props>(), {
  plugins: () => [],
});

const emit = defineEmits<{
  "pick-empty": [];
  "pick-plugin": [id: string];
  "pick-task": [];
  cancel: [];
}>();

const pluginsWithTemplates = computed(() => props.plugins.filter((p) => p.workspaceDefaults && !p.error));
</script>
