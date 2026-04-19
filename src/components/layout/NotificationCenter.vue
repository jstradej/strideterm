<template>
  <Transition name="notif-panel">
    <aside
      v-if="notifStore.pinned || notifStore.panelOpen"
      ref="panelRef"
      class="notification-center"
      :class="{ 'notification-center--pinned': notifStore.pinned }"
      tabindex="0"
      @click.stop
      @keydown="onKeydown"
      @pointermove="onPointerInteract"
      @pointerdown="onPointerInteract"
    >
      <header class="notification-center__header">
        <h2 class="notification-center__title">
          Notifications
          <span
            v-if="notifStore.unreadCount > 0"
            class="notification-center__title-badge"
            :title="`${notifStore.unreadCount} unread`"
            >{{ notifStore.unreadCount > 99 ? "99+" : notifStore.unreadCount }}</span
          >
        </h2>
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
          <button
            type="button"
            class="notification-center__pin"
            :class="{ 'notification-center__pin--active': notifStore.pinned }"
            :title="notifStore.pinned ? 'Unpin panel' : 'Pin panel to the right'"
            @click="notifStore.togglePin()"
          >
            {{ notifStore.pinned ? "📌" : "📍" }}
          </button>
          <button
            v-if="!notifStore.pinned"
            type="button"
            class="notification-center__close"
            title="Close"
            @click="notifStore.closePanel()"
          >
            &times;
          </button>
        </div>
      </header>

      <Transition name="notif-pill">
        <button
          v-if="unseenCount > 0"
          type="button"
          class="notification-center__new-pill"
          title="Scroll to top and show new"
          @click="scrollToTopAndClear"
        >
          ↑ {{ unseenCount }} new
        </button>
      </Transition>

      <div ref="bodyRef" class="notification-center__body" @scroll="onBodyScroll">
        <div v-if="notifStore.sessions.length === 0" class="notification-center__empty">No notifications yet.</div>

        <!-- Flat chronological timeline with day-band separators.
             State is conveyed via icon + item modifier class (waiting/finished/
             resolved/urgent) so the reader can scan the time axis without
             category grouping. -->
        <div v-if="timeline.length > 0" class="notification-center__list">
          <template v-for="row in timeline" :key="row.key">
            <div v-if="row.kind === 'separator'" class="notif-day-separator">
              <span class="notif-day-separator__line"></span>
              <span class="notif-day-separator__label">{{ row.label }}</span>
              <span class="notif-day-separator__line"></span>
            </div>
            <div
              v-else
              class="notification-item"
              :class="itemClass(row.session)"
              @click="onClickSession(row.session)"
              @pointermove="clearFlash(row.session.id)"
            >
              <div class="notification-item__icon">{{ sessionIcon(row.session) }}</div>
              <div class="notification-item__content">
                <div class="notification-item__head">
                  <strong class="notification-item__title">
                    <span v-if="flashingIds.has(row.session.id)" class="notification-item__new-pill">NEW</span>
                    {{ sessionTitle(row.session) }}
                  </strong>
                  <span class="notification-item__meta">
                    <span
                      v-if="row.session.events && row.session.events.length > 1"
                      class="notification-item__count"
                      :title="`${row.session.events.length} events on this session`"
                      >·{{ row.session.events.length }}×</span
                    >
                    <time class="notification-item__time" :title="row.session.latestAt">
                      {{ relativeTime(row.session.latestAt) }}
                    </time>
                  </span>
                </div>
                <p class="notification-item__body">{{ sessionBody(row.session) }}</p>
                <div v-if="row.session.state === 'waiting'" class="notification-item__quick-actions">
                  <button class="quick-action" title="Jump to session (Enter)" @click.stop="jump(row.session)">
                    Jump
                  </button>
                  <button
                    class="quick-action"
                    title="Silence without acting — feeds adaptive suppression (d)"
                    @click.stop="dismiss(row.session)"
                  >
                    Dismiss
                  </button>
                  <button class="quick-action" title="Snooze for 10 minutes (s)" @click.stop="snooze(row.session)">
                    Snooze
                  </button>
                </div>
              </div>
              <!-- Hard-delete from history. Hidden on "waiting" items so the
                   user is nudged toward Dismiss/Snooze/Jump instead of
                   silently dropping a live alert. -->
              <button
                v-if="row.session.state !== 'waiting'"
                class="notification-item__remove"
                title="Remove from history"
                @click.stop="notifStore.remove(row.session.id)"
              >
                &times;
              </button>
            </div>
          </template>
        </div>
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
const selectedIndex = ref(0);
// Selection outline is only shown when the user is actively driving the list
// with the keyboard. Mouse interaction resets it so the panel doesn't look
// like the first row is already "armed" on open.
const keyboardActive = ref(false);

