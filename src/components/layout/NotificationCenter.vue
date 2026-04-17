<template>
  <Transition name="notif-panel">
    <aside
      v-if="notifStore.panelOpen"
      ref="panelRef"
      class="notification-center"
      tabindex="0"
      @click.stop
      @keydown="onKeydown"
    >
      <header class="notification-center__header">
        <h2 class="notification-center__title">Notifications</h2>
        <div class="notification-center__actions">
          <button
            v-if="notifStore.unreadCount > 0 || notifStore.finishedSessions.length > 0"
            type="button"
            class="notification-center__action"
            title="Acknowledge all finished"
            @click="notifStore.markAllRead()"
          >
            Ack finished
          </button>
          <button
            v-if="notifStore.sessions.length > 0"
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
        <div v-if="notifStore.sessions.length === 0" class="notification-center__empty">No notifications yet.</div>

        <!-- Needs input — live alerts the user should act on -->
        <section v-if="visibleWaiting.length > 0" class="notif-section">
          <h3 class="notif-section__title">
            <span>Needs input</span>
            <span class="notif-section__count">{{ visibleWaiting.length }}</span>
          </h3>
          <div class="notification-center__list">
            <div
              v-for="(s, idx) in visibleWaiting"
              :key="s.id"
              class="notification-item"
              :class="itemClass(s, 'waiting', idx)"
              @click="onClickSession(s)"
            >
              <div class="notification-item__icon">{{ sessionIcon(s) }}</div>
              <div class="notification-item__content">
                <div class="notification-item__head">
                  <strong class="notification-item__title">{{ sessionTitle(s) }}</strong>
                  <time class="notification-item__time" :title="s.latestAt">{{ relativeTime(s.latestAt) }}</time>
                </div>
                <p class="notification-item__body">{{ sessionBody(s) }}</p>
                <div class="notification-item__quick-actions">
                  <button class="quick-action" title="Jump (Enter)" @click.stop="jump(s)">Jump</button>
                  <button class="quick-action" title="Dismiss (d)" @click.stop="dismiss(s)">Dismiss</button>
                  <button class="quick-action" title="Snooze 10m (s)" @click.stop="snooze(s)">Snooze</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Finished — completed sessions awaiting ack -->
        <section v-if="visibleFinished.length > 0" class="notif-section">
          <h3 class="notif-section__title">
            <span>Finished</span>
            <span class="notif-section__count">{{ visibleFinished.length }}</span>
          </h3>
          <div class="notification-center__list">
            <div
              v-for="(s, idx) in visibleFinished"
              :key="s.id"
              class="notification-item notification-item--finished"
              :class="itemClass(s, 'finished', idx)"
              @click="onClickSession(s)"
            >
              <div class="notification-item__icon">{{ sessionIcon(s) }}</div>
              <div class="notification-item__content">
                <div class="notification-item__head">
                  <strong class="notification-item__title">{{ sessionTitle(s) }}</strong>
                  <time class="notification-item__time" :title="s.latestAt">{{ relativeTime(s.latestAt) }}</time>
                </div>
                <p class="notification-item__body">{{ sessionBody(s) }}</p>
              </div>
              <button class="notification-item__remove" title="Remove" @click.stop="notifStore.remove(s.id)">
                &times;
              </button>
            </div>
          </div>
        </section>

        <!-- Older — resolved / stale -->
        <section v-if="visibleOlder.length > 0" class="notif-section notif-section--older">
          <h3 class="notif-section__title notif-section__title--collapsible" @click="showOlder = !showOlder">
            <span>{{ showOlder ? "▾" : "▸" }} Older</span>
            <span class="notif-section__count">{{ visibleOlder.length }}</span>
          </h3>
          <div v-if="showOlder" class="notification-center__list">
            <div
              v-for="(s, idx) in visibleOlder"
              :key="s.id"
              class="notification-item notification-item--resolved"
              :class="itemClass(s, 'older', idx)"
              @click="onClickSession(s)"
            >
              <div class="notification-item__icon">{{ sessionIcon(s) }}</div>
              <div class="notification-item__content">
                <div class="notification-item__head">
                  <strong class="notification-item__title">{{ sessionTitle(s) }}</strong>
                  <time class="notification-item__time" :title="s.latestAt">{{ relativeTime(s.latestAt) }}</time>
                </div>
                <p class="notification-item__body">{{ sessionBody(s) }}</p>
              </div>
              <button class="notification-item__remove" title="Remove" @click.stop="notifStore.remove(s.id)">
                &times;
              </button>
            </div>
          </div>
        </section>
      </div>
    </aside>
  </Transition>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";

