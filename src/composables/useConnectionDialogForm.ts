import { ref } from "vue";
import { pickPath } from "../lib/pick-path.js";

/**
 * Draft/test/submit scaffolding used by ConnectionDialog.vue (Azure and
 * GitHub connection editing, parametrized by a `provider` prop): busy-flag
 * bookkeeping, the "Test connection" flow, the save-on-submit flow, and the
 * "Browse" directory picker. The dialog still owns its own draft shape,
 * template and field set per provider — this only factors out the identical
 * try/catch/finally plumbing around them.
 */
export function useConnectionDialogForm<TPayload, TVerification>(options: {
  draft: { reviewRoot: string };
  /** Read live (like the original inline handlers) rather than snapshotted once. */
  defaultReviewRoot: () => string;
  browseDirectory?: (initialPath: string) => Promise<unknown>;
  buildPayload: () => TPayload;
  verify: (payload: TPayload) => Promise<TVerification | null | undefined> | undefined;
  onSave: (payload: TPayload) => Promise<void> | undefined;
  providerLabel: string;
}) {
  const busy = ref(false);
  const errorMessage = ref("");
  const verification = ref<TVerification | null>(null);

  async function browseReviewRoot() {
    const browseDirectory = options.browseDirectory;
    if (!browseDirectory) return;
    const selected = await pickPath(() =>
      browseDirectory(options.draft.reviewRoot || options.defaultReviewRoot() || ""),
    );
    if (selected) options.draft.reviewRoot = selected;
  }

  async function testConnection() {
    busy.value = true;
    errorMessage.value = "";
    verification.value = null;
    try {
      verification.value = (await options.verify(options.buildPayload())) ?? null;
    } catch (err) {
      errorMessage.value = (err as Error)?.message || `${options.providerLabel} connection test failed.`;
    } finally {
      busy.value = false;
    }
  }

  async function handleSubmit() {
    busy.value = true;
    errorMessage.value = "";
    try {
      await options.onSave(options.buildPayload());
    } catch (err) {
      errorMessage.value = (err as Error)?.message || `Saving ${options.providerLabel} connection failed.`;
      busy.value = false;
    }
  }

  return { busy, errorMessage, verification, browseReviewRoot, testConnection, handleSubmit };
}