// Items flashing (newly arrived — stay highlighted until the user hovers
// them, so they're still findable on return to the app). Safety timeout
// ensures nothing stays glowing forever if the user ignores it.
const flashingIds = ref(new Set());
const FLASH_SAFETY_MS = 30_000;

// Scroll-state tracking — when the user is scrolled down reading older
// entries and a new alert arrives at the top, we surface a "N new ↑" pill
// instead of silently shifting the list under them.
const NEAR_TOP_PX = 100;
const isNearTop = ref(true);
const unseenCount = ref(0);

function onBodyScroll() {
  if (!bodyRef.value) return;
  const atTop = bodyRef.value.scrollTop < NEAR_TOP_PX;
  isNearTop.value = atTop;
  if (atTop) unseenCount.value = 0;
}

function scrollToTopAndClear() {
  if (!bodyRef.value) return;
  bodyRef.value.scrollTo({ top: 0, behavior: "smooth" });
  unseenCount.value = 0;
}

let tickTimer = null;
let snoozeTimer = null;
const tick = ref(0);
// Snooze gate — hide sessions whose snoozedUntil hasn't elapsed.
const now = ref(Date.now());

onMounted(() => {
  tickTimer = setInterval(() => {
    tick.value++;
  }, 30_000);
  snoozeTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});

onUnmounted(() => {
  clearInterval(tickTimer);
  clearInterval(snoozeTimer);
});

function isSnoozed(s) {
  return s.snoozedUntil && s.snoozedUntil > now.value;
}

// Flat chronological list — all non-snoozed sessions, newest first.
// Capped so the DOM doesn't grow unbounded for long-running sessions.
const MAX_TIMELINE = 50;
const visibleSessions = computed(() => {
  const list = notifStore.sessions.filter((s) => !isSnoozed(s));
  return [...list]
    .sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime())
    .slice(0, MAX_TIMELINE);
});

