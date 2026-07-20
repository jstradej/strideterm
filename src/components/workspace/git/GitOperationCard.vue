<template>
  <article v-if="shouldRender" class="git-card" data-testid="operation-card">
    <div class="section-head">
      <div>
        <p class="eyebrow">Operation Status</p>
        <h3>{{ heading }}</h3>
      </div>
    </div>

    <!-- Busy banner — a git action is running right now (spinner + live phase) -->
    <template v-if="busyAction">
      <div class="git-operation-banner git-operation-banner--busy" data-testid="operation-busy">
        <div class="git-operation-busy">
          <span class="git-spinner" aria-hidden="true"></span>
          <strong>{{ busyPhase }}</strong>
        </div>
        <!-- Live streamed output (push/force-push, incl. pre-push hook) so a
             slow/blocking hook shows what it's doing instead of a mute spinner. -->
        <pre
          v-if="isPushAction && pushProgress"
          ref="pushProgressEl"
          class="git-output git-output--live"
          data-testid="push-progress"
          >{{ pushProgress }}</pre>
      </div>
    </template>

    <!-- Active operation banner -->
    <template v-if="operation.inProgress">
      <div class="git-operation-banner git-operation-banner--warning" data-testid="operation-in-progress">
        <strong>{{ operation.label || "Git operation in progress" }}</strong>
        <p v-if="operation.details">{{ operation.details }}</p>
        <div class="git-operation-actions">
          <button v-if="operation.conflicts?.length" type="button" class="button" @click="openConflictDialog">
            Resolve conflicts… ({{ operation.conflicts.length }})
          </button>
          <button
            v-if="operation.canContinue && !operation.conflicts?.length"
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
        <div v-if="result.conflicts?.length" class="git-operation-actions">
          <button type="button" class="button button--small" @click="openConflictDialog">
            Resolve conflicts… ({{ result.conflicts.length }})
          </button>
        </div>
        <pre v-if="result.rawOutput" class="git-output">{{ result.rawOutput }}</pre>
      </div>
    </template>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi?: Record<string, any>;
  }>(),
  { gitUi: () => ({}) },
);

const gitUiStore = useGitUiStore();

const operation = computed(() => props.snapshot.operationState || {});
const result = computed(() => props.gitUi.lastResult || null);
const busyAction = computed(() => String(props.gitUi.busyAction || ""));
const busyPhase = computed(() => String(props.gitUi.busyPhase || "Working…"));
const pushProgress = computed(() => String(props.gitUi.pushProgress || ""));
const isPushAction = computed(() => busyAction.value === "push" || busyAction.value === "force-push");

// Keep the live output pinned to the newest line as chunks stream in.
const pushProgressEl = ref<HTMLElement | null>(null);
watch(pushProgress, async () => {
  await nextTick();
  const el = pushProgressEl.value;
  if (el) el.scrollTop = el.scrollHeight;
});

const shouldRender = computed(() => !!busyAction.value || operation.value.inProgress || !!result.value);

const heading = computed(() => {
  if (busyAction.value) return "In progress";
  if (operation.value.inProgress) return operation.value.label || "In progress";
  if (result.value) return "Last result";
  return "Idle";
});

function openConflictDialog() {
  const rootPath = gitUiStore.getActiveRoot(props.workspaceId);
  gitUiStore.openConflictDialog(props.workspaceId, rootPath);
  gitUiStore.gitSwitchTab(props.workspaceId, "conflicts");
}
</script>
