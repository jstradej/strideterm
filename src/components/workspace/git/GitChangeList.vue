<template>
  <section class="git-change-section">
    <p class="eyebrow">
      {{ title }} <strong>{{ files.length }}</strong>
    </p>
    <ul v-if="files.length" class="git-file-list">
      <li v-for="entry in visibleFiles" :key="entry.path">
        <div class="git-file-row">
          <button
            type="button"
            :class="['git-file', isSelected(entry) && 'git-file--active']"
            :title="`${statusTooltip(entry.code || entry.stagedStatus || entry.unstagedStatus)}: ${entry.path}`"
            @click="$emit('select', entry.path, scope)"
          >
            <span
              class="git-status-code"
              :title="statusTooltip(entry.code || entry.stagedStatus || entry.unstagedStatus)"
              >{{ entry.code || entry.stagedStatus || entry.unstagedStatus || "??" }}</span
            >
            <span class="git-file__name">
              <span v-if="dirOf(entry.path)" class="git-file__dir">{{ dirOf(entry.path) }}</span
              >{{ nameOf(entry.path) }}
            </span>
          </button>
          <button
            v-if="entry.code !== 'D' && entry.unstagedStatus !== 'D' && entry.stagedStatus !== 'D'"
            type="button"
            class="git-file__edit-btn"
            title="Open in external editor"
            @click.stop="$emit('open-editor', entry.path)"
          >
            &#x270E;
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="git-card__hint">No files.</p>
  </section>
</template>

<script setup>
import { computed } from "vue";
import { APP_CONFIG } from "../../../../config/app-config.js";

const STATUS_LABELS = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Unmerged",
  UU: "Both modified",
  "??": "Untracked",
  "!": "Ignored",
  T: "Type changed",
};

const props = defineProps({
  title: { type: String, required: true },
  scope: { type: String, required: true },
  files: { type: Array, default: () => [] },
  selectedDiff: { type: Object, default: null },
  workspaceId: { type: String, required: true },
});

defineEmits(["select", "open-editor"]);

const visibleFiles = computed(() => props.files.slice(0, APP_CONFIG.ui.recentGitEntriesVisible));

function statusTooltip(code) {
  return STATUS_LABELS[code] || STATUS_LABELS[code?.[0]] || code || "Unknown";
}
function nameOf(path) {
  return (
    String(path || "")
      .split("/")
      .pop() || path
  );
}
function dirOf(path) {
  const n = nameOf(path);
  return path.slice(0, -(n.length || 0));
}
function isSelected(entry) {
  return props.selectedDiff?.path === entry.path && props.selectedDiff?.scope === props.scope;
}
</script>
