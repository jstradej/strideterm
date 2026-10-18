<template>
  <Transition name="toast">
    <div v-if="visible" class="notification-toast" :class="toastClasses" @click="onClickToast">
      <div class="notification-toast__icon">
        <svg
          v-if="isPullRequestToast"
          class="notification-toast__pr-icon"
          viewBox="0 0 16 16"
          role="img"
          :aria-label="`${toast?.meta?.provider === 'github' ? 'GitHub' : 'Azure DevOps'} pull request`"
        >
          <path
            fill="currentColor"
            d="M4.5 3.25a1.75 1.75 0 1 0-1 1.67v6.16a1.75 1.75 0 1 0 1.5 0V6.25h4.25A2.75 2.75 0 0 0 12 3.5v-.58a1.75 1.75 0 1 0-1.5 0v.58c0 .69-.56 1.25-1.25 1.25H5V4.92c.6-.25 1-.85 1-1.67Zm-.5 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm8.5-1a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5ZM4.25 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
          />
        </svg>
        <span v-else>{{ kindIcon }}</span>
      </div>
      <div class="notification-toast__content">
        <strong class="notification-toast__title">{{ toast?.title }}</strong>
        <span v-if="isPullRequestToast && toast?.meta?.draftState" class="notification-toast__pr-state">
          {{ toast.meta.draftState === "draft" ? "Draft" : "Ready" }}
        </span>
        <p class="notification-toast__body">{{ toast?.body }}</p>
        <button
          v-if="canStartReview"
          type="button"
          class="notification-toast__review-action"
          :disabled="
            reviewAction.isStarting(toast?.meta || {}) ||
            Boolean(reviewAction.recordFor(toast?.meta || {})?.operationId)
          "
          @click.stop="startReview"
        >
          {{ reviewActionLabel }}
        </button>
        <p
          v-if="canStartReview && reviewAction.recordFor(toast?.meta || {})?.error"
          class="notification-toast__review-error"
          role="alert"
        >
          {{ reviewAction.recordFor(toast?.meta || {})?.error }}
        </p>
      </div>
      <button
        type="button"
        class="notification-toast__close"
        title="Hide this toast — the alert stays in the notification history panel so you can act on it later."
        @click.stop="dismiss"
      >
        &times;
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, computed, onUnmounted, inject } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";
import { isStartReviewTarget, usePullRequestReviewAction } from "../../composables/usePullRequestReviewAction.js";

interface Toast {
  id?: string;
  urgency?: string;
  kind?: string;
  category?: string;
  meta?: {
    kind?: string;
    reviewActionKind?: string;
    provider?: string;
    draftState?: string;
    prKey?: string;
    profileId?: string;
    headSha?: string;
  } | null;
  title?: string;
  body?: string;
  /** Thread this toast belongs to — `workspaceId:viewId`, see notification store. */
  viewId?: string;
  /** Backend identity of the alert this toast was built from, when it had one. */
  sourceAlertId?: string;
}

const props = withDefaults(
  defineProps<{
    toast?: Toast | null;
  }>(),
  {
    toast: null,
  },
);

const emit = defineEmits<{
  (e: "dismissed"): void;
}>();
const notifStore = useNotificationStore();
const appStore = useAppStore();
const api = inject<Transport>(apiKey) ?? null;
const reviewAction = usePullRequestReviewAction();

const visible = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

// A question keeps its own glyph even at urgent urgency: 🚨 is the
// "something is on fire" marker shared by rate limits and dead pipelines, and
// "the agent is asking you something" reads better as ❓.
const isQuestion = computed(() => props.toast?.kind === "question");

const kindIcon = computed(() => {
  if (!props.toast) return "";
  if (isQuestion.value) return "❓";
  if (props.toast.urgency === "urgent") return "🚨";
  if (props.toast.kind === "error") return "❌";
  if (props.toast.kind === "review" && props.toast.meta?.kind === "connection-error") return "🔌";
  if (props.toast.kind === "review") return "💬";
  // Agent task finishing its judge loop gets the checkered flag.
  if (props.toast.category === "task" && props.toast.kind === "completed") return "🏁";
  if (props.toast.kind === "waiting") return "⏳";
  if (props.toast.kind === "completed") return "✅";
  return "🔔";
});