const notifStore = useNotificationStore();
const appStore = useAppStore();
const bodyRef = ref(null);
const panelRef = ref(null);
const showOlder = ref(false);
const selectedIndex = ref(0);

let tickTimer = null;
const tick = ref(0);

onMounted(() => {
  tickTimer = setInterval(() => {
    tick.value++;
  }, 30_000);
});

onUnmounted(() => clearInterval(tickTimer));

// Snooze gate — hide sessions whose snoozedUntil hasn't elapsed.
const now = ref(Date.now());
setInterval(() => {
  now.value = Date.now();
}, 30_000);

function isSnoozed(s) {
  return s.snoozedUntil && s.snoozedUntil > now.value;
}

const visibleWaiting = computed(() => {
  // Urgent first, then by recency
  const waiting = notifStore.waitingSessions.filter((s) => !isSnoozed(s));
  return [...waiting].sort((a, b) => {
    const au = a.urgency === "urgent" ? 0 : 1;
    const bu = b.urgency === "urgent" ? 0 : 1;
    if (au !== bu) return au - bu;
    return new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
  });
});

const visibleFinished = computed(() => notifStore.finishedSessions.filter((s) => !isSnoozed(s)));

const visibleOlder = computed(() => notifStore.resolvedSessions.filter((s) => !isSnoozed(s)).slice(0, 30));

// Flat list for keyboard nav ordering.
const allVisible = computed(() => [...visibleWaiting.value, ...visibleFinished.value, ...visibleOlder.value]);

// Reset selection on panel open or list shrink.
watch(
  () => notifStore.panelOpen,
  async (isOpen) => {
    if (isOpen) {
      selectedIndex.value = 0;
      await nextTick();
      panelRef.value?.focus();
    }
  },
);

watch(allVisible, (list) => {
  if (selectedIndex.value >= list.length) selectedIndex.value = Math.max(0, list.length - 1);
});

