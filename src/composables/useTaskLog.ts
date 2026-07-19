import { ref, computed, watch } from "vue";
import type { Transport } from "../transport.js";

export interface TaskLogProps {
  workspaceCwd?: string;
  taskId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  taskState?: Record<string, any> | null;
}

/**
 * Loads and parses TASK_LOG.jsonl for the Task Dashboard's Status and Log
 * tabs. Both tabs render the same underlying event stream (Status shows a
 * per-round tail, Log shows the full history), so the fetch/parse logic and
 * the watch that keeps it fresh were duplicated between the two components —
 * including a drift bug where the Log tab's copy was missing event types the
 * Status tab already knew about (see task-log-labels.ts). Extracted here so
 * both tabs share one implementation.
 */
export function useTaskLog(api: Transport | null | undefined, props: TaskLogProps) {
  const logRaw = ref<string>("");

  async function loadLog() {
    if (!api?.fileRead || !props.workspaceCwd || !props.taskId) return;
    try {
      const result = await api.fileRead({
        rootPath: props.workspaceCwd,
        relativePath: `.strideterm/tasks/${props.taskId}/TASK_LOG.jsonl`,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logRaw.value = (result as any)?.content ?? "";
    } catch {
      logRaw.value = "";
    }
  }

  const logEntries = computed(() => {
    if (!logRaw.value) return [];
    return logRaw.value
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter(Boolean) as Record<string, any>[];
  });

  // Single watch covering every trigger the two tabs previously polled via
  // 3-4 separate `watch()` calls each: task state, current round, round
  // count, and the initial/task-switch load.
  watch(
    [
      () => props.taskState?.state,
      () => props.taskState?.currentRound,
      () => props.taskState?.rounds?.length,
      () => props.taskId,
    ],
    ([, , , id]) => {
      if (id) loadLog();
    },
    { immediate: true },
  );

  return { logRaw, logEntries, loadLog };
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}