const isPullRequestToast = computed(() => {
  const kind = props.toast?.meta?.reviewActionKind || props.toast?.meta?.kind;
  return props.toast?.category === "review" && (kind === "pr-new" || kind === "pr-ready");
});
const canStartReview = computed(() => isPullRequestToast.value && isStartReviewTarget(props.toast?.meta));
const reviewActionLabel = computed(() => {
  const record = props.toast?.meta ? reviewAction.recordFor(props.toast.meta) : undefined;
  if (record?.operationId) return "Review starting…";
  if (props.toast?.meta && reviewAction.isStarting(props.toast.meta)) return "Starting…";
  return record?.error ? "Retry basic review" : "Start basic review";
});

async function startReview(): Promise<void> {
  if (!props.toast?.meta || !api) return;
  try {
    const record = await reviewAction.start(props.toast.meta, api);
    const outcome = record?.outcome;
    if (outcome && "result" in outcome && record) {
      const workspaceId = String(outcome.result.workspaceId || outcome.workspaceId || "");
      const profileId = String(outcome.profileId || record.profileId || "default");
      if (workspaceId && profileId === (appStore.myActiveProfileId || "default")) {
        let exists = appStore.payload?.appState?.workspaces?.some((workspace) => workspace.id === workspaceId) || false;
        if (!exists && api.getState) {
          const state = await api.getState();
          if ("appState" in state) appStore.adoptPayload(state as StatePayload);
          exists = appStore.payload?.appState?.workspaces?.some((workspace) => workspace.id === workspaceId) || false;
        }
        if (exists) {
          await appStore.activateWorkspaceInGrid(workspaceId);
          reviewAction.markNavigated(record.operationId || "");
        }
      }
    }
  } catch (error) {
    notifStore.showError("Could not start review", error, {
      profileId: String(props.toast.meta.profileId || ""),
    });
  }
}

const toastClasses = computed(() => {
  const kind = props.toast?.kind || "info";
  const classes = [`notification-toast--${kind}`];
  if (props.toast?.urgency === "urgent") classes.push("notification-toast--urgent");
  // Review notifications may further carry a provider-specific class when the
  // session was tagged with meta.provider (added by useReviewNotifications).
  if (kind === "review") {
    const provider = props.toast?.meta?.provider;
    if (provider === "azure-devops") classes.push("notification-toast--review-azure");
    else if (provider === "github") classes.push("notification-toast--review-github");
  }
  return classes;
});

function dismiss() {
  visible.value = false;
  clearTimeout(hideTimer);
  emit("dismissed");
}

function onClickToast() {
  notifStore.togglePanel();
  dismiss();
}

watch(
  () => props.toast,
  (next) => {
    if (!next) return;
    clearTimeout(hideTimer);
    visible.value = true;
    // A question blocks the agent until it is answered, so its toast must not
    // time out from under the user — it goes away on click, on the close
    // button, or when the backend alert clears (see the watch below).
    if (next.kind === "question") return;
    hideTimer = setTimeout(() => {
      visible.value = false;
      emit("dismissed");
    }, 5000);
  },
);

// A sticky question toast still has to disappear once ITS question is gone.
//
// Tracked by alert id, not by the thread's state. The backend keeps one alert
// per panel, so a second question REPLACES the first: the thread stays
// "waiting", and a toast watching the thread would sit there showing a
// question nobody is being asked any more while the live one waits in the
// queue behind it. The alert's own id disappears from the payload in both
// cases — answered, or replaced — which is exactly the signal wanted here.
//
// A toast with no alert id (a legacy payload, a hand-built one) keeps the old
// thread-state rule; it is a degraded fallback, not a second identity.
watch(
  () => {
    if (!props.toast || !isQuestion.value) return undefined;
    const alertId = props.toast.sourceAlertId;
    if (alertId) return notifStore.liveAlertIds.includes(alertId) ? "waiting" : "gone";
    return notifStore.sessions.find((s) => s.viewId && s.viewId === props.toast?.viewId)?.state;
  },
  (state) => {
    if (!state || state === "waiting") return;
    dismiss();
  },
);

onUnmounted(() => clearTimeout(hideTimer));
</script>
