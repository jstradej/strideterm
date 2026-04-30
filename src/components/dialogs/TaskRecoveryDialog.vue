<template>
  <div class="dialog" style="width: min(560px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Task Agent Recovery</p>
        <h2>Unfinished agent tasks detected</h2>
      </div>
      <button type="button" class="button button--ghost" @click="skipAll">Close</button>
    </div>
    <div class="form">
      <p class="info-box info-box--warning">
        The following task agents were running when strIDEterm was closed. Choose how to handle each one.
      </p>

      <div v-for="c in candidates" :key="c.workspaceId" class="recovery-item">
        <div class="recovery-item__header">
          <span class="recovery-item__name">{{ c.workspaceName }}</span>
          <span
            v-if="profileFor(c.profileId)"
            class="recovery-item__profile"
            :style="`--profile-color: ${profileFor(c.profileId)?.color || '#ffa424'}`"
          >
            {{ profileFor(c.profileId)?.name }}
          </span>
          <span class="recovery-item__meta">
            Round {{ c.currentRound }}/{{ c.maxRounds }} &middot;
            {{ stateLabel(c.previousState) }}
          </span>
        </div>
        <div class="recovery-item__actions">
          <label class="radio-label" :class="{ selected: decisions[c.workspaceId] === 'continue' }">
            <input v-model="decisions[c.workspaceId]" type="radio" :name="c.workspaceId" value="continue" />
            Resume
            <span class="radio-label__hint">Continue from where it left off</span>
          </label>
          <label class="radio-label" :class="{ selected: decisions[c.workspaceId] === 'fresh' }">
            <input v-model="decisions[c.workspaceId]" type="radio" :name="c.workspaceId" value="fresh" />
            Restart
            <span class="radio-label__hint">Start the round from scratch</span>
          </label>
          <label class="radio-label" :class="{ selected: decisions[c.workspaceId] === 'skip' }">
            <input v-model="decisions[c.workspaceId]" type="radio" :name="c.workspaceId" value="skip" />
            Skip
            <span class="radio-label__hint">Leave task paused</span>
          </label>
        </div>
      </div>

      <footer class="dialog__footer" style="gap: 8px">
        <button type="button" class="button button--ghost" @click="skipAll">Skip all</button>
        <button type="button" class="button" :disabled="resolving" @click="confirm">
          {{ resolving ? "Resuming…" : "Confirm" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import type { RecoveryCandidate } from "../../../electron/shared/types/state.js";

interface Props {
  onClose?: () => void;
}

const props = withDefaults(defineProps<Props>(), {
  onClose: undefined,
});

const store = useAppStore();
const candidates = store.recoveryCandidates as RecoveryCandidate[];
const resolving = ref(false);

const decisions = reactive<Record<string, "continue" | "fresh" | "skip">>(
  Object.fromEntries(candidates.map((c) => [c.workspaceId, "continue"])),
);

interface ProfileInfo {
  id: string;
  name: string;
  color?: string;
}

function profileFor(profileId: string): ProfileInfo | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload profile shape is open-ended
  const profiles = ((store.payload as any)?.appState?.profiles || []) as ProfileInfo[];
  // Hide badge for the default profile — it's not informative on a single-profile setup
  if (profileId === "default" && !profiles.find((p) => p.id === "default")) return null;
  return profiles.find((p) => p.id === profileId) || null;
}

function stateLabel(state: string): string {
  if (state === "judge-evaluating") return "Judge evaluating";
  if (state === "evaluating") return "Evaluating";
  if (state === "refreshing") return "Refreshing";
  return "Worker running";
}

async function confirm(): Promise<void> {
  resolving.value = true;
  try {
    await store.resolveTaskRecovery(decisions);
  } finally {
    resolving.value = false;
    props.onClose?.();
  }
}

function skipAll(): void {
  for (const c of candidates) decisions[c.workspaceId] = "skip";
  store.resolveTaskRecovery(decisions).finally(() => props.onClose?.());
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

.recovery-item__actions {
  display: flex;
  gap: 8px;
}

.radio-label {
  display: flex;
  flex-direction: column;
  flex: 1;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 13px;
  gap: 2px;
  transition:
    border-color 0.1s,
    background 0.1s;
}

.radio-label.selected {
  border-color: var(--accent);
  background: rgba(var(--accent-rgb), 0.08);
}

.radio-label input {
  display: none;
}

.radio-label__hint {
  font-size: 11px;
  color: var(--text-muted);
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
