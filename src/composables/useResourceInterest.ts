import { watch, onScopeDispose } from "vue";
import { useAppStore } from "../stores/app.js";
import { useRemoteDetailsStore } from "../stores/remote-details.js";

/**
 * Declare interest in one or more slim-core detail resources for as long as the
 * calling component (or its computed key) is mounted. On the remote transport
 * this drives the WS resource:interest → resource:invalidate → fetch pipeline;
 * on desktop it is a no-op (the data is already in the full IPC payload).
 *
 * `resourceKey` is a reactive getter returning the resource key(s) the caller
 * currently renders (e.g. `git:<workspaceId>`, `azure-pr:<prKey>`, `docker`), or
 * null/[]/"" when it renders none. Interest follows the key: it moves when the
 * key changes (tab switch, grid cell reassignment) and clears on unmount. The
 * store ref-counts across callers, so several visible grid cells rendering the
 * same resource keep it interested until the last unmounts.
 */
export function useResourceInterest(resourceKey: () => string | string[] | null | undefined): void {
  const appStore = useAppStore();
  if (!appStore.isRemoteTransport) return;
  const details = useRemoteDetailsStore();
  let current: string[] = [];

  function apply(next: string[]): void {
    for (const r of next) if (!current.includes(r)) details.addInterest(r);
    for (const r of current) if (!next.includes(r)) details.removeInterest(r);
    current = next;
  }

  const stop = watch(
    resourceKey,
    (val) => {
      const arr = (Array.isArray(val) ? val : val ? [val] : []).filter((r): r is string => Boolean(r));
      apply(arr);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    apply([]);
    stop();
  });
}
