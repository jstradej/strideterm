<template>
  <Transition name="notif-panel">
    <aside v-if="notifStore.panelOpen" class="notification-center" @click.stop>
      <header class="notification-center__header">
        <h2 class="notification-center__title">Notifications</h2>
        <div class="notification-center__actions">
          <button
            v-if="notifStore.unreadCount > 0"
            type="button"
            class="notification-center__action"
            title="Mark all as read"
            @click="notifStore.markAllRead()"
          >
            Mark read
          </button>
          <button
            v-if="notifStore.items.length > 0"
            type="button"
            class="notification-center__action notification-center__action--danger"
            title="Clear all notifications"
            @click="notifStore.clearAll()"
          >
            Clear all
          </button>
          <button type="button" class="notification-center__close" title="Close" @click="notifStore.closePanel()">
            &times;
          </button>
        </div>
      </header>

      <div ref="bodyRef" class="notification-center__body">
        <div v-if="notifStore.items.length === 0" class="notification-center__empty">No notifications yet.</div>

        <TransitionGroup name="notif-item" tag="div" class="notification-center__list">
          <div
            v-for="item in notifStore.items"
            :key="item.id"
            class="notification-item"
            :class="{
              'notification-item--unread': !item.read,
              [`notification-item--${item.kind}`]: true,
            }"
            @click="onClickItem(item)"
          >
            <div class="notification-item__icon">{{ itemIcon(item) }}</div>
            <div class="notification-item__content">
              <div class="notification-item__head">
                <strong class="notification-item__title">{{ item.title }}</strong>
                <time class="notification-item__time" :title="item.at">{{ relativeTime(item.at) }}</time>
              </div>
              <p class="notification-item__body">{{ item.body }}</p>
            </div>
            <button
              type="button"
              class="notification-item__remove"
              title="Remove"
              @click.stop="notifStore.remove(item.id)"
            >
              &times;
            </button>
          </div>
        </TransitionGroup>
      </div>
    </aside>
  </Transition>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";

const notifStore = useNotificationStore();
const appStore = useAppStore();
const bodyRef = ref(null);

let tickTimer = null;
const tick = ref(0);

onMounted(() => {
  tickTimer = setInterval(() => {
    tick.value++;
  }, 30_000);
});

onUnmounted(() => clearInterval(tickTimer));

function relativeTime(isoString) {
  // Access tick to force reactivity updates
  void tick.value;
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function itemIcon(item) {
  if (item.kind === "waiting") return "⏳";
  if (item.kind === "completed") return "✅";
  return "🔔";
}

async function onClickItem(item) {
  notifStore.remove(item.id);
  if (!item.workspaceId || !appStore.payload) return;

  const ws = (appStore.payload.appState?.workspaces || []).find((w) => w.id === item.workspaceId);
  if (!ws) return;

  // Switch to the workspace first
  const activeWsId = appStore.payload.appState?.activeWorkspaceId;
  if (activeWsId !== item.workspaceId) {
    await appStore.activateWorkspace(item.workspaceId);
  }

  // Then activate the specific tab/view
  if (item.viewId) {
    appStore.activateView(item.viewId);
  }

  notifStore.closePanel();
}

function onClickOutside(event) {
  if (
    notifStore.panelOpen &&
    !event.target.closest(".notification-center") &&
    !event.target.closest("[data-role='notification-bell']")
  ) {
    notifStore.closePanel();
  }
}

onMounted(() => document.addEventListener("pointerdown", onClickOutside));
onUnmounted(() => document.removeEventListener("pointerdown", onClickOutside));
</script>
