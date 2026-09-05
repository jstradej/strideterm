<template>
  <Transition name="toast">
    <div v-if="visible" class="notification-toast" :class="toastClasses" @click="onClickToast">
      <div class="notification-toast__icon">{{ kindIcon }}</div>
      <div class="notification-toast__content">
        <strong class="notification-toast__title">{{ toast?.title }}</strong>
        <p class="notification-toast__body">{{ toast?.body }}</p>
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
import { ref, watch, computed, onUnmounted } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";

interface Toast {
  id?: string;
  urgency?: string;
  kind?: string;
  category?: string;
  meta?: { kind?: string; provider?: string } | null;
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
