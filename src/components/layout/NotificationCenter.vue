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
      <div
        v-if="notifStore.pinned"
        class="notif-dock-resize-handle"
        data-role="notif-dock-resize-handle"
        title="Drag to resize · double-click to reset"
      ></div>
      <header class="notification-center__header">
        <div class="notification-center__tabs">
          <button
            type="button"
            class="notification-center__tab"
            :class="{ 'notification-center__tab--active': activeTab === 'alerts' }"
            title="Alerts — notification history for this profile."
            @click="activeTab = 'alerts'"
          >
            <span class="notification-center__tab-icon" aria-hidden="true">🔔</span>
            <span class="notification-center__tab-label">Alerts</span>
            <span
              v-if="profileUnreadCount > 0"
              class="notification-center__title-badge"
              :title="`${profileUnreadCount} unread in this profile`"
              >{{ profileUnreadCount > 99 ? "99+" : profileUnreadCount }}</span
            >
          </button>
          <button
            type="button"
            class="notification-center__tab"
            :class="{ 'notification-center__tab--active': activeTab === 'telegram' }"
            title="Status of all configured Telegram bot connections (polling state, missing tokens). Configure them in Settings → Telegram."
            @click="activeTab = 'telegram'"
          >
            <span class="notification-center__tab-icon" aria-hidden="true">✈️</span>
            <span class="notification-center__tab-label">Telegram</span>
          </button>
          <button
            type="button"
            class="notification-center__tab"
            :class="{ 'notification-center__tab--active': activeTab === 'agents' }"
            title="Agents — every agent currently working in this profile, with how long it has been running. Click a row to open it."
            @click="activeTab = 'agents'"
          >
            <span class="notification-center__tab-icon" aria-hidden="true">🤖</span>
            <span class="notification-center__tab-label">Agents</span>
            <span
              v-if="runningAgents.length > 0"
              class="notification-center__title-badge"
              :title="`${runningAgents.length} agents running`"
              >{{ runningAgents.length }}</span
            >
          </button>
          <button
            v-if="showApprovals"
            type="button"
            class="notification-center__tab"
            :class="{ 'notification-center__tab--active': activeTab === 'approvals' }"
            title="Approvals — the permission prompts strIDEterm answered for you in this profile, newest first. Click a row for the full command."
            @click="activeTab = 'approvals'"
          >
            <span class="notification-center__tab-icon" aria-hidden="true">🛡️</span>
            <span class="notification-center__tab-label">Approvals</span>
          </button>
          <button
            v-if="supportsPerformance"
            type="button"
            class="notification-center__tab"
            :class="{ 'notification-center__tab--active': activeTab === 'performance' }"
            title="Live CPU / memory of the Electron processes and this window's terminal rendering activity. Diagnostics only run while this tab is open."
            @click="activeTab = 'performance'"
          >
            <span class="notification-center__tab-icon" aria-hidden="true">📈</span>
            <span class="notification-center__tab-label">Performance</span>
          </button>
        </div>
        <!-- Very-narrow fallback: below the icon-tab threshold even the icons
             crowd the action buttons, so the tab bar collapses into this
             dropdown (CSS toggles which of the two is displayed). -->
        <div ref="tabMenuRef" class="notification-center__tabmenu">
          <button
            type="button"
            class="notification-center__tabmenu-toggle"
            :class="{ 'notification-center__tabmenu-toggle--open': tabMenuOpen }"
            :aria-expanded="tabMenuOpen ? 'true' : 'false'"
            aria-haspopup="menu"
            title="Switch section (Alerts · Agents · Telegram · Performance)"
            @click="tabMenuOpen = !tabMenuOpen"
          >
            <span class="notification-center__tabmenu-hamburger" aria-hidden="true">☰</span>
            <span class="notification-center__tabmenu-current">{{ activeTabLabel }}</span>
            <span
              v-if="activeTab === 'alerts' && profileUnreadCount > 0"
              class="notification-center__title-badge"
              :title="`${profileUnreadCount} unread in this profile`"
              >{{ profileUnreadCount > 99 ? "99+" : profileUnreadCount }}</span
            >
            <span
              v-else-if="activeTab === 'agents' && runningAgents.length > 0"
              class="notification-center__title-badge"
              :title="`${runningAgents.length} agents running`"
              >{{ runningAgents.length }}</span
            >
          </button>
          <div v-if="tabMenuOpen" class="notification-center__tabmenu-list" role="menu">
            <button
              v-for="t in menuTabs"
              :key="t.id"
              type="button"
              role="menuitem"
              class="notification-center__tabmenu-item"
              :class="{ 'notification-center__tabmenu-item--active': activeTab === t.id }"
              @click="selectTab(t.id)"
            >
              <span>{{ t.label }}</span>
              <span v-if="t.id === 'alerts' && profileUnreadCount > 0" class="notification-center__title-badge">{{
                profileUnreadCount > 99 ? "99+" : profileUnreadCount
              }}</span>
              <span
                v-else-if="t.id === 'agents' && runningAgents.length > 0"
                class="notification-center__title-badge"
                >{{ runningAgents.length }}</span
              >
            </button>
          </div>
        </div>
        <div class="notification-center__actions">
          <button
            v-if="profileUnreadCount > 0 || hasFinishedInProfile"
            type="button"
            class="notification-center__action"
            title="Mark every unread / finished notification in this profile as read so the unread badge clears. Notifications stay in the history list — use Clear all to delete them."
            @click="ackFinishedInProfile"
          >
            <span class="notification-center__action-icon" aria-hidden="true">✓</span>
            <span class="notification-center__action-label">Ack finished</span>
          </button>
          <button
            v-if="hasSessionsInProfile"
            type="button"
            class="notification-center__action notification-center__action--danger"
            title="Permanently remove every notification in this profile from the history list (read and unread). This cannot be undone."
            @click="clearAllInProfile"
          >
            <span class="notification-center__action-icon" aria-hidden="true">🗑</span>
            <span class="notification-center__action-label">Clear all</span>
          </button>
          <button
            type="button"
            class="notification-center__pin"
            :class="{ 'notification-center__pin--active': notifStore.pinned }"
            :title="
              notifStore.pinned
                ? 'Unpin the notification panel — it will collapse back into the side rail when you click outside it.'
                : 'Pin the notification panel to the right of the workspace so it stays open while you work; clicking outside no longer dismisses it.'
            "
            @click="notifStore.togglePin()"
          >
            {{ notifStore.pinned ? "📌" : "📍" }}
          </button>
          <button
            v-if="!notifStore.pinned"
            type="button"
            class="notification-center__close"
            title="Hide the notification panel (Esc). New notifications still arrive in the background and the bell icon will indicate unread alerts."
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
          title="Scroll the list back to the top to reveal the latest unseen notifications and clear the new-counter pill."
          @click="scrollToTopAndClear"
        >
          ↑ {{ unseenCount }} new
        </button>
      </Transition>

      <!-- Telegram status tab -->
      <div v-if="activeTab === 'telegram'" class="notification-center__body">
        <div
          v-if="telegramConnections.length === 0"
          class="notification-center__empty telegram-empty"
          title="No Telegram bot is wired up yet. Open Settings → Telegram to add one (you'll need a bot token from @BotFather and a chat ID)."
        >
          <p class="telegram-empty__title">No Telegram connections configured.</p>
          <p class="telegram-empty__hint">
            Forward strIDEterm alerts to your phone, and reply to act on them. Setup takes ~1 minute.
          </p>
          <button
            type="button"
            class="button button--primary telegram-empty__cta"
            title="Open Settings → Telegram to add a bot connection"
            @click="openTelegramSettings"
          >
            Set up Telegram bot
          </button>
        </div>
        <div v-else class="telegram-status">
          <div class="telegram-status-list">
            <div
              v-for="conn in telegramConnections"
              :key="conn.id"
              class="telegram-status-item"
              :title="`Telegram connection “${conn.label || conn.chatId}”. Manage in Settings → Telegram.`"
            >
              <div class="telegram-status-item__row">
                <span
                  class="telegram-status-item__label"
                  :title="
                    conn.label ? `Connection label: ${conn.label}` : 'No label set — using chat ID as the display name.'
                  "
                  >{{ conn.label || conn.chatId }}</span
                >
                <span
                  class="telegram-status-item__chat"
                  title="Telegram chat ID this bot posts into. Negative -100… IDs are groups/channels."
                  >chat {{ conn.chatId }}</span
                >
                <span
                  class="telegram-status-item__badge"
                  :class="conn.status === 'configured' ? 'tg-badge--ok' : 'tg-badge--warn'"
                  :title="
                    conn.status === 'configured'
                      ? 'Bot token is present in the credential store; long-polling is active.'
                      : 'No bot token found for this connection — saved settings exist, but the token reference is missing. Re-save the connection to fix.'
                  "
                  >{{ conn.status === "configured" ? "connected" : conn.status }}</span
                >
              </div>
              <div class="telegram-status-item__meta">
                <span
                  v-if="conn.pollSeconds"
                  class="telegram-status-item__chip"
                  :title="`The bot polls Telegram for new messages every ${conn.pollSeconds}s.`"
                  >poll {{ conn.pollSeconds }}s</span
                >
                <span class="telegram-status-item__chip" :title="forwardKindsTooltip(conn.forwardKinds)">{{
                  forwardKindsLabel(conn.forwardKinds)
                }}</span>
              </div>
            </div>
          </div>
          <div class="telegram-status__hint">
            Send <code>/help</code> to your bot for the available commands, or <code>/menu</code> for an interactive
            hub.
          </div>
          <div class="telegram-status__actions">
            <button
              type="button"
              class="button button--ghost"
              title="Open Settings → Telegram to add a new bot, edit existing connections (token, chat ID, forward filter), or remove one."
              @click="openTelegramSettings"
            >
              ⚙ Configure
            </button>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'alerts'" ref="bodyRef" class="notification-center__body" @scroll="onBodyScroll">
        <!-- "No notifications" must reflect what the user sees, not the
             process-shared store: if profile A has items but the active
             profile is B with none, the timeline is empty and we should
             say so. Using notifStore.sessions.length here would hide the
             empty-state hint in that case. -->
        <div v-if="timeline.length === 0" class="notification-center__empty">No notifications yet.</div>

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
                      v-if="sessionProfileLabel(row.session)"
                      class="notification-item__profile-label"
                      :title="`Profile: ${sessionProfileLabel(row.session)}`"
                      >{{ sessionProfileLabel(row.session) }}</span
                    >
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
                <p class="notification-item__body" :title="sessionBody(row.session)">{{ sessionBody(row.session) }}</p>
                <div v-if="row.session.state === 'waiting'" class="notification-item__quick-actions">
                  <button
                    class="quick-action"
                    title="Switch to the workspace and tab that produced this alert and focus its terminal so you can reply to the agent (keyboard shortcut: Enter)."
                    @click.stop="jump(row.session)"
                  >
                    Jump
                  </button>
                  <button
                    class="quick-action"
                    title="Silence this alert without acting on it. Feeds the adaptive suppression model so you get fewer of the same kind in future. Shortcut: d."
                    @click.stop="dismiss(row.session)"
                  >
                    Dismiss
                  </button>
                  <button
                    class="quick-action"
                    title="Hide this alert for ten minutes. If the underlying session is still waiting after that it will re-appear at the top of the list. Shortcut: s."
                    @click.stop="snooze(row.session)"
                  >
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
                title="Permanently remove just this notification from the history list. Cannot be undone."
                @click.stop="notifStore.remove(row.session.id)"
              >
                &times;
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- Agents tab — the same rows the sidebar surface renders, with room
           for the full ancestry and the elapsed. The tab stays in the bar even
           when empty: a tab is a place, the chip is the signal. -->
      <div v-if="activeTab === 'agents'" class="notification-center__body">
        <div v-if="runningAgents.length === 0" class="notification-center__empty">No agents running.</div>
        <div v-else class="agent-run-list">
          <button
            v-for="row in runningAgents"
            :key="row.key"
            type="button"
            class="agent-run-item"
            :class="{ 'agent-run-item--in-grid': row.inGrid }"
            :data-agent-key="row.key"
            @click="openAgentRow(row)"
          >
            <span class="agent-run-item__icon" aria-hidden="true">🤖</span>
            <span class="agent-run-item__content">
              <span class="agent-run-item__head">
                <strong class="agent-run-item__title">{{ row.workspaceName }} › {{ row.label }}</strong>
                <span class="agent-run-item__elapsed">{{ elapsedOf(row) }}</span>
              </span>
              <span class="agent-run-item__meta">
                <span v-if="row.ancestry.length" class="agent-run-item__ancestry">{{ row.ancestry.join(" / ") }}</span>
                <span class="agent-run-item__state">{{ row.state }}</span>
                <span v-if="row.gridSlotIndex" class="agent-run-item__slot">slot {{ row.gridSlotIndex }}</span>
              </span>
            </span>
          </button>
        </div>
      </div>

      <!-- Auto-approval trail. Kept mounted only while its tab is open: the
           list queries SQLite on mount, and a dock pinned open all day should
           not do that for a tab nobody is looking at. -->
      <div v-if="activeTab === 'approvals'" class="notification-center__body">
        <ApprovalsPanel
          :api="api"
          :profile-id="activeProfileId"
          :live-approval="lastApproval"
          :live-signal="approvalSignal"
          @jump="navigateToTarget"
          @count="onApprovalCount"
        />
      </div>

      <!-- Performance diagnostics tab -->
      <div v-if="activeTab === 'performance'" class="notification-center__body notification-center__body--perf">
        <PerformancePanel />
      </div>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useNotificationStore } from "../../stores/notifications.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationProfileScope } from "../../composables/useNotificationProfileScope.js";
