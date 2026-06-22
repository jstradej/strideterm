<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      title="GitHub"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!connections.length" class="terminal-empty" style="align-content: start; padding-top: 32px">
      <p>No GitHub connections yet</p>
      <small>Add a connection with host URL, PAT, and review checkout path.</small>
      <div class="docker-card__actions" style="margin-top: 12px">
        <button type="button" class="button" @click="appStore.openGitHubConnectionDialog('')">
          Add GitHub connection
        </button>
      </div>
    </div>
    <div
      v-else
      :class="[
        'azure-inbox',
        isMobile && menuOpen && 'azure-inbox--menu-open',
        isMobile && tabsMenuOpen && 'azure-inbox--tabs-menu-open',
      ]"
    >
      <button
        v-if="isMobile"
        type="button"
        class="azure-inbox__tabs-trigger"
        :aria-expanded="tabsMenuOpen"
        :aria-label="tabsMenuOpen ? 'Close tabs menu' : 'Open tabs menu'"
        @click="toggleTabsMenu"
      >
        <span class="azure-inbox__tabs-trigger__label">{{ activeTabInfo.label }}</span>
        <span v-if="activeTabInfo.count != null" class="azure-tab__count">{{ activeTabInfo.count }}</span>
        <span class="azure-inbox__tabs-trigger__caret" aria-hidden="true">▼</span>
      </button>
      <button
        v-if="isMobile"
        type="button"
        class="azure-inbox__menu-trigger"
        :aria-expanded="menuOpen"
        :aria-label="menuOpen ? 'Close actions menu' : 'Open actions menu'"
        @click="toggleActionsMenu"
      >
        <span class="azure-inbox__menu-trigger__dot" aria-hidden="true">⋮</span>
        <span>{{ menuOpen ? "Close" : "Actions" }}</span>
      </button>
      <div
        v-if="isMobile && (menuOpen || tabsMenuOpen)"
        class="azure-inbox__menu-backdrop"
        aria-hidden="true"
        @click="closeAllMenus"
      ></div>
      <div class="azure-inbox__toolbar">
        <div class="azure-inbox__tabs">
          <button
            v-for="tab in inboxTabs"
            :key="tab.id"
            type="button"
            :class="['azure-tab', activeTab === tab.id && 'azure-tab--active', tab.alert && 'azure-tab--alert']"
            @click="onTabClick(tab.id)"
          >
            {{ tab.label }} <span v-if="tab.count != null" class="azure-tab__count">{{ tab.count }}</span>
          </button>
        </div>
        <div class="azure-inbox__actions">
          <button type="button" class="button" @click="appStore.openGitHubQuickFixWizard()">New Branch</button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']"
            :disabled="!!busyAction"
            @click="handleRefresh"
          >
            {{ busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
          </button>
          <button type="button" class="button button--ghost" @click="appStore.openGitHubConnectionDialog('')">
            Add connection
          </button>
        </div>
      </div>

      <div
        v-if="openError"
        style="
          padding: 8px 12px;
          font-size: 12px;
          background: rgba(255, 80, 80, 0.08);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          gap: 8px;
        "
      >
        <span style="color: var(--danger, #e53935)">{{ openError }}</span>
        <button
          type="button"
          class="button button--ghost"
          style="font-size: 10px; padding: 1px 8px; margin-left: auto"
          @click="openError = ''"
        >
          Dismiss
        </button>
      </div>
      <div class="azure-inbox__content">
        <section
          v-for="tab in inboxTabs"
          :key="tab.id"
          :class="['azure-section', activeTab === tab.id && 'azure-section--active']"
        >
          <!-- Connections tab -->
          <template v-if="tab.id === 'connections' && activeTab === 'connections'">
            <div class="section-head" style="padding: 0 0 8px">
              <div>
                <p class="eyebrow">GitHub Connections</p>
                <h3>{{ connections.length }} connection{{ connections.length !== 1 ? "s" : "" }}</h3>
              </div>
            </div>
            <div ref="connectionListRef" class="docker-list azure-connection-list" style="gap: 8px">
              <article
                v-for="conn in connections"
                :key="conn.id"
                :data-connection-id="conn.id"
                :class="[
                  'docker-card',
                  conn.status === 'error' && 'connection-card--error',
                  highlightedConnectionId === conn.id && 'connection-card--focus',
                ]"
                :style="`border-left:3px solid ${conn.status === 'ok' ? '#238636' : conn.status === 'error' ? 'var(--danger)' : 'var(--muted)'};`"
              >
                <div class="docker-card__head">
                  <div>
                    <h4>
                      <span
                        v-if="conn.status === 'error'"
                        class="connection-card__alert"
                        title="This connection has an error — see the details below."
                        >❗</span
                      >{{ conn.label }}
                    </h4>
                    <p class="docker-card__meta">{{ conn.hostUrl }} · {{ conn.currentUserLogin || "unknown user" }}</p>
                  </div>
                  <span
                    :class="['workspace-chip', conn.status !== 'ok' && 'workspace-chip--alert']"
                    style="font-size: 10px"
                    >{{ conn.status === "ok" ? "Connected" : conn.status || "idle" }}</span
                  >
                </div>
                <div style="font-size: 12px; color: var(--muted); padding: 4px 0">
                  {{ conn.ownerFilters?.length ? conn.ownerFilters.join(", ") : "all owners"
                  }}{{ conn.repositoryFilters?.length ? ` · ${conn.repositoryFilters.join(", ")}` : "" }} · poll
                  {{ conn.pollSeconds || 120 }}s
                </div>
                <div v-if="conn.lastError" class="connection-error"><strong>Error:</strong> {{ conn.lastError }}</div>
                <div v-if="conn.lastSyncAt" style="font-size: 11px; color: var(--muted); padding: 2px 0">
                  Last sync: {{ new Date(conn.lastSyncAt).toLocaleString() }}
                </div>
                <div class="docker-card__actions">
                  <button
                    type="button"
                    class="button button--ghost"
                    @click="appStore.openGitHubConnectionDialog(conn.id)"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    :class="['button', 'button--ghost', 'danger', busyAction === `delete-${conn.id}` && 'button--busy']"
                    :disabled="!!busyAction"
                    @click="handleDeleteConnection(conn.id)"
                  >
                    Delete
                  </button>
                </div>
              </article>
            </div>
            <div
              style="
                margin-top: 12px;
                padding: 8px 10px;
                font-size: 12px;
                color: var(--muted);
                border-top: 1px solid var(--border);
              "
            >
              Review root: <code>{{ reviewRoot || "not set" }}</code>
            </div>
          </template>
          <!-- Activity log tab -->
          <template v-else-if="tab.id === 'activity' && activeTab === 'activity'">
            <AuditLog provider="github" />
          </template>
          <!-- PR list tabs -->
          <template v-else-if="activeTab === tab.id">
            <div
              v-if="repoNames.length > 1 && tabItems(activeTab).length"
              style="display: flex; gap: 4px; padding: 0 12px 8px; flex-wrap: wrap"
            >
              <button
                type="button"
                :class="['button', 'button--ghost']"
                :style="
                  !repoFilter
                    ? 'font-size:11px;padding:2px 8px;background:var(--accent);color:var(--bg);'
                    : 'font-size:11px;padding:2px 8px;'
                "
                @click="repoFilter = ''"
              >
                All repos
              </button>
              <button
                v-for="repo in repoNames"
                :key="repo"
                type="button"
                :class="['button', 'button--ghost']"
                :style="
                  repoFilter === repo
                    ? 'font-size:11px;padding:2px 8px;background:var(--accent);color:var(--bg);'
                    : 'font-size:11px;padding:2px 8px;'
                "
                @click="repoFilter = repoFilter === repo ? '' : repo"
              >
                {{ repo }}
              </button>
            </div>
            <template v-if="activeGroupedItems.length">
              <div v-for="group in activeGroupedItems" :key="group.repo" class="azure-repo-group">
                <div v-if="!repoFilter && repoNames.length > 1" class="azure-repo-group__header">
                  <span class="azure-repo-group__name">{{ group.repo }}</span>
                  <span class="azure-repo-group__count">{{ group.items.length }}</span>
                </div>
                <GitHubPrRow
                  v-for="item in group.items"
                  :key="item.prKey"
                  :item="item"
                  :opening="item.prKey === openingPrKey"
                  @open="onOpenPr"
                  @browser="onOpenBrowser"
                  @seen="onMarkSeen"
                />
              </div>
            </template>
            <div v-else class="azure-empty">
              <p>{{ tab.emptyMessage }}</p>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import PaneShell from "../layout/PaneShell.vue";
import GitHubPrRow from "./github/GitHubPrRow.vue";
import AuditLog from "./azure/AzureAuditLog.vue";

withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean }>(), { showHeader: false });

