<template>
  <div class="dialog" style="width: min(560px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Task Agent Recovery</p>
        <h2>Unfinished agent tasks detected</h2>
      </div>
      <button type="button" class="button button--ghost" @click="skipAll">Close</button>
    </div>
    <div v-if="current" class="form">
      <p class="info-box info-box--warning">
        Task agent <strong>{{ current.workspaceName }}</strong> was running when strIDEterm was closed. We've switched
        the workspace into view so you can watch it spin back up.
      </p>

      <div class="recovery-item">
        <div class="recovery-item__header">
          <span class="recovery-item__name">{{ current.workspaceName }}</span>
          <span
            v-if="profileFor(current.profileId)"
            class="recovery-item__profile"
            :style="`--profile-color: ${profileFor(current.profileId)?.color || '#ffa424'}`"
          >
            {{ profileFor(current.profileId)?.name }}
          </span>
          <span class="recovery-item__meta">
            Round {{ current.currentRound }}/{{ current.maxRounds }} &middot;
            {{ stateLabel(current.previousState) }}
          </span>
        </div>
        <p v-if="originalTotal > 1" class="recovery-item__progress">Task {{ position }} of {{ originalTotal }}</p>
      </div>

      <footer class="dialog__footer" style="gap: 8px; flex-wrap: wrap">
        <button
          type="button"
          class="button button--ghost"
          :disabled="busy"
          title="Leave this task in the paused state — control files stay on disk so you can inspect or resume it manually later from the Dashboard."
          @click="decide('skip')"
        >
          Skip
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="busy"
          title="Wipe the round history and return to idle — the next Start re-runs from round 1. Control files (TASK.md, JUDGE_PROMPT.md) stay on disk."
          @click="decide('fresh')"
        >
          Restart
        </button>
        <button
          type="button"
          class="button"
          :disabled="busy"
          title="Spawn a fresh agent process and inject an orientation prompt so it picks up where the previous one left off (TODO/HANDOFF/WORK_LOCK on disk)."
          @click="decide('continue')"
        >
          {{ busy ? "Resuming…" : "Resume" }}
        </button>
        <span style="flex: 1"></span>
        <button
          v-if="total > 1"
          type="button"
          class="button button--ghost"
          :disabled="busy"
          title="Apply Skip to every remaining recovery candidate — leaves them all paused with on-disk state intact."
          @click="skipAll"
        >
          Skip all
        </button>
        <button
          v-if="total > 1"
          type="button"
          class="button button--ghost"
          :disabled="busy"
          title="Apply Resume to every remaining recovery candidate — spawns fresh agents for each and dismisses the dialog."
          @click="resumeAll"
        >
          Resume all
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import type { RecoveryCandidate } from "../../../electron/shared/types/state.js";

interface Props {
  onClose?: () => void;
}

const props = withDefaults(defineProps<Props>(), {
  onClose: undefined,
});

const store = useAppStore();
const notifications = useNotificationStore();
const busy = ref(false);

// The candidate list is reactive on the store — every call to resolveTaskRecovery
// trims it. We always show the head of the list. When it empties, we close.
const candidates = computed<RecoveryCandidate[]>(() => store.recoveryCandidates as RecoveryCandidate[]);
const current = computed<RecoveryCandidate | null>(() => candidates.value[0] || null);
const total = computed(() => candidates.value.length);
// "Task N of M" — N is the user's mental position, which is total-original minus
// what's left + 1. Snapshot the original total at first render so position
// counts up as decisions get made and the queue trims.
const originalTotal = ref(candidates.value.length);
const position = computed(() => Math.max(1, originalTotal.value - candidates.value.length + 1));

interface ProfileInfo {
  id: string;
  name: string;
  color?: string;
}

function profileFor(profileId: string): ProfileInfo | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload profile shape is open-ended
  const profiles = ((store.payload as any)?.appState?.profiles || []) as ProfileInfo[];
  if (profileId === "default" && !profiles.find((p) => p.id === "default")) return null;
  return profiles.find((p) => p.id === profileId) || null;
}

function stateLabel(state: string): string {
  if (state === "judge-evaluating") return "Judge evaluating";
  if (state === "evaluating") return "Evaluating";
  if (state === "refreshing") return "Refreshing";
  return "Worker running";
}

// Switch the active workspace to the candidate currently being decided.
// Why: the user's whole point of the dialog is to *see* the task come back to
// life — if we leave them on whatever workspace was active before, Resume
// looks like nothing happens. activateWorkspace is best-effort; failures
// (e.g. workspace was deleted between sessions) shouldn't block the dialog.
async function activateCurrent(): Promise<void> {
  if (!current.value) return;
  try {
    await store.activateWorkspace(current.value.workspaceId);
  } catch {
    // ignore — the dialog still works without the visual context switch
  }
}

onMounted(() => {
  void activateCurrent();
});

watch(current, (next, prev) => {
  // When the head of the queue changes (next candidate revealed), pull that
  // workspace into view too. Skip on first mount — onMounted handles it.
  if (next && prev && next.workspaceId !== prev.workspaceId) {
    void activateCurrent();
  }
  // Empty queue = work is done.
  if (!next && originalTotal.value > 0) {
    props.onClose?.();
  }
});

async function decide(choice: "continue" | "fresh" | "skip"): Promise<void> {
  if (!current.value || busy.value) return;
  const id = current.value.workspaceId;
  busy.value = true;
  try {
    await notifications.runWithToast("Task recovery decision failed", () => store.resolveTaskRecovery({ [id]: choice }));
  } finally {
    busy.value = false;
  }
  // The watcher above closes the dialog when the queue empties.
}

async function skipAll(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const decisions: Record<string, "skip"> = {};
    for (const c of candidates.value) decisions[c.workspaceId] = "skip";
    await notifications.runWithToast("Skip all failed", () => store.resolveTaskRecovery(decisions));
  } finally {
    busy.value = false;
  }
}

async function resumeAll(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const decisions: Record<string, "continue"> = {};
    for (const c of candidates.value) decisions[c.workspaceId] = "continue";
    await notifications.runWithToast("Resume all failed", () => store.resolveTaskRecovery(decisions));
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.info-box--warning {
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  border: 1px solid rgba(255, 180, 50, 0.35);
  border-radius: 4px;
  padding: 10px 12px;
  background: rgba(255, 180, 50, 0.08);
  margin-bottom: 12px;
}

.recovery-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
}

.recovery-item__header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.recovery-item__name {
  font-weight: 600;
  font-size: 14px;
}

.recovery-item__meta {
  font-size: 12px;
  color: var(--text-muted);
}

.recovery-item__progress {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}

.recovery-item__profile {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
  background: color-mix(in srgb, var(--profile-color) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--profile-color) 45%, transparent);
  color: var(--profile-color);
}
</style>
