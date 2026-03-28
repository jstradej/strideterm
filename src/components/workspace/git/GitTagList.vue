<template>
  <div class="git-tags">
    <!-- Create tag form -->
    <div class="git-tags__create">
      <div class="git-detail-list">
        <span class="git-detail-list__row">
          <strong>New tag:</strong>
          <input
            v-model="newTagName"
            class="git-pr-form__input"
            type="text"
            placeholder="v1.0.0"
            style="flex: 1; min-width: 120px"
            @keydown.enter="onCreate"
          />
        </span>
        <span class="git-detail-list__row">
          <strong>Message:</strong>
          <input
            v-model="newTagMessage"
            class="git-pr-form__input"
            type="text"
            placeholder="Optional (creates annotated tag)"
            style="flex: 1; min-width: 120px"
            @keydown.enter="onCreate"
          />
        </span>
      </div>
      <div class="git-operation-actions">
        <button
          type="button"
          class="button"
          :disabled="!newTagName.trim() || !!gitUi.busyAction"
          title="Create a new git tag on the current commit. Add a message to create an annotated tag."
          @click="onCreate"
        >
          {{ gitUi.busyAction === "create-tag" ? "Creating..." : "Create Tag" }}
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="!!gitUi.busyAction || !tags.length"
          title="Push all local tags to the remote (git push origin --tags)"
          @click="onPushAll"
        >
          {{ gitUi.busyAction === "push-all-tags" ? "Pushing..." : "Push All Tags" }}
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="!!gitUi.busyAction || gitUi.tagsLoading"
          title="Reload tag list from the local repository"
          @click="onRefresh"
        >
          {{ gitUi.tagsLoading ? "Loading..." : "Refresh" }}
        </button>
      </div>
    </div>

    <!-- Operation result -->
    <div v-if="resultMessage" :class="['git-card__hint', resultIsError && 'git-card__hint--warning']">
      <p>{{ resultMessage }}</p>
      <pre v-if="resultDetail" class="git-tags__detail">{{ resultDetail }}</pre>
    </div>

    <!-- Tags list -->
    <p v-if="gitUi.tagsError" class="git-card__hint git-card__hint--warning">{{ gitUi.tagsError }}</p>
    <p v-if="gitUi.tagsLoading" class="git-card__hint">Loading tags...</p>
    <ul v-else-if="tags.length" class="git-tag-list">
      <li v-for="tag in tags" :key="tag.name" class="git-tag-item">
        <div class="git-tag-item__meta">
          <strong class="git-tag-item__name">{{ tag.name }}</strong>
          <span v-if="tag.annotated" class="workspace-chip" title="Tag with message and author info">annotated</span>
          <span v-else-if="tag.local" class="workspace-chip" title="Simple tag without message">lightweight</span>
          <span
            v-if="tag.local && tag.pushed"
            class="workspace-chip"
            style="background: var(--accent); color: var(--bg)"
            title="Tag exists both locally and on remote"
            >synced</span
          >
          <span
            v-else-if="!tag.local && tag.pushed"
            class="workspace-chip"
            style="background: var(--muted); color: var(--bg)"
            title="Tag exists only on remote, not fetched locally"
            >remote only</span
          >
          <span v-else class="workspace-chip workspace-chip--alert" title="Tag only exists locally, not yet pushed"
            >local only</span
          >
        </div>
        <div v-if="tag.message" class="git-tag-item__message">{{ tag.message }}</div>
        <div class="git-tag-item__info">
          <small v-if="tag.hash">{{ tag.hash }}</small>
          <small v-if="tag.author"> by {{ tag.author }}</small>
          <small v-if="tag.date"> on {{ formatDate(tag.date) }}</small>
          <small v-if="!tag.local" style="font-style: italic">Fetch to see details</small>
        </div>
        <div class="git-tag-item__actions">
          <button
            v-if="tag.local && !tag.pushed"
            type="button"
            class="button button--small"
            :disabled="!!gitUi.busyAction"
            title="Push this tag to remote (git push origin)"
            @click="onPushTag(tag.name)"
          >
            Push
          </button>
          <button
            v-if="tag.local"
            type="button"
            class="button button--ghost button--small"
            :disabled="!!gitUi.busyAction"
            title="Delete this tag locally (git tag -d)"
            @click="onDelete(tag)"
          >
            Delete local
          </button>
          <button
            v-if="tag.pushed"
            type="button"
            class="button button--ghost button--small button--danger"
            :disabled="!!gitUi.busyAction"
            title="Delete this tag from remote origin (git push origin :refs/tags/...)"
            @click="onDeleteRemote(tag)"
          >
            Delete remote
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="git-card__hint">No tags found. Create one above or fetch from remote.</p>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";

const props = defineProps({
  workspaceId: { type: String, required: true },
  gitUi: { type: Object, required: true },
});

const gitUiStore = useGitUiStore();

const newTagName = ref("");
const newTagMessage = ref("");
const resultMessage = ref("");
const resultDetail = ref("");
const resultIsError = ref(false);

const tags = computed(() => props.gitUi.tags || []);

// Watch lastResult for feedback from tag operations
watch(
  () => props.gitUi.lastResult,
  (result) => {
    if (result?.summary) {
      resultMessage.value = result.summary;
      resultDetail.value = result.rawOutput || "";
      resultIsError.value = !result.ok;
    }
  },
);

onMounted(() => {
  if (!tags.value.length && !props.gitUi.tagsLoading) {
    gitUiStore.gitListTags(props.workspaceId);
  }
});

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return value;
  }
}

function clearResult() {
  resultMessage.value = "";
  resultDetail.value = "";
  resultIsError.value = false;
}

function onCreate() {
  const name = newTagName.value.trim();
  if (!name) return;
  clearResult();
  gitUiStore.gitCreateTag(props.workspaceId, name, newTagMessage.value.trim());
  newTagName.value = "";
  newTagMessage.value = "";
}

function onPushTag(tagName) {
  clearResult();
  gitUiStore.gitPushTag(props.workspaceId, tagName);
}

function onPushAll() {
  clearResult();
  gitUiStore.gitPushAllTags(props.workspaceId);
}

function onDelete(tag) {
  clearResult();
  gitUiStore.gitDeleteTag(props.workspaceId, tag.name);
}

function onDeleteRemote(tag) {
  clearResult();
  gitUiStore.gitDeleteRemoteTag(props.workspaceId, tag.name);
}

function onRefresh() {
  clearResult();
  gitUiStore.gitListTags(props.workspaceId);
}
</script>

<style scoped>
.git-tags {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.git-tags__create {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.git-tag-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.git-tag-item {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--muted) 25%, transparent);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.git-tag-item__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.git-tag-item__name {
  font-size: 14px;
  color: var(--fg);
}

.git-tag-item__message {
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
}

.git-tag-item__info {
  font-size: 11px;
  color: var(--muted);
  display: flex;
  gap: 4px;
}

.git-tag-item__actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

.git-tags__detail {
  margin: 6px 0 0;
  padding: 8px;
  font-size: 11px;
  line-height: 1.4;
  background: color-mix(in srgb, var(--bg) 80%, var(--muted));
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
}
</style>