const appStore = useAppStore();
const { isMobile } = useIsNarrow();
const menuOpen = ref(false);
const tabsMenuOpen = ref(false);

watch(isMobile, (mobile) => {
  if (!mobile) {
    menuOpen.value = false;
    tabsMenuOpen.value = false;
  }
});

function toggleActionsMenu() {
  if (menuOpen.value) {
    menuOpen.value = false;
  } else {
    menuOpen.value = true;
    tabsMenuOpen.value = false;
  }
}

function toggleTabsMenu() {
  if (tabsMenuOpen.value) {
    tabsMenuOpen.value = false;
  } else {
    tabsMenuOpen.value = true;
    menuOpen.value = false;
  }
}

function closeAllMenus() {
  menuOpen.value = false;
  tabsMenuOpen.value = false;
}

function onTabClick(id: string) {
  activeTab.value = id;
  if (tabsMenuOpen.value) tabsMenuOpen.value = false;
}

const busyAction = ref<string>("");
const activeTab = ref<string>("all");
const repoFilter = ref<string>("");

const activeTabInfo = computed(() => inboxTabs.value.find((t) => t.id === activeTab.value) || inboxTabs.value[0]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const githubData = computed<Record<string, any>>(() => (appStore.payload?.github as any) || {});
// Backend ships connections for every open profile (see getGitHubConnections).
// Each window shows only its own profile's connections.
const connections = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (githubData.value.connections || []) as any[];
  const myProfileId = appStore.myActiveProfileId || "default";
  return all.filter((c) => (c.profileId || "default") === myProfileId);
});
// See AzureInboxPane: scope inbox PR lists to this window's profile, otherwise
// PR counts and listings leak across profiles and clicking Review on a leaked
// PR creates the review workspace on the connection's (other) profile.
const myConnectionIds = computed(() => new Set(connections.value.map((c) => c.id)));
const inbox = computed(() => {
  const raw = githubData.value.inbox || {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mine = (prs: any) =>
    Array.isArray(prs)
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (prs as any[]).filter((pr) => myConnectionIds.value.has(pr.connectionId))
      : [];
  return {
    ...raw,
    needsAttention: mine(raw.needsAttention),
    needsMyReview: mine(raw.needsMyReview),
    myPullRequests: mine(raw.myPullRequests),
    recentlyUpdated: mine(raw.recentlyUpdated),
  };
});
const reviewRoot = computed(() => appStore.payload?.appState?.settings?.integrations?.github?.reviewRoot || "");

// Deep-link from a "connection error" notification — mirror of AzureInboxPane:
// switch to the Connections tab and highlight + scroll to the failing
// connection. Matches on connection id membership so only the owning pane reacts.
const connectionListRef = ref<HTMLElement | null>(null);
const highlightedConnectionId = ref("");
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => appStore.inboxConnectionFocus,
  (req) => {
    if (!req?.connectionId) return;
    if (Date.now() - req.ts > 15000) return; // stale request — don't hijack a later visit
    if (!myConnectionIds.value.has(req.connectionId)) return; // belongs to another pane
    appStore.inboxConnectionFocus = null; // consume so it fires once
    activeTab.value = "connections";
    highlightedConnectionId.value = req.connectionId;
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => (highlightedConnectionId.value = ""), 4000);
    nextTick(() => {
      connectionListRef.value
        ?.querySelector(`[data-connection-id="${req.connectionId}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  },
  { immediate: true },
);

const inboxTabs = computed(() => [
  {
    id: "all",
    label: "All",
    count: inbox.value.recentlyUpdated?.length || 0,
    alert: false,
    emptyMessage: "No active pull requests.",
  },
  {
    id: "attention",
    label: "Needs attention",
    count: inbox.value.needsAttention?.length || 0,
    alert: !!inbox.value.needsAttention?.length,
    emptyMessage: "No pull requests need your attention right now.",
  },
  {
    id: "needs-review",
    label: "Needs review",
    count: inbox.value.needsMyReview?.length || 0,
    alert: false,
    emptyMessage: "No pull requests waiting for your review.",
  },
  {
    id: "my-prs",
    label: "My PRs",
    count: inbox.value.myPullRequests?.length || 0,
    alert: false,
    emptyMessage: "You have no active pull requests.",
  },
  {
    id: "connections",
    label: "Connections",
    count: connections.value.length,
    alert: connections.value.some((c) => c.status === "error"),
  },
  { id: "activity", label: "Activity Log", count: null, alert: false },
]);

function tabItems(tabId: string) {
  if (tabId === "all") return inbox.value.recentlyUpdated || [];
  if (tabId === "attention") return inbox.value.needsAttention || [];
  if (tabId === "needs-review") return inbox.value.needsMyReview || [];
  if (tabId === "my-prs") return inbox.value.myPullRequests || [];
  return [];
}

const repoNames = computed(() => {
  const all: unknown[] = inbox.value.recentlyUpdated || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const names = [...new Set(all.map((item: any) => item.repository?.fullName || ""))];
  return names.sort();
});

const activeGroupedItems = computed(() => {
  let items: unknown[] = tabItems(activeTab.value);
  if (repoFilter.value) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items = items.filter((item: any) => (item.repository?.fullName || "") === repoFilter.value);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups = new Map<string, any[]>();
  for (const item of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyItem = item as any;
    const repo = anyItem.repository?.fullName || "";
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo)!.push(anyItem);
  }
  return [...groups.entries()].map(([repo, items]) => ({ repo, items }));
});

const headerStatus = computed(() => `${inbox.value.recentlyUpdated?.length || 0} PRs`);
const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "refresh-github", title: "Refresh GitHub", label: "\u21BB" },
]);

async function handleRefresh() {
  busyAction.value = "refresh";
  try {
    await appStore.refreshGitHub();
  } finally {
    busyAction.value = "";
  }
}

async function handleDeleteConnection(connId: string) {
  busyAction.value = `delete-${connId}`;
  try {
    await appStore.deleteGitHubConnection(connId);
  } finally {
    busyAction.value = "";
  }
}

function onHeaderAction(action: { action: string }) {
  if (action.action === "refresh-github") handleRefresh();
}

const openError = ref<string>("");
// prKey currently being opened — drives the per-row spinner and disables the
// button so a slow clone/checkout can't be double-clicked. Single-flight:
// while one PR is opening, other Review buttons are ignored too.
const openingPrKey = ref<string>("");

async function onOpenPr({ prKey, workspaceId }: { prKey: string; workspaceId: string }) {
  if (openingPrKey.value) return; // already opening one — ignore extra clicks
  openError.value = "";
  openingPrKey.value = prKey;
  try {
    await appStore.openGitHubPullRequest(prKey, workspaceId);
  } catch (err) {
    openError.value = (err as Error)?.message || "Failed to open review workspace.";
  } finally {
    openingPrKey.value = "";
  }
}

function onOpenBrowser(url: string) {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

function onMarkSeen(prKey: string) {
  appStore.markGitHubPrSeen(prKey);
}
</script>