import { useDismissable } from "../../composables/useDismissable.js";
import {
  collectSupervisedAgents,
  runningAgentElapsedMs,
  formatRunningAgentElapsed,
  type RunningAgentRow,
} from "../../app/selectors.js";
import type { WorkspaceState } from "../../../electron/shared/types/state.js";
import PerformancePanel from "./PerformancePanel.vue";
import ApprovalsPanel from "./ApprovalsPanel.vue";
import { dayBandKey, dayBandLabel } from "../../app/helpers.js";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";

interface NotificationSession {
  id: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  viewId: string;
  state: string;
  tier: number;
  urgency: string;
  category: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: Record<string, any> | null;
  firstAt: string;
  latestAt: string;
  events: Array<{ title?: string; body?: string; kind?: string }>;
  snoozedUntil: number;
}

const notifStore = useNotificationStore();
const appStore = useAppStore();
const { sessionInActiveProfile, activeProfileId } = useNotificationProfileScope();
const profileUnreadCount = computed(() => notifStore.unreadCountFor(sessionInActiveProfile));
const hasFinishedInProfile = computed(() => notifStore.finishedSessions.some((s) => sessionInActiveProfile(s)));
const hasSessionsInProfile = computed(() => notifStore.sessions.some((s) => sessionInActiveProfile(s)));

