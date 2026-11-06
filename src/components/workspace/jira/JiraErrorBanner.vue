<template>
  <div v-if="error && !signInBannerDuplicate" ref="anchorRef" class="jira-error">
    <div class="jira-error__panel">
      <div class="jira-error__alert" role="alert">
        <p class="jira-error__message">
          {{ error }}
          <span v-if="errorStatus" class="jira-error__status">{{ jiraErrorLabel(errorStatus.code) }}</span>
        </p>
        <div class="jira-error__actions">
          <button
            v-if="errorStatus?.code === 'rate-limited'"
            class="button button--ghost button--small"
            type="button"
            title="Ask Jira again now instead of waiting. Jira may still refuse until its rate limit resets."
            @click="retryAndKeepFocus(retryAfterRateLimit)"
          >
            Retry now
          </button>
          <button
            v-if="restoreRetryable"
            class="button button--ghost button--small"
            type="button"
            title="Load the Jira connections again and restore this view."
            @click="retryAndKeepFocus(retryRestore)"
          >
            Retry
          </button>
          <button
            class="button button--ghost button--small"
            type="button"
            title="Hide this message without retrying."
            @click="dismiss"
          >
            Dismiss
          </button>
        </div>
      </div>
      <p
        v-if="errorStatus?.code === 'rate-limited' && rateLimitRemainingMs > 0"
        class="jira-error__countdown"
        aria-live="off"
      >
        {{ rateLimitAutoRetry ? "Retrying automatically in" : "You can try again in" }}
        {{ Math.ceil(rateLimitRemainingMs / 1000) }} s.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useJiraPaneContext } from "./pane/jira-pane-context.js";

const {
  clearPaneError,
  error,
  errorStatus,
  jiraErrorLabel,
  rateLimitAutoRetry,
  rateLimitRemainingMs,
  restoreRetryable,
  signInBannerDuplicate,
  retryAfterRateLimit,
  retryRestore,
} = useJiraPaneContext();

const anchorRef = ref<HTMLElement | null>(null);

/** The banner leaves the page once the retry starts; focus moves to the pane instead of falling back to the document. */
async function keepFocusInPane(pane: HTMLElement | null | undefined) {
  await nextTick();
  if (!pane || (document.activeElement && document.activeElement !== document.body)) return;
  pane.tabIndex = -1;
  pane.focus({ preventScroll: true });
}
function retryAndKeepFocus(retry: () => unknown) {
  const pane = anchorRef.value?.closest<HTMLElement>(".jira-inbox");
  void retry();
  void keepFocusInPane(pane);
}
function dismiss() {
  const pane = anchorRef.value?.closest<HTMLElement>(".jira-inbox");
  clearPaneError();
  void keepFocusInPane(pane);
}
</script>
