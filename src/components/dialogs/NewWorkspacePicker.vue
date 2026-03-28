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
        class="project"
        style="--accent: #ffa424; border: 1px solid var(--border); cursor: pointer"
        @click="emit('pick-empty')"
      >
        <span class="project__badge" style="background: rgba(255, 164, 36, 0.24); font-size: 16px">+</span>
        <span class="project__meta">
          <span class="project__title-row"><strong>Empty Workspace</strong></span>
          <small style="color: var(--muted)">Start from scratch with a blank terminal workspace.</small>
        </span>
      </button>
      <button
        v-for="plugin in pluginsWithTemplates"
        :key="plugin.id"
        class="project"
        :style="`--accent:${plugin.color};border:1px solid var(--border);cursor:pointer;`"
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

<script setup>
import { computed } from "vue";

const props = defineProps({
  plugins: { type: Array, default: () => [] },
});

const emit = defineEmits(["pick-empty", "pick-plugin", "cancel"]);

const pluginsWithTemplates = computed(() => props.plugins.filter((p) => p.workspaceDefaults && !p.error));
</script>