function ackFinishedInProfile(): void {
  notifStore.markAllRead(sessionInActiveProfile);
}
function clearAllInProfile(): void {
  notifStore.clearAll(sessionInActiveProfile);
}
const bodyRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const selectedIndex = ref(0);
type TabId = "alerts" | "agents" | "telegram" | "approvals" | "performance";
const activeTab = ref<TabId>("alerts");
// The Performance tab needs Electron process metrics — only shown when the
// transport advertises them (desktop), never on the remote/mobile client.
const supportsPerformance = computed(() => appStore.supportsPerformanceMetrics);

// The app's transport, injected — never `createTransport()`, which mints a
// second WebSocket on the remote client. Only the Approvals list uses it: it
// reads the audit log and deletes from it.
const api = inject<Transport>(apiKey) ?? null;

/**
 * Show the Approvals tab when auto-approve is armed OR the profile has a trail.
 *
 * Not "when the setting is on": that would hide the record of what was
 * approved while it WAS on, and the setting can go false on its own —
 * `updateSettings()` disarms it whenever `notifications.agentHook` drops. The
 * evidence has to outlive the switch that produced it. Retention (30 days)
 * eventually empties the trail, and the tab then disappears with it.
 */
const approvalCount = ref(0);
const autoApproveArmed = computed(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Boolean((appStore.payload as any)?.appState?.settings?.notifications?.autoApprovePermissions),
);
/**
 * ...and it also stays for as long as the user is standing on it. Clearing
 * the trail from inside the tab would otherwise pull the tab out from under
 * the click that cleared it; this way the empty state explains itself and the
 * tab goes away when the user next moves off it.
 */
