<template>
  <article class="git-card">
    <div class="section-head">
      <div>
        <p class="eyebrow">Operation Status</p>
        <h3>{{ heading }}</h3>
      </div>
    </div>

    <!-- Pending confirm banner -->
    <template v-if="pending">
      <div class="git-operation-banner git-operation-banner--confirm">
        <strong>{{ pendingLines[0] || "" }}</strong>
        <p v-for="(line, i) in pendingLines.slice(1)" :key="i">{{ line }}</p>
        <div class="git-operation-actions">
          <button type="button" class="button" @click="gitUiStore.gitConfirmAction(workspaceId)">Confirm</button>
          <button type="button" class="button button--ghost" @click="gitUiStore.clearPendingGitAction(workspaceId)">
            Cancel
          </button>
        </div>
      </div>
    </template>

    <!-- Active operation banner -->
    <template v-if="operation.inProgress">
      <div class="git-operation-banner git-operation-banner--warning">
        <strong>{{ operation.label || "Git operation in progress" }}</strong>
        <p v-if="operation.details">{{ operation.details }}</p>
        <small v-if="operation.conflicts?.length">{{ operation.conflicts.join(", ") }}</small>
        <div class="git-operation-actions">
          <button
            v-if="operation.canContinue"
            type="button"
            class="button"
            @click="gitUiStore.gitContinue(workspaceId)"
          >
            Continue
          </button>
          <button
            v-if="operation.canAbort"
            type="button"
            class="button button--ghost danger"
            @click="gitUiStore.gitAbort(workspaceId)"
          >
            Abort
          </button>
          <button type="button" class="button button--ghost" @click="gitUiStore.openLazygit(workspaceId)">
            Open Lazygit
          </button>
        </div>
      </div>
    </template>

    <!-- Last result banner -->
    <template v-if="result">
      <div :class="['git-operation-banner', `git-operation-banner--${result.ok ? 'ok' : 'error'}`]">
        <div class="section-head">
          <strong>{{ result.summary || (result.ok ? "Git action completed." : "Git action failed.") }}</strong>
          <button type="button" class="button button--ghost" @click="gitUiStore.gitClearResult(workspaceId)">
            Clear
          </button>
        </div>
        <ul v-if="result.warnings?.length" class="git-inline-list">
          <li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li>
        </ul>
        <p v-if="result.conflicts?.length" class="git-card__hint">Conflicts: {{ result.conflicts.join(", ") }}</p>
        <pre v-if="result.rawOutput" class="git-output">{{ result.rawOutput }}</pre>
      </div>
    </template>

    <template v-if="!operation.inProgress && !result && !pending">
      <p class="git-card__hint">No merge, rebase, cherry-pick, or bisect is currently running.</p>
    </template>
  </article>
</template>

<script setup>
import { computed } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";

const props = defineProps({
  snapshot: { type: Object, required: true },
  workspaceId: { type: String, required: true },
  gitUi: { type: Object, default: () => ({}) },
});

const gitUiStore = useGitUiStore();

const operation = computed(() => props.snapshot.operationState || {});
const pending = computed(() => props.gitUi.pendingAction || null);
const result = computed(() => props.gitUi.lastResult || null);

const pendingLines = computed(() => String(pending.value?.message || "").split("\n"));

const heading = computed(() => {
  if (pending.value) return "Confirm action";
  if (operation.value.inProgress) return operation.value.label || "In progress";
  if (result.value) return "Last result";
  return "Idle";
});
</script>