// Day-band label — "Today" / "Yesterday" / weekday name (this week) /
// locale date (older). Used as the separator key + label.
function dayBandKey(d) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `weekday-${d.getDay()}`;
  return `date-${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayBandLabel(d) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((today - target) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// Interleave sessions with day-band separator rows. Re-runs whenever the
// underlying list changes — cheap for <=50 items.
const timeline = computed(() => {
  void tick.value;
  const rows = [];
  let lastBand = "";
  for (const s of visibleSessions.value) {
    const d = new Date(s.latestAt);
    const band = dayBandKey(d);
    if (band !== lastBand) {
      rows.push({ kind: "separator", key: `sep-${band}`, label: dayBandLabel(d) });
      lastBand = band;
    }
    rows.push({ kind: "item", key: s.id, session: s });
  }
  return rows;
});

// Flat list of sessions for keyboard nav.
const allVisible = computed(() => visibleSessions.value);

// Reset selection on panel open or list shrink.
watch(
  () => notifStore.panelOpen,
  async (isOpen) => {
    if (isOpen) {
      selectedIndex.value = 0;
      keyboardActive.value = false;
      await nextTick();
      panelRef.value?.focus();
    }
  },
);

function onPointerInteract() {
  // Any mouse activity within the panel clears the keyboard-selection outline,
  // so the panel doesn't look like the first row is "armed" when the user is
  // pointing at other rows with the cursor.
  if (keyboardActive.value) keyboardActive.value = false;
}

// When the user pins the panel, focus it once so keyboard nav works without
// requiring a click first.
watch(
  () => notifStore.pinned,
  async (isPinned) => {
    if (isPinned) {
      await nextTick();
      panelRef.value?.focus();
    }
  },
);

// External focus requests (e.g. Ctrl+Shift+N shortcut). Counter-based so
// repeated presses retrigger focus even when state didn't change.
watch(
  () => notifStore.focusRequestSignal,
  async () => {
    await nextTick();
    panelRef.value?.focus();
  },
);

watch(allVisible, (list) => {
  if (selectedIndex.value >= list.length) selectedIndex.value = Math.max(0, list.length - 1);
  // Clear the "N new" pill if the list shrank to zero (e.g. Clear all) —
  // the scroll event doesn't fire on an emptied container, so unseenCount
  // would otherwise linger as a stale badge over an empty list.
  if (list.length === 0) unseenCount.value = 0;
});

// Flash both newly-appeared sessions AND existing sessions whose latestAt
// advanced (i.e. a new event landed on the same thread — e.g. Claude Code
// completed a second task after the first). Tracking `latestAt` per session
// means the re-bubble up to the top is accompanied by a pulse so the user
// recognises "this is the session I saw before, just updated".
//
// If the app window is not focused when the event arrives, we queue the id
// into `pendingFlashIds` and promote them on focus — so flashes aren't
// missed while the user is in another app.
const seenLatestAt = new Map(); // sessionId → latestAt (ISO)
const pendingFlashIds = new Set();
let flashSeeded = false;

function triggerFlash(id) {
  flashingIds.value.add(id);
  // Force reactivity on the Set (Vue doesn't track Set.add mutations).
  flashingIds.value = new Set(flashingIds.value);
  // Safety timeout disabled for testing — flash persists until pointermove
  // within the item clears it. Re-enable with setTimeout(clearFlash, FLASH_SAFETY_MS)
  // if this proves too insistent when several flashes pile up unattended.
  // Using pointermove (not pointerenter) is deliberate: Chromium dispatches
  // pointerenter on layout-induced element-under-pointer changes, which would
  // wipe a flash the instant the list re-ordered under a stationary cursor.
}

function clearFlash(id) {
  if (!flashingIds.value.has(id)) return;
  flashingIds.value.delete(id);
  flashingIds.value = new Set(flashingIds.value);
}

function smoothScrollToTop() {
  nextTick(() => {
    bodyRef.value?.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// Decide how to surface a newly-arrived session:
//  - panel not visible → no-op (bell badge + toast already alert)
//  - user is near the top → flash + smooth-scroll so the item is visible
//    and items below slide down naturally
//  - user is scrolled down reading → flash + increment unseenCount so the
//    "N new ↑" pill surfaces; don't yank their scroll position
function surfaceNewItem(id) {
  const panelVisible = notifStore.pinned || notifStore.panelOpen;
  if (!panelVisible) return;
  triggerFlash(id);
  if (isNearTop.value) {
    smoothScrollToTop();
  } else {
    unseenCount.value += 1;
  }
}

watch(
  () => notifStore.sessions.map((s) => ({ id: s.id, latestAt: s.latestAt })),
  (snapshot) => {
    if (!flashSeeded) {
      for (const s of snapshot) seenLatestAt.set(s.id, s.latestAt);
      flashSeeded = true;
      return;
    }
    const hasFocus = typeof document !== "undefined" && document.hasFocus();
    for (const { id, latestAt } of snapshot) {
      const prev = seenLatestAt.get(id);
      if (prev === latestAt) continue;
      seenLatestAt.set(id, latestAt);
      if (hasFocus) {
        surfaceNewItem(id);
      } else {
        pendingFlashIds.add(id);
      }
    }
  },
  { immediate: true },
);

function onWindowFocus() {
  if (pendingFlashIds.size === 0) return;
  const ids = [...pendingFlashIds];
  pendingFlashIds.clear();
  // Drain all at once — if several alerts piled up while away, they all
  // pulse in sync, which reads as "these are the new ones" at a glance.
  for (const id of ids) surfaceNewItem(id);
}

onMounted(() => window.addEventListener("focus", onWindowFocus));
onUnmounted(() => window.removeEventListener("focus", onWindowFocus));

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

function itemClass(s) {
  const flatIdx = visibleSessions.value.indexOf(s);
  const provider = s.meta?.provider || "";
  const providerSuffix = provider === "azure-devops" ? "azure" : provider === "github" ? "github" : "";
  return {
    "notification-item--urgent": s.urgency === "urgent",
    "notification-item--unread": s.state === "waiting",
    "notification-item--selected": keyboardActive.value && flatIdx === selectedIndex.value,
    "notification-item--review": s.category === "review",
    [`notification-item--review-${providerSuffix}`]: s.category === "review" && providerSuffix,
    [`notification-item--${s.state}`]: true,
    "notification-item--flash": flashingIds.value.has(s.id),
  };
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
    if (!notifStore.pinned) notifStore.closePanel();
    return;
  }
  const activeWsId = appStore.payload.appState?.activeWorkspaceId;
  if (activeWsId !== target.workspaceId) {
    await appStore.activateWorkspace(target.workspaceId);
  }
  if (target.viewId) appStore.activateView(target.viewId);
  // Pinned dock stays open — the item greys in place instead of the panel closing.
  if (!notifStore.pinned) notifStore.closePanel();
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
      keyboardActive.value = true;
      selectedIndex.value = Math.min(list.length - 1, selectedIndex.value + 1);
      break;
    case "k":
    case "ArrowUp":
      ev.preventDefault();
      keyboardActive.value = true;
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
      // When pinned, Esc is a no-op — user expects the dock to stay put.
      if (notifStore.pinned) return;
      ev.preventDefault();
      notifStore.closePanel();
      break;
  }
}

function onClickOutside(event) {
  if (notifStore.pinned) return;
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