function relativeTime(isoString) {
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

function sessionIcon(s) {
  if (s.urgency === "urgent") return "🚨";
  // Connection-level failures carry a distinct icon so they aren't mistaken
  // for a PR comment (both sit in the "review" category).
  if (s.category === "review" && s.meta?.kind === "connection-error") return "🔌";
  if (s.category === "review") return "💬";
  // A successfully finished agent task earns the checkered flag so it visually
  // stands apart from generic shell completions (which stay as ✅).
  if (s.category === "task" && s.state === "finished") return "🏁";
  if (s.state === "waiting") return "⏳";
  if (s.state === "finished") return "✅";
  return "🔔";
}

function sessionTitle(s) {
  if (s.category === "review") {
    // The latest event title already reads "New comment on repo #123" etc.,
    // so prefer it over the workspace › tab composition used for terminal
    // notifications (those are nameless per-tab alerts).
    const latest = s.events[0];
    return latest?.title || s.workspaceName || "Pull request";
  }
  const wsName = s.workspaceName || s.workspaceId || "Workspace";
  const tab = s.tabName || s.viewId || "Tab";
  return `${wsName} › ${tab}`;
}

function sessionBody(s) {
  const latest = s.events[0];
  if (!latest) return "";
  return latest.body || latest.title || "";
}

function itemClass(s, section, idx) {
  const flatIdx = flatIndexOf(s, section);
  const provider = s.meta?.provider || "";
  const providerSuffix = provider === "azure-devops" ? "azure" : provider === "github" ? "github" : "";
  return {
    "notification-item--urgent": s.urgency === "urgent",
    "notification-item--unread": s.state === "waiting",
    "notification-item--selected": flatIdx === selectedIndex.value,
    "notification-item--review": s.category === "review",
    [`notification-item--review-${providerSuffix}`]: s.category === "review" && providerSuffix,
    [`notification-item--${s.state}`]: true,
    [`notif-idx-${idx}`]: true,
  };
}

function flatIndexOf(s, section) {
  if (section === "waiting") return visibleWaiting.value.indexOf(s);
  if (section === "finished") return visibleWaiting.value.length + visibleFinished.value.indexOf(s);
  return visibleWaiting.value.length + visibleFinished.value.length + visibleOlder.value.indexOf(s);
}

// Build the backend sessionId for a notification session row. `viewId` is the
// full `workspaceId:panelId` key as captured in useNotificationCapture from
// `alert.sessionId` — use it directly. Prepending `workspaceId` again produced
// a malformed `workspaceId:workspaceId:panelId`, which parseSessionId
// split wrong and caused clearProjectAlerts / resetSessionSignal to no-op.
function backendSessionId(s) {
  return s.viewId || s.id;
}

function resolveJumpTarget(s) {
  if (s.category !== "review") {
    return { workspaceId: s.workspaceId || "", viewId: s.viewId || "" };
  }
  const workspaces = appStore.payload?.appState?.workspaces || [];
  const preferredId = s.meta?.reviewWorkspaceId || s.meta?.existingWorkspaceId || s.workspaceId || "";
  const direct = preferredId && workspaces.find((w) => w.id === preferredId);
  if (direct) return { workspaceId: direct.id, viewId: "" };
  // No review workspace yet — fall back to the provider inbox.
  const inboxKind = s.meta?.provider === "github" ? "github" : "azure";
  const activeProfile = appStore.payload?.appState?.activeProfileId || "default";
  const inbox = workspaces.find((w) => w.kind === inboxKind && (w.profileId || "default") === activeProfile);
  return { workspaceId: inbox?.id || "", viewId: "" };
}

async function jump(s) {
  // Jump = user engaged with this session → dismissed=false (resets adaptive counter).
  // Terminal alerts have a backend counterpart to clear; review events don't.
  if (s.category !== "review") {
    await notifStore.clearOnBackend(backendSessionId(s), { dismissed: false });
  }
  notifStore.setState(s.id, "resolved");

  const target = resolveJumpTarget(s);
  if (!target.workspaceId || !appStore.payload) {
    notifStore.closePanel();
    return;
  }
  const activeWsId = appStore.payload.appState?.activeWorkspaceId;
  if (activeWsId !== target.workspaceId) {
    await appStore.activateWorkspace(target.workspaceId);
  }
  if (target.viewId) appStore.activateView(target.viewId);
  notifStore.closePanel();
}

async function dismiss(s) {
  // Dismiss = user silenced the alert WITHOUT engaging → dismissed=true.
  // Feeds adaptive suppression for terminal alerts; review events don't
  // use adaptive suppression, so skip the backend call.
  if (s.category !== "review") {
    await notifStore.clearOnBackend(backendSessionId(s), { dismissed: true });
  }
  notifStore.setState(s.id, "resolved");
}

function snooze(s) {
  notifStore.snooze(s.id, 600_000);
}

function onClickSession(s) {
  jump(s);
}

function onKeydown(ev) {
  const list = allVisible.value;
  if (list.length === 0) return;
  const current = list[selectedIndex.value];
  switch (ev.key) {
    case "j":
    case "ArrowDown":
      ev.preventDefault();
      selectedIndex.value = Math.min(list.length - 1, selectedIndex.value + 1);
      break;
    case "k":
    case "ArrowUp":
      ev.preventDefault();
      selectedIndex.value = Math.max(0, selectedIndex.value - 1);
      break;
    case "Enter":
      ev.preventDefault();
      if (current) jump(current);
      break;
    case "d":
      ev.preventDefault();
      if (current) dismiss(current);
      break;
    case "s":
      ev.preventDefault();
      if (current) snooze(current);
      break;
    case "A":
      if (ev.shiftKey) {
        ev.preventDefault();
        notifStore.markAllRead();
      }
      break;
    case "Escape":
      ev.preventDefault();
      notifStore.closePanel();
      break;
  }
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
