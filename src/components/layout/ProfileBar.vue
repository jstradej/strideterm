<template>
  <div class="profile-bar-row">
    <button
      type="button"
      class="profile-bar"
      :style="`--profile-color:${profile.color || '#ffa424'}`"
      :title="`${profile.name} — click to open the Profiles dialog: switch the active profile, rename / colour profiles, or create a new one. The sidebar workspace list is filtered to the active profile.`"
      @click="$emit('click')"
    >
      {{ profile.name }}
      <span v-if="isRemote" class="profile-bar__remote-badge" title="Viewing in remote browser client">Remote</span>
      <span
        v-if="otherProfileCount > 0"
        class="profile-bar__other-attention"
        :title="`${otherProfileCount} alert${otherProfileCount === 1 ? '' : 's'} in other profile${otherProfileCount === 1 ? '' : 's'} — switch profiles to see them.`"
        >{{ otherProfileCount }}</span
      >
    </button>
    <span class="profile-bar__sep" aria-hidden="true"></span>
    <div class="profile-bar__search">
      <svg class="profile-bar__search-icon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <input
        v-model="query"
        type="text"
        class="profile-bar__search-input"
        placeholder="Filter…"
        spellcheck="false"
        aria-label="Filter workspaces by name"
        title="Filter the workspace list by name — matches anywhere in the name (case-insensitive). Esc clears."
        data-role="workspace-search"
        @keydown.esc.prevent="query = ''"
      />
      <button
        v-if="query"
        type="button"
        class="profile-bar__search-clear"
        title="Clear the workspace filter"
        aria-label="Clear workspace filter"
        @click="query = ''"
      >
        ✕
      </button>
    </div>
    <button
      type="button"
      class="profile-bar__view-toggle"
      :class="{ 'profile-bar__view-toggle--active': viewMode === 'recent' }"
      :aria-label="
        viewMode === 'recent' ? 'Switch to the manually ordered workspace tree' : 'Switch to the recently opened view'
      "
      :title="
        viewMode === 'recent'
          ? 'Showing recently opened workspaces, grouped by when you last opened them. Click to switch back to the manually ordered tree.'
          : 'Showing the manually ordered workspace tree. Click to switch to a view grouped by when you last opened each workspace.'
      "
      @click="toggleViewMode"
    >
      🕐
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";

const store = useAppStore();
const notifications = useNotificationStore();
const profile = computed(() => store.activeProfile);
const otherProfileCount = computed(() => store.otherProfileAttentionCount);
const isRemote = computed(() => store.getApi()?.isRemote ?? false);
const query = computed({
  get: () => store.workspaceSearchQuery,
  set: (value: string) => {
    store.workspaceSearchQuery = value;
  },
});

const viewMode = computed<"tree" | "recent">(() =>
  (store.activeProfile as { sidebarWorkspaceViewMode?: string } | null)?.sidebarWorkspaceViewMode === "recent"
    ? "recent"
    : "tree",
);

async function toggleViewMode(): Promise<void> {
  const next = viewMode.value === "recent" ? "tree" : "recent";
  await notifications.runWithToast("Switch workspace view failed", () => store.saveSidebarWorkspaceViewMode(next));
}

defineEmits<{
  (e: "click"): void;
}>();
</script>

<style scoped>
.profile-bar__remote-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 14px;
  padding: 0 5px;
  margin-left: 5px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--profile-color, #ffa424);
  border: 1px solid currentColor;
  border-radius: 3px;
  vertical-align: middle;
  opacity: 0.7;
}
.profile-bar__other-attention {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: var(--accent, #ffa424);
  border-radius: 8px;
  vertical-align: middle;
}
</style>