const showApprovals = computed(
  () => activeTab.value === "approvals" || autoApproveArmed.value || approvalCount.value > 0,
);
function onApprovalCount(total: number): void {
  approvalCount.value = total;
}

/**
 * The live `approval:recorded` subscription, owned here rather than in the
 * tab: this component's setup runs once for the life of the renderer (only
 * its root element sits behind the open/pinned `v-if`), while the tab mounts
 * and unmounts with every tab switch — and neither transport's
 * `onApprovalRecorded` hands back an unsubscribe, so subscribing there would
 * add a listener per switch and never drop one.
 *
 * It has to be here for a second reason too: an approval that arrives while
 * the dock is on another tab is exactly what makes the Approvals tab APPEAR,
 * and a tab that is not mounted cannot report a count.
 */
const lastApproval = ref<unknown>(null);
const approvalSignal = ref(0);
function onApprovalRecorded(payload: unknown): void {
  lastApproval.value = payload;
  approvalSignal.value += 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileId = String((payload as any)?.profileId || "");
  if (!activeProfileId.value || profileId === activeProfileId.value) {
    approvalCount.value = Math.max(1, approvalCount.value + 1);
  }
}

/**
 * Cheap probe for "does this profile have any approvals at all?" — one row,
 * for the count that comes with it. Only ever runs while the dock is actually
 * showing, and the tab's own list reports its total back through `@count`
 * once it is open, so this is a bootstrap rather than a poll.
 */
async function probeApprovalCount(): Promise<void> {
  const query = api?.queryApprovalAuditLog;
  if (!query) return;
  try {
    const result = (await query({
      limit: 1,
      ...(activeProfileId.value ? { profileId: activeProfileId.value } : {}),
    })) as { total?: number };
    approvalCount.value = Number(result?.total) || 0;
  } catch {
    // A failed probe just means no tab this time round; the next open retries.
  }
}

