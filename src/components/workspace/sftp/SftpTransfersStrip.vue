<template>
  <section v-if="runs.length" class="sftp-transfers" data-testid="sftp-transfers" aria-label="Transfers">
    <article
      v-for="run in runs"
      :key="run.transferId"
      class="sftp-transfer"
      :class="`sftp-transfer--${run.state}`"
      :data-testid="`sftp-transfer-${run.transferId}`"
    >
      <div class="sftp-transfer__head">
        <strong>{{ run.direction === "upload" ? "Upload" : "Download" }}</strong>
        <span class="sftp-transfer__state">{{ stateLabel(run) }}</span>
        <button
          v-if="run.state === 'running'"
          type="button"
          class="button button--sm button--ghost"
          title="Stop this transfer. Files already transferred stay where they are."
          data-testid="sftp-transfer-cancel"
          @click="emit('cancel', run.transferId)"
        >
          Cancel
        </button>
        <button
          v-else
          type="button"
          class="button button--sm button--ghost"
          title="Remove from this list"
          aria-label="Remove from this list"
          @click="emit('dismiss', run.transferId)"
        >
          ×
        </button>
      </div>
      <div
        v-if="run.state === 'running'"
        class="sftp-transfer__bar"
        role="progressbar"
        :class="{ 'sftp-transfer__bar--indeterminate': !run.bytesTotal }"
        :aria-valuenow="run.bytesTotal ? percent(run) : undefined"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="sftp-transfer__fill" :style="run.bytesTotal ? { width: `${percent(run)}%` } : undefined" />
      </div>
      <small class="sftp-transfer__detail" :title="skippedTitle(run)">{{ detail(run) }}</small>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { SshFileTransferRun } from "../../../../electron/shared/ssh-file-events.js";
import { describeTransfer, formatBytes, formatEta, formatSpeed } from "../../../stores/ssh-file-transfers.js";

const props = withDefaults(defineProps<{ runs: SshFileTransferRun[]; speeds?: Record<string, number> }>(), {
  speeds: () => ({}),
});
const emit = defineEmits<{
  cancel: [transferId: string];
  dismiss: [transferId: string];
}>();

function percent(run: SshFileTransferRun): number {
  return run.bytesTotal > 0 ? Math.min(100, Math.round((run.bytesDone / run.bytesTotal) * 100)) : 0;
}

function stateLabel(run: SshFileTransferRun): string {
  if (run.state === "running") return run.bytesTotal ? `${percent(run)}%` : "preparing…";
  return run.state === "succeeded" ? "done" : run.state;
}

function skippedTitle(run: SshFileTransferRun): string | undefined {
  const skipped = run.result?.skipped ?? [];
  if (!skipped.length) return undefined;
  const lines = skipped.slice(0, 20).map((item) => `${item.path} — ${item.reason}`);
  if (skipped.length > 20) lines.push(`… and ${skipped.length - 20} more`);
  return lines.join("\n");
}

function detail(run: SshFileTransferRun): string {
  if (run.state === "running") {
    const currentPath = run.currentPath ? ` · ${run.currentPath}` : "";
    if (!run.bytesTotal) return `Counting files…${currentPath}`;
    const files = run.filesTotal ? `${run.filesDone}/${run.filesTotal} files · ` : "";
    const speed = props.speeds[run.transferId] ?? 0;
    const speedPart = speed > 0 ? ` · ${formatSpeed(speed)}` : "";
    const etaPart =
      speed > 0 && run.bytesTotal > run.bytesDone ? ` · ${formatEta((run.bytesTotal - run.bytesDone) / speed)}` : "";
    return `${files}${formatBytes(run.bytesDone)} of ${formatBytes(run.bytesTotal)}${speedPart}${etaPart}${currentPath}`;
  }
  return describeTransfer(run);
}
</script>

<style scoped>
.sftp-transfers {
  flex: 0 0 auto;
  max-height: 34%;
  overflow: auto;
  border-top: 1px solid var(--border);
  background: var(--surface-pane-raised);
}

.sftp-transfer {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.sftp-transfer__head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sftp-transfer__state {
  flex: 1;
  color: var(--muted);
}

.sftp-transfer--failed .sftp-transfer__state {
  color: var(--danger);
}

.sftp-transfer__bar {
  position: relative;
  height: 4px;
  margin: 4px 0;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}

.sftp-transfer__fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s linear;
}

.sftp-transfer__bar--indeterminate .sftp-transfer__fill {
  position: absolute;
  top: 0;
  left: 0;
  width: 30%;
}

@media (prefers-reduced-motion: no-preference) {
  .sftp-transfer__bar--indeterminate .sftp-transfer__fill {
    animation: sftp-transfer-indeterminate 1.2s linear infinite;
  }
}

@keyframes sftp-transfer-indeterminate {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(333.333%);
  }
}

.sftp-transfer__detail {
  display: block;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
