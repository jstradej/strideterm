import { ref } from "vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MonacoDiffPayload = Record<string, any>;

/**
 * Shared seq-guarded loader for MonacoDiffPanel's `payload` prop. `fetchThunk`
 * performs the actual API call for a given set of args; the composable adds:
 *  - a monotonic sequence guard so an out-of-order response (e.g. rapid
 *    clicking between files/commits) can't clobber a newer selection with a
 *    stale one
 *  - a uniform error payload shaped for MonacoDiffPanel when the fetch rejects
 *
 * Used by GitBranchesTab.vue (commit file diff) and GitChangesTab.vue
 * (working-tree file diff). AzureReviewPane.vue keeps its own copy for now —
 * unifying it is a follow-up (see the GitBranchesTab.vue extraction report).
 */
export function useMonacoDiffLoader<TArgs extends unknown[]>(
  fetchThunk: (...args: TArgs) => Promise<MonacoDiffPayload>,
  errorMessage = "Failed to load diff",
) {
  const payload = ref<MonacoDiffPayload | null>(null);
  const loading = ref(false);
  let seq = 0;

  async function load(...args: TArgs): Promise<void> {
    const mySeq = ++seq;
    loading.value = true;
    try {
      const result = await fetchThunk(...args);
      if (mySeq !== seq) return;
      payload.value = result;
    } catch (err) {
      if (mySeq !== seq) return;
      payload.value = {
        ok: false,
        leftError: (err as Error)?.message || errorMessage,
        leftContent: "",
        rightContent: "",
        leftLabel: "",
        rightLabel: "",
        leftMissing: true,
        rightMissing: true,
        language: "plaintext",
      };
    } finally {
      if (mySeq === seq) loading.value = false;
    }
  }

  return { payload, loading, load };
}