// Narrow-panel tab switcher. The tab bar and this dropdown are both rendered;
// a container query decides which one is visible (see notifications.css). The
// open/close state is JS-driven so the dropdown can be dismissed by clicking
// away just like the panel itself.
const tabMenuOpen = ref(false);
const tabMenuRef = ref<HTMLElement | null>(null);
const menuTabs = computed<{ id: TabId; label: string }[]>(() => {
  const tabs: { id: TabId; label: string }[] = [
    { id: "alerts", label: "Alerts" },
    { id: "agents", label: "Agents" },
    { id: "telegram", label: "Telegram" },
  ];
  if (showApprovals.value) tabs.push({ id: "approvals", label: "Approvals" });
  if (supportsPerformance.value) tabs.push({ id: "performance", label: "Performance" });
  return tabs;
});
const activeTabLabel = computed(() => menuTabs.value.find((t) => t.id === activeTab.value)?.label ?? "Alerts");
function selectTab(id: TabId): void {
  activeTab.value = id;
  tabMenuOpen.value = false;
}

// --- Running agents -------------------------------------------------------
// Exactly the same task-only row model the sidebar's RUNNING surface and the
// hero chip render — no second logic and no grid lookup of its own; the
// viewer-owned grid goes in as an explicit argument. Both the list below and
// the tab badge count read this, so the badge can never disagree with the
// sidebar.
const runningAgents = computed((): RunningAgentRow[] => {
  const payload = appStore.payload;
  if (!payload) return [];
  return collectSupervisedAgents({
    workspaces: appStore.filteredWorkspaces as WorkspaceState[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskRunnerSnapshot: ((payload as any).taskRunner as Record<string, { state?: string }>) || null,
    workspaceGrid: appStore.workspaceGrid,
  });
});

// One shared minute clock for the elapsed column — the panel's own 30s tick
// already only runs while the dock is visible or something is snoozed, so the
// rows re-render on it without a second timer.
function elapsedOf(row: RunningAgentRow): string {
  void tick.value;
  return formatRunningAgentElapsed(runningAgentElapsedMs(row, now.value));
}

// Telegram connection statuses from live snapshot
interface TelegramConnectionView {
  id: string;
  label: string;
  chatId: string;
  status: string;
  pollSeconds?: number;
  forwardKinds?: string[];
}
const telegramConnections = computed<TelegramConnectionView[]>(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((appStore.payload as any)?.telegram?.connections || []) as TelegramConnectionView[];
});

// Friendly label for the forward filter chip. An empty `forwardKinds`
// array means "forward everything" — surface that explicitly so users
// don't think the chip is broken.
function forwardKindsLabel(kinds: string[] | undefined): string {
  if (!kinds || kinds.length === 0) return "all alerts";
  if (kinds.length <= 3) return kinds.join(", ");
  return `${kinds.slice(0, 2).join(", ")} +${kinds.length - 2}`;
}

function forwardKindsTooltip(kinds: string[] | undefined): string {
  if (!kinds || kinds.length === 0) {
    return "All alert kinds (completed, waiting, review, error, info, …) are forwarded to this chat.";
  }
  return `Forwarding only: ${kinds.join(", ")}. Other alert kinds are filtered out for this chat.`;
}

function openTelegramSettings(): void {
  appStore.openSettingsDialog({ initialTab: "telegram" });
}
// Selection outline is only shown when the user is actively driving the list
// with the keyboard. Mouse interaction resets it so the panel doesn't look
// like the first row is already "armed" on open.
const keyboardActive = ref(false);

// Items flashing (newly arrived — stay highlighted until the user hovers
// them, so they're still findable on return to the app). Safety timeout
// ensures nothing stays glowing forever if the user ignores it.
const flashingIds = ref(new Set<string>());

// Scroll-state tracking — when the user is scrolled down reading older
// entries and a new alert arrives at the top, we surface a "N new ↑" pill
// instead of silently shifting the list under them.
const NEAR_TOP_PX = 100;
const isNearTop = ref(true);
const unseenCount = ref(0);

function onBodyScroll(): void {
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

let tickTimer: ReturnType<typeof setInterval> | undefined;
const tick = ref(0);
// Snooze gate — hide sessions whose snoozedUntil hasn't elapsed.
const now = ref(Date.now());

// Run the 30-second tick only when something is actually visible or snoozed.
// Avoids idle timers when the panel is closed and no sessions are snoozed.
function hasSnoozedSession(): boolean {
  return notifStore.sessions.some((s) => s.snoozedUntil && s.snoozedUntil > Date.now());
}

function needsTick(): boolean {
  return notifStore.pinned || notifStore.panelOpen || hasSnoozedSession();
}

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tick.value++;
    now.value = Date.now();
  }, 30_000);
}

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
}

onMounted(() => {
  if (needsTick()) startTick();
  api?.onApprovalRecorded?.(onApprovalRecorded);
});

onUnmounted(() => {
  stopTick();
});

watch(
  () => [notifStore.pinned, notifStore.panelOpen, hasSnoozedSession()] as const,
  ([pinned, open, snoozed]) => {
    if (pinned || open || snoozed) {
      startTick();
      // Immediately update now so panel opens on fresh data, not stale.
      now.value = Date.now();
    } else {
      stopTick();
    }
  },
);

