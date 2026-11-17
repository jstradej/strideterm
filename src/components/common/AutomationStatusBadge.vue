<template>
  <span class="automation-status" :class="`automation-status--${state}`" :data-state="state" :title="statusHelp[state]">
    <span
      v-if="state === 'running' || state === 'starting'"
      class="automation-status__spinner"
      aria-hidden="true"
    ></span>
    <span v-else-if="dot" class="automation-status__dot" aria-hidden="true"></span>
    <slot>{{ state.replaceAll("-", " ") }}</slot>
  </span>
</template>

<script setup lang="ts">
defineProps<{ state: string; dot?: boolean }>();
const statusHelp: Record<string, string> = {
  idle: "Enabled and waiting for the next scheduled time or matching event.",
  starting: "Preparing the workspace and starting the agent. The run time limit already applies.",
  running: "The agent is working. Open its terminal if it needs attention.",
  "awaiting-user":
    "The agent needs your answer. Check network requests or open its terminal. The run time limit still applies.",
  paused: "Global pause blocks new starts in all profiles. Runs already in progress continue.",
  disabled: "This automation cannot start until enabled. Check its dashboard for the reason.",
  succeeded: "The run completed. Open Result to see its saved summary and agent output when available.",
  failed: "The run failed. Open Details to inspect the reason and saved agent output.",
  "timed-out":
    "The run reached its maximum run time and was stopped, including any time spent waiting for your answer.",
  stopped: "The run was stopped. Future triggers can still start it if the automation remains enabled.",
  interrupted: "strIDEterm restarted before the run completed. This run is no longer active.",
  skipped: "The run did not start. Check the history reason for a missed slot, overlap, cooldown or another limit.",
};
</script>

<style scoped>
.automation-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 7px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  text-transform: capitalize;
}
.automation-status__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.automation-status--running,
.automation-status--starting {
  color: var(--status-running);
}
.automation-status--succeeded {
  color: var(--status-success);
}
.automation-status--awaiting-user,
.automation-status--paused {
  color: var(--status-paused);
}
.automation-status--interrupted,
.automation-status--stopped {
  color: var(--status-stopped);
}
.automation-status--failed,
.automation-status--timed-out {
  color: var(--status-failed);
}
.automation-status__spinner {
  flex: none;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: automation-spin 0.8s linear infinite;
}
@keyframes automation-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .automation-status__spinner {
    animation: none;
  }
}
</style>
