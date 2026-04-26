<template>
  <Transition name="toast">
    <div v-if="visible" class="return-banner" @click="openCenter">
      <span>⚠ {{ waitingCount }} session{{ waitingCount === 1 ? "" : "s" }} waiting for you</span>
      <button type="button" class="return-banner__action" @click.stop="openCenter">Show</button>
      <button type="button" class="return-banner__close" title="Dismiss" @click.stop="dismiss">&times;</button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * Plan § 3.3.4. When the window regains focus after >30s unfocused AND there
 * are sessions still in "waiting" state, surface a transient banner at the
 * top of the workspace for 8s. Clicking opens the notification center.
 */
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";

const notifStore = useNotificationStore();
const visible = ref(false);
let blurAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const waitingCount = computed(() => notifStore.waitingSessions.length);

function onFocus() {
  if (blurAt === 0 || Date.now() - blurAt < 30_000) return;
  blurAt = 0;
  if (waitingCount.value === 0) return;
  // Pinned dock already shows waiting sessions in-place — banner would be redundant.
  if (notifStore.pinned) return;
  show();
}
function onBlur() {
  blurAt = Date.now();
}

function show() {
  visible.value = true;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (visible.value = false), 8_000);
}

function dismiss() {
  visible.value = false;
  clearTimeout(hideTimer);
}

function openCenter() {
  visible.value = false;
  clearTimeout(hideTimer);
  if (!notifStore.panelOpen) notifStore.togglePanel();
}

onMounted(() => {
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
});
onUnmounted(() => {
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("blur", onBlur);
  clearTimeout(hideTimer);
});
</script>
