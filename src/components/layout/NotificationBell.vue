<template>
  <button
    v-if="!notifStore.pinned"
    type="button"
    v-heartbeat="profileUnreadCount > 0"
    class="notification-bell"
    :class="{ 'notification-bell--has-unread': profileUnreadCount > 0 }"
    data-role="notification-bell"
    title="Open the notification panel — agent alerts, command-finished pings, PR review activity, and the Telegram bot status. The badge shows the unread count for this profile."
    @click="notifStore.togglePanel()"
  >
    🔔
    <span class="notification-bell__badge" :class="{ 'notification-bell__badge--visible': profileUnreadCount > 0 }">{{
      profileUnreadCount > 0 ? (profileUnreadCount > 9 ? "9+" : profileUnreadCount) : ""
    }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useNotificationProfileScope } from "../../composables/useNotificationProfileScope.js";
import { vHeartbeat } from "../../app/heartbeat-directive.js";

const notifStore = useNotificationStore();
const { sessionInActiveProfile } = useNotificationProfileScope();
const profileUnreadCount = computed(() => notifStore.unreadCountFor(sessionInActiveProfile));
</script>
