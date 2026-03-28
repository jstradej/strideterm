<template>
  <Transition name="toast">
    <div
      v-if="visible"
      class="notification-toast"
      :class="`notification-toast--${toast?.kind || 'info'}`"
      @click="onClickToast"
    >
      <div class="notification-toast__icon">{{ kindIcon }}</div>
      <div class="notification-toast__content">
        <strong class="notification-toast__title">{{ toast?.title }}</strong>
        <p class="notification-toast__body">{{ toast?.body }}</p>
      </div>
      <button type="button" class="notification-toast__close" title="Dismiss" @click.stop="dismiss">&times;</button>
    </div>
  </Transition>
</template>

<script setup>
import { ref, watch, computed, onUnmounted } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";

const props = defineProps({
  toast: { type: Object, default: null },
});

const emit = defineEmits(["dismissed"]);
const notifStore = useNotificationStore();

const visible = ref(false);
let hideTimer = null;

const kindIcon = computed(() => {
  if (!props.toast) return "";
  if (props.toast.kind === "waiting") return "⏳";
  if (props.toast.kind === "completed") return "✅";
  return "🔔";
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
