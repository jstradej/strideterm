<template>
  <div class="workspace-pane__body workspace-pane__body--headless-judge">
    <section class="hj">
      <div class="hj__hero">
        <div>
          <div class="hj__eyebrow">GitHub Copilot judge</div>
          <h2 class="hj__title">Headless mode on Windows</h2>
          <p class="hj__summary">{{ summary }}</p>
        </div>
        <span class="hj__badge" :class="`hj__badge--${badgeTone}`">{{ badgeLabel }}</span>
      </div>

      <div class="hj__grid">
        <article class="hj__card">
          <h3>Why this pane exists</h3>
          <p>
            Copilot CLI's Windows terminal UI does not reliably accept injected PTY input for task-runner prompts, so
            strIDEterm runs the judge as a one-shot Copilot command and shows progress here instead of an idle terminal.
          </p>
        </article>

        <article class="hj__card">
          <h3>Current run</h3>
          <dl class="hj__meta">
            <div>
              <dt>Mode</dt>
              <dd>Headless Copilot</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{{ providerLabel }}</dd>
            </div>
            <div>
              <dt>Task state</dt>
              <dd>{{ stateLabel }}</dd>
            </div>
            <div>
              <dt>Judge activity</dt>
              <dd>{{ judgeActivityLabel }}</dd>
            </div>
          </dl>
        </article>

        <article class="hj__card">
          <h3>Files</h3>
          <ul class="hj__files">
            <li>
              <code>{{ baseDir }}/JUDGE_INPUT.md</code> — prompt passed to Copilot
            </li>
            <li>
              <code>{{ baseDir }}/JUDGE_TODO.md</code> — judge audit scratchpad
            </li>
            <li>
              <code>{{ baseDir }}/verdict.json</code> — machine-read verdict
            </li>
          </ul>
        </article>

        <article class="hj__card">
          <h3>Where to watch</h3>
          <p>
            Use <strong>Dashboard → Log</strong> for live task-runner events and <strong>Dashboard → Status</strong> for
            the round timeline. This pane stays honest about the headless judge flow instead of showing a dead Copilot
            terminal.
          </p>
        </article>

        <article v-if="latestJudgeReason" class="hj__card hj__card--full">
          <h3>Latest judge result</h3>
          <p class="hj__reason">{{ latestJudgeReason }}</p>
        </article>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const props = defineProps({
  sessionId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const store = useAppStore();

const workspaceId = computed(() =>
  String(props.sessionId || "")
    .split(":")
    .slice(0, -1)
    .join(":"),
);

const workspace = computed(() => {
  const active = store.payload?.workspace?.workspace || store.payload?.workspace?.project || null;
  if (active?.id === workspaceId.value) return active;
  return (store.payload?.appState?.workspaces || []).find((entry) => entry.id === workspaceId.value) || null;
});

const taskState = computed(() => store.payload?.taskRunner?.[workspaceId.value] || workspace.value?.task || null);

const providerLabel = computed(() => {
  const config = taskState.value?.judgeProviderConfig || null;
  if (!config) return "GitHub Copilot";
  return config.model ? `GitHub Copilot (${config.model})` : "GitHub Copilot";
});

const stateLabel = computed(() => {
  const state = taskState.value?.state || "idle";
  if (state === "running") return "Worker running";
  if (state === "evaluating") return "Built-in checks";
  if (state === "judge-evaluating") return "Judge evaluating";
  if (state === "refreshing") return "Refreshing worker context";
  if (state === "completed") return "Completed";
  if (state === "failed") return "Failed";
  if (state === "paused") return "Paused";
  return "Idle";
});

const judgeActivityLabel = computed(() => {
  if (taskState.value?.judgeProgrammaticRunning) return "Copilot is reviewing in the background now";
  if (taskState.value?.state === "completed") return "Copilot finished and approved the task";
  if (taskState.value?.state === "failed") return "Copilot finished, but the task did not complete";
  if (taskState.value?.state === "paused") return "Waiting for resume";
  if (taskState.value?.state === "judge-evaluating") return "Launching Copilot judge";
  return "Ready for the next judge run";
});

const summary = computed(() => {
  if (taskState.value?.judgeProgrammaticRunning) {
    return "Copilot is actively evaluating the task in a background programmatic run.";
  }
  if (taskState.value?.state === "completed") {
    return "The last Copilot judge run finished successfully and returned a complete verdict.";
  }
  if (taskState.value?.state === "failed") {
    return "The last Copilot judge run finished, but the overall task is still marked failed.";
  }
  if (taskState.value?.state === "judge-evaluating") {
    return "The task runner has handed control to Copilot and is waiting for its verdict files.";
  }
  return "This judge tab uses a status view because Copilot is running headlessly on Windows.";
});

const badgeLabel = computed(() => {
  if (taskState.value?.judgeProgrammaticRunning) return "Running";
  if (taskState.value?.state === "completed") return "Done";
  if (taskState.value?.state === "failed") return "Needs attention";
  if (taskState.value?.state === "paused") return "Paused";
  return "Ready";
});

const badgeTone = computed(() => {
  if (taskState.value?.judgeProgrammaticRunning) return "running";
  if (taskState.value?.state === "completed") return "success";
  if (taskState.value?.state === "failed") return "error";
  if (taskState.value?.state === "paused") return "paused";
  return "idle";
});

const baseDir = computed(() =>
  taskState.value?.taskId ? `.strideterm/tasks/${taskState.value.taskId}` : ".strideterm/tasks/<task-id>",
);

const latestRound = computed(() => {
  const rounds = taskState.value?.rounds || [];
  return rounds.length ? rounds[rounds.length - 1] : null;
});

const latestJudgeReason = computed(() => latestRound.value?.judgeReason || "");
</script>

<style scoped>
.workspace-pane__body--headless-judge {
  padding: 16px;
  overflow: auto;
}

.hj {
  display: grid;
  gap: 16px;
}

.hj__hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 16px;
  border: 1px solid var(--color-border, #343434);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
}

.hj__eyebrow {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted, #a0a0a0);
  margin-bottom: 6px;
}

.hj__title {
  margin: 0 0 8px;
  font-size: 20px;
}

.hj__summary {
  margin: 0;
  color: var(--color-text-muted, #b0b0b0);
  max-width: 70ch;
}

.hj__badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.hj__badge--running {
  background: rgba(76, 175, 80, 0.16);
  color: #83d18a;
}

.hj__badge--success {
  background: rgba(76, 175, 80, 0.2);
  color: #9ae69e;
}

.hj__badge--error {
  background: rgba(244, 67, 54, 0.18);
  color: #ff8f88;
}

.hj__badge--paused,
.hj__badge--idle {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text, #ddd);
}

.hj__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.hj__card {
  border: 1px solid var(--color-border, #343434);
  border-radius: 12px;
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.02);
}

.hj__card--full {
  grid-column: 1 / -1;
}

.hj__card h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.hj__card p {
  margin: 0;
  color: var(--color-text-muted, #b0b0b0);
  line-height: 1.45;
}

.hj__meta {
  display: grid;
  gap: 10px;
  margin: 0;
}

.hj__meta div {
  display: grid;
  gap: 4px;
}

.hj__meta dt {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted, #9a9a9a);
}

.hj__meta dd {
  margin: 0;
}

.hj__files {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 8px;
  color: var(--color-text-muted, #b0b0b0);
}

.hj__files code,
.hj__reason {
  word-break: break-word;
}
</style>