function isSnoozed(s: NotificationSession): boolean {
  return !!(s.snoozedUntil && s.snoozedUntil > now.value);
}

// Flat chronological list — all non-snoozed sessions, newest first.
// Capped so the DOM doesn't grow unbounded for long-running sessions.
const MAX_TIMELINE = 50;
const visibleSessions = computed(() => {
  // Scope to this window's profile: notifStore is process-shared (loaded
  // from localStorage on every BrowserWindow), so without this filter a
  // window viewing profile B would also show profile A's notifications.
  // Sessions whose workspace no longer exists *and* are not stamped with
  // a profileId are kept (legacy / deleted-workspace history) so the
  // user doesn't lose record of them.
  const list = notifStore.sessions.filter((s) => {
    if (isSnoozed(s)) return false;
    return sessionInActiveProfile(s);
  });
  return [...list]
    .sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime())
    .slice(0, MAX_TIMELINE);
});

type TimelineRow =
  | { kind: "separator"; key: string; label: string; session?: undefined }
  | { kind: "item"; key: string; session: NotificationSession };

// Interleave sessions with day-band separator rows. Re-runs whenever the
// underlying list changes — cheap for <=50 items.
const timeline = computed((): TimelineRow[] => {
  void tick.value;
  const rows: TimelineRow[] = [];
  let lastBand = "";
  for (const s of visibleSessions.value) {
    const d = new Date(s.latestAt);
    const band = dayBandKey(d);
    if (band !== lastBand) {
      rows.push({ kind: "separator", key: `sep-${band}`, label: dayBandLabel(d) });
      lastBand = band;
    }
    rows.push({ kind: "item", key: s.id, session: s as NotificationSession });
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

// The probe runs when the dock becomes visible and whenever the profile
// changes — the two moments the answer can differ — and never while the dock
// is closed.
watch(
  () => [notifStore.pinned || notifStore.panelOpen, activeProfileId.value] as const,
  ([visible]) => {
    if (visible) void probeApprovalCount();
  },
  { immediate: true },
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

// External "open the dock on tab X" requests (the hero's running-agent chip).
// Counter-based for the same reason as focusRequestSignal: a repeat click must
// retrigger even when nothing else changed. Transient UI only.
watch(
  () => notifStore.panelTabRequestSignal,
  () => {
    const requested = notifStore.requestedPanelTab as TabId;
    if (!requested) return;
    // Asking for the approval log IS the reason to show its tab — the
    // membership check below would refuse a tab bar that has not probed yet,
    // and `showApprovals` covers whichever tab is active.
    if (requested === "approvals") {
      activeTab.value = requested;
      return;
    }
    if (menuTabs.value.some((t) => t.id === requested)) activeTab.value = requested;
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
const seenLatestAt = new Map<string, string>(); // sessionId → latestAt (ISO)
const pendingFlashIds = new Set<string>();
let flashSeeded = false;

function triggerFlash(id: string): void {
  flashingIds.value.add(id);
  // Force reactivity on the Set (Vue doesn't track Set.add mutations).
  flashingIds.value = new Set(flashingIds.value);
  // No safety timeout — flash persists until pointermove within the item
  // clears it. Using pointermove (not pointerenter) is deliberate: Chromium dispatches
  // pointerenter on layout-induced element-under-pointer changes, which would
  // wipe a flash the instant the list re-ordered under a stationary cursor.
}

function clearFlash(id: string): void {
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
function surfaceNewItem(id: string): void {
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

function relativeTime(isoString: string): string {
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

function sessionIcon(s: NotificationSession): string {
  // Checked before urgency so a permission prompt keeps the question glyph
  // instead of the generic 🚨 shared with rate limits / dead pipelines.
  if (s.events?.[0]?.kind === "question") return "❓";
  if (s.urgency === "urgent") return "🚨";
  if (s.category === "error") return "❌";
  // Rate-limit hits surface with the heavy-exclamation glyph so they read as
  // "stop and look" in the history list (the toast already shows 🚨 for the
  // matching urgent urgency).
  if (s.category === "rate-limit") return "❗";
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

function sessionTitle(s: NotificationSession): string {
  if (s.category === "review") {
    // The latest event title already reads "New comment on repo #123" etc.,
    // so prefer it over the workspace › tab composition used for terminal
    // notifications (those are nameless per-tab alerts).
    const latest = s.events?.[0];
    return latest?.title || s.workspaceName || "Pull request";
  }
  const wsName = s.workspaceName || s.workspaceId || "Workspace";
  const tab = s.tabName || s.viewId || "Tab";
  return `${wsName} › ${tab}`;
}

/** Resolve the profile name for a notification session, returns "" for unknown. */
function sessionProfileLabel(s: NotificationSession): string {
  const profileId = s.meta?.profileId || "";
  if (!profileId) return "";
  // The active profile is where the user already is — naming it on every card
  // costs a row and tells them nothing. Only a FOREIGN profile is worth the
  // tag, and that is exactly when the click also asks to switch profiles.
  // Compared against the SAME activeProfileId the visibility filter above
  // uses, so the tag and the filter can never disagree about "mine".
  if (profileId === activeProfileId.value) return "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profiles = (appStore.payload?.appState?.profiles || []) as any[];
  const profile = profiles.find((p) => p.id === profileId);
  return profile?.name || "";
}

function sessionBody(s: NotificationSession): string {
  const latest = s.events?.[0];
  if (!latest) return "";
  return latest.body || latest.title || "";
}

function itemClass(s: NotificationSession): Record<string, boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flatIdx = (visibleSessions.value as any[]).indexOf(s);
  const provider = s.meta?.provider || "";
  const providerSuffix = provider === "azure-devops" ? "azure" : provider === "github" ? "github" : "";
  // Flash (warm pulse + icon shake) is meant to draw the eye to something new.
  // Once the user has acted on the session (resolved: jumped/dismissed/snoozed),
  // the row goes grey and any ongoing flash should stop — otherwise the shake
  // keeps running on an item the user already handled.
  const shouldFlash = s.state !== "resolved" && flashingIds.value.has(s.id);
  const cls: Record<string, boolean> = {
    "notification-item--urgent": s.urgency === "urgent",
    "notification-item--unread": s.state === "waiting",
    "notification-item--selected": keyboardActive.value && flatIdx === selectedIndex.value,
    "notification-item--review": s.category === "review",
    [`notification-item--${s.state}`]: true,
    "notification-item--flash": shouldFlash,
  };
  if (s.category === "review" && providerSuffix) {
    cls[`notification-item--review-${providerSuffix}`] = true;
  }
  return cls;
}

// Build the backend sessionId for a notification session row. `viewId` is the
// full `workspaceId:panelId` key as captured in useNotificationCapture from
// `alert.sessionId` — use it directly. Prepending `workspaceId` again produced
// a malformed `workspaceId:workspaceId:panelId`, which parseSessionId
// split wrong and caused clearProjectAlerts / resetSessionSignal to no-op.
function backendSessionId(s: NotificationSession): string {
  return s.viewId || s.id;
}

function resolveJumpTarget(s: NotificationSession): { workspaceId: string; viewId: string } {
  if (s.category !== "review") {
    // Follow the tab to wherever it is currently PRESENTED: a Primary alerting
    // mid-companion-loop lives in the task workspace, and jumping to its owner
    // would land on a workspace that no longer shows it. Ownership is
    // unchanged — only the destination of this click is.
    const workspaceId = s.workspaceId || "";
    const viewId = s.viewId || "";
    const panelId = viewId.startsWith(`${workspaceId}:`) ? viewId.slice(workspaceId.length + 1) : "";
    const host = panelId ? appStore.getCompanionPrimaryHost(workspaceId, panelId) : null;
    if (host) return { workspaceId: host.taskWorkspaceId, viewId: host.viewId };
    return { workspaceId, viewId };
  }
  const workspaces = appStore.payload?.appState?.workspaces || [];
  const preferredId = s.meta?.reviewWorkspaceId || s.meta?.existingWorkspaceId || s.workspaceId || "";
  const direct = preferredId && workspaces.find((w) => w.id === preferredId);
  if (direct) return { workspaceId: direct.id, viewId: "" };
  // No review workspace yet — fall back to the provider inbox.
  const inboxKind = s.meta?.provider === "github" ? "github" : "azure";
  const activeProfile = appStore.myActiveProfileId || "default";
  const inbox = workspaces.find((w) => w.kind === inboxKind && (w.profileId || "default") === activeProfile);
  return { workspaceId: inbox?.id || "", viewId: "" };
}

/**
 * Navigate the app to a workspace/view, asking first when the target lives in
 * another profile. Shared by the Alerts jump and the Agents tab so the two
 * cannot drift; it performs navigation ONLY — no thread is resolved, cleared
 * or acknowledged here.
 */
async function navigateToTarget(target: { workspaceId: string; viewId: string }): Promise<boolean> {
  if (!target.workspaceId || !appStore.payload) return false;

  // Resolve the target workspace's profile and compare with the active profile.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const workspaces = (appStore.payload.appState?.workspaces || []) as any[];
  const targetWs = workspaces.find((w) => w.id === target.workspaceId);
  const targetProfileId = targetWs ? targetWs.profileId || "default" : null;
  const currentProfileId = appStore.myActiveProfileId || "default";

  if (targetProfileId && targetProfileId !== currentProfileId) {
    // Target session lives in another profile — ask before switching.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profiles = (appStore.payload.appState?.profiles || []) as any[];
    const targetProfile = profiles.find((p) => p.id === targetProfileId);
    const profileName = targetProfile?.name || targetProfileId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const confirmed = await (appStore as any).confirmInApp({
      title: "Switch profile?",
      message: `This session is in profile "${profileName}". Switch to that profile to open it?`,
      confirmLabel: "Switch",
      cancelLabel: "Cancel",
    });
    if (!confirmed) return false;
    const switched = await notifStore.runWithToast("Switch profile failed", () =>
      appStore.activateProfile(targetProfileId),
    );
    if (!switched) return false;
  }

  const activeWsId = appStore.myActiveWorkspaceId;
  if (activeWsId !== target.workspaceId) {
    // Route through the grid-aware wrapper so jumping to a non-grid
    // workspace from a notification doesn't dissolve the user's split.
    const opened = await notifStore.runWithToast("Open workspace failed", () =>
      appStore.activateWorkspaceInGrid(target.workspaceId),
    );
    if (!opened) return false;
  }
  if (target.viewId) {
    const opened = await notifStore.runWithToast("Open tab failed", () => appStore.activateView(target.viewId));
    if (!opened) return false;
  }
  return true;
}

async function jump(s: NotificationSession): Promise<void> {
  const target = resolveJumpTarget(s);
  if (!target.workspaceId || !appStore.payload) {
    if (!notifStore.pinned) notifStore.closePanel();
    return;
  }
  const navigated = await navigateToTarget(target);
  if (!navigated) return;

  // Connection-error notifications have no PR / review workspace to land on —
  // resolveJumpTarget routed us to the provider inbox above. Ask that inbox to
  // switch to its Connections tab and highlight the failing connection so the
  // click leads to the actual problem instead of the default PR list.
  if (s.meta?.kind === "connection-error" && s.meta?.connectionId) {
    appStore.requestInboxConnectionFocus(s.meta.provider || "", s.meta.connectionId);
  }
  // Jump = user engaged with this session → dismissed=false (resets adaptive counter).
  // Clear only after any cross-profile confirmation and navigation succeeds; a
  // cancelled switch must leave the notification actionable.
  if (s.category !== "review") {
    await notifStore.runWithToast("Clear notification failed", () =>
      notifStore.clearOnBackend(backendSessionId(s), { dismissed: false }),
    );
  }
  notifStore.setState(s.id, "resolved");
  // Pinned dock stays open — the item greys in place instead of the panel closing.
  if (!notifStore.pinned) notifStore.closePanel();
}

/**
 * Open the workspace/view a running agent lives in. Navigation only: a running
 * agent is not a notification, so no thread is resolved and no badge changes.
 */
async function openAgentRow(row: RunningAgentRow): Promise<void> {
  const navigated = await navigateToTarget({ workspaceId: row.hostWorkspaceId, viewId: row.viewId });
  if (!navigated) return;
  // A pinned dock is a place the user chose to keep open; an overlay would
  // otherwise cover the very thing they just navigated to.
  if (!notifStore.pinned) notifStore.closePanel();
}

async function dismiss(s: NotificationSession): Promise<void> {
  // Dismiss = user silenced the alert WITHOUT engaging → dismissed=true.
  // Feeds adaptive suppression for terminal alerts; review events don't
  // use adaptive suppression, so skip the backend call.
  if (s.category !== "review") {
    await notifStore.runWithToast("Clear notification failed", () =>
      notifStore.clearOnBackend(backendSessionId(s), { dismissed: true }),
    );
  }
  notifStore.setState(s.id, "resolved");
}

function snooze(s: NotificationSession): void {
  notifStore.snooze(s.id, 600_000);
}

function onClickSession(s: NotificationSession): void {
  jump(s);
}

function onKeydown(ev: KeyboardEvent): void {
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
        // Keyboard parity with the "Ack finished" button — both must scope
        // to the active profile so a Shift+A while viewing profile B
        // doesn't silence profile A's unread badge in other windows.
        ackFinishedInProfile();
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

useDismissable(() => notifStore.panelOpen && !notifStore.pinned, panelRef, {
  onDismiss: () => notifStore.closePanel(),
  eventName: "pointerdown",
  // The bell and the running-agent chip are openers living outside the panel:
  // their own click already decides what the panel should do, so the outside-
  // click dismiss must not fire first and close what they are about to open.
  ignoreSelector: "[data-role='notification-bell'], [data-role='agent-run-chip']",
});

// Close the narrow-panel tab dropdown on any pointer-down outside it. Runs
// independently of the panel dismissable above: a click on the panel body
// closes just the menu; a click outside the whole panel closes both.
useDismissable(tabMenuOpen, tabMenuRef, {
  onDismiss: () => (tabMenuOpen.value = false),
  eventName: "pointerdown",
});
</script>
