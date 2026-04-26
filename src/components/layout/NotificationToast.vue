<template>
  <Transition name="toast">
    <div v-if="visible" class="notification-toast" :class="toastClasses" @click="onClickToast">
      <div class="notification-toast__icon">{{ kindIcon }}</div>
      <div class="notification-toast__content">
        <strong class="notification-toast__title">{{ toast?.title }}</strong>
        <p class="notification-toast__body">{{ toast?.body }}</p>
      </div>
      <button type="button" class="notification-toast__close" title="Dismiss" @click.stop="dismiss">&times;</button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, computed, onUnmounted } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";

interface Toast {
  urgency?: string;
  kind?: string;
  category?: string;
  meta?: { kind?: string; provider?: string };
  title?: string;
  body?: string;
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

const kindIcon = computed(() => {
  if (!props.toast) return "";
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
    hideTimer = setTimeout(() => {
      visible.value = false;
      emit("dismissed");
    }, 5000);
  },
);

onUnmounted(() => clearTimeout(hideTimer));
</script>
