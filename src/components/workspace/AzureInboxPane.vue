<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      title="Azure DevOps"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!connections.length" class="terminal-empty" style="align-content: start; padding-top: 32px">
      <p>No Azure DevOps connections yet</p>
      <small>Add a connection with organization URL, login, PAT and review checkout path.</small>
      <div class="docker-card__actions" style="margin-top: 12px">
        <button type="button" class="button" @click="appStore.openAzureConnectionDialog('')">
          Add Azure connection
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
          <button
            type="button"
            class="button"
            title="Open the Quick-fix wizard: pick an Azure project & repo, branch off and start work without leaving the IDE."
            @click="appStore.openQuickFixWizard()"
          >
            New Branch
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']"
            :disabled="!!busyAction"
            title="Force re-poll all Azure DevOps connections now (PR list, comments, votes). Skips the configured poll interval."
            @click="handleRefresh"
          >
            {{ busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
          </button>
          <button
            type="button"
            class="button button--ghost"
            title="Add a new Azure DevOps connection (organization URL, login, PAT, project filters)."
            @click="appStore.openAzureConnectionDialog('')"
          >
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
        <span style="color: var(--danger, #e53935); white-space: pre-wrap">{{ openError }}</span>
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
          :class="[
            'azure-section',
            activeTab === tab.id && 'azure-section--active',
            tab.id === 'pipelines' && 'azure-section--fill',
          ]"
        >
          <!-- Only render heavy content for the active tab -->
          <template v-if="tab.id === 'connections' && activeTab === 'connections'">
            <div class="section-head" style="padding: 0 0 8px">
              <div>
                <p class="eyebrow">Azure DevOps Connections</p>
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
                :style="`border-left:3px solid ${conn.status === 'ok' ? 'var(--accent)' : conn.status === 'error' ? 'var(--danger)' : 'var(--muted)'};`"
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
                    <p class="docker-card__meta">{{ conn.orgUrl }}</p>
                  </div>
                  <span
                    :class="['workspace-chip', conn.status !== 'ok' && 'workspace-chip--alert']"
                    style="font-size: 10px"
                    >{{ conn.status === "ok" ? "Connected" : conn.status || "idle" }}</span
                  >
                </div>
                <div style="font-size: 12px; color: var(--muted); padding: 4px 0">
                  {{ conn.login }} · {{ conn.projectFilters?.join(", ") || "all projects" }} · poll
                  {{ conn.pollSeconds || 120 }}s
                </div>
                <div v-if="conn.lastError" class="connection-error"><strong>Error:</strong> {{ conn.lastError }}</div>
                <div v-if="conn.lastSyncAt" style="font-size: 11px; color: var(--muted); padding: 2px 0">
                  Last sync: {{ new Date(conn.lastSyncAt).toLocaleString() }}
                </div>
                <div class="docker-card__actions docker-card__actions--end">
                  <button
                    type="button"
                    class="button button--ghost"
                    title="Edit this connection (organization URL, PAT, project filters, poll interval, review root)."
                    @click="appStore.openAzureConnectionDialog(conn.id)"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    :class="['button', 'button--ghost', 'danger', busyAction === `delete-${conn.id}` && 'button--busy']"
                    :disabled="!!busyAction"
                    title="Delete this Azure DevOps connection. PR cache and audit log entries for it remain on disk."
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
              📂 Review root: <code>{{ reviewRoot || "not set" }}</code>
            </div>
          </template>
          <!-- Activity log tab -->
          <template v-else-if="tab.id === 'activity' && activeTab === 'activity'">
            <AzureAuditLog />
          </template>
          <!-- Pipelines tab -->
          <template v-else-if="tab.id === 'pipelines' && activeTab === 'pipelines'">
            <AzurePipelinesTab :connections="connections" :workspace-id="workspaceId" />
          </template>
          <!-- PR list tabs — only render when this tab is active -->
          <template v-else-if="activeTab === tab.id">
            <div
              v-if="
                hasActiveFilters || (tabItems(activeTab).length && (repoNames.length > 1 || authorOptions.length > 1))
              "
              class="azure-inbox__filters"
            >
              <div v-if="repoNames.length > 1 || repoFilter" class="azure-inbox__filter-row">
                <span class="azure-inbox__filter-label">Repo</span>
                <button
                  type="button"
                  :class="['button', 'button--ghost', 'azure-inbox__filter-button', !repoFilter && 'button--active']"
                  title="Show pull requests across every project / repository."
                  @click="repoFilter = ''"
                >
                  All repos
                </button>
                <button
                  v-for="repo in repoNames"
                  :key="repo"
                  type="button"
                  :class="[
                    'button',
                    'button--ghost',
                    'azure-inbox__filter-button',
                    repoFilter === repo && 'button--active',
                  ]"
                  :title="`Show only PRs from ${repo}.`"
                  @click="repoFilter = repoFilter === repo ? '' : repo"
                >
                  {{ repo }}
                </button>
              </div>
              <div v-if="authorOptions.length > 1 || authorFilter" class="azure-inbox__filter-row">
                <span class="azure-inbox__filter-label">Author</span>
                <template v-if="authorOptions.length <= 5">
                  <button
                    type="button"
                    :class="[
                      'button',
                      'button--ghost',
                      'azure-inbox__filter-button',
                      !authorFilter && 'button--active',
                    ]"
                    @click="authorFilter = ''"
                  >
                    All authors
                  </button>
                  <button
                    v-for="author in authorOptions"
                    :key="author.key"
                    type="button"
                    :class="[
                      'button',
                      'button--ghost',
                      'azure-inbox__filter-button',
                      authorFilter === author.key && 'button--active',
                    ]"
                    :title="author.uniqueName || author.label"
                    @click="authorFilter = authorFilter === author.key ? '' : author.key"
                  >
                    {{ author.label }}
                  </button>
                </template>
                <select
                  v-else
                  v-model="authorFilter"
                  class="azure-inbox__author-select"
                  aria-label="Filter pull requests by author"
                >
                  <option value="">All authors</option>
                  <option v-for="author in authorOptions" :key="author.key" :value="author.key">
                    {{ author.label }}
                  </option>
                </select>
              </div>
            </div>
            <!-- Needs Attention: same visual frame as the All tab (azure-repo-group),
                 but the groups are sub-buckets by *why* the PR needs attention
                 (reviewer / author / comments / other) instead of by repo. -->
            <template v-if="tab.id === 'attention' && attentionGroupedItems.length">
              <div v-for="grp in attentionGroupedItems" :key="grp.bucket" class="azure-repo-group">
                <div class="azure-repo-group__header">
                  <span class="azure-repo-group__name">{{ grp.label }}</span>
                  <span class="azure-repo-group__count">{{ grp.items.length }}</span>
                  <small class="azure-repo-group__hint">{{ grp.hint }}</small>
                </div>
                <AzurePrRow
                  v-for="item in grp.items"
                  :key="item.prKey"
                  :item="item"
                  :show-seen="true"
                  :opening="item.prKey === openingPrKey"
                  @open="onOpenPr"
                  @browser="onOpenBrowser"
                  @seen="onMarkSeen"
                />
              </div>
            </template>
            <template v-else-if="activeGroupedItems.length">
              <div v-for="group in activeGroupedItems" :key="group.repo" class="azure-repo-group">
                <div v-if="!repoFilter && repoNames.length > 1" class="azure-repo-group__header">
                  <span class="azure-repo-group__name">{{ group.repo }}</span>
                  <span class="azure-repo-group__count">{{ group.items.length }}</span>
                </div>
                <AzurePrRow
                  v-for="item in group.items"
                  :key="item.prKey"
                  :item="item"
                  :show-seen="activeTab !== 'all'"
                  :opening="item.prKey === openingPrKey"
                  @open="onOpenPr"
                  @browser="onOpenBrowser"
                  @seen="onMarkSeen"
                />
              </div>
            </template>
            <div v-else class="azure-empty">
              <p>{{ hasActiveFilters ? "No pull requests match the selected filters." : tab.emptyMessage }}</p>
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
import { useAzurePipelinesStore } from "../../stores/azure-pipelines.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import PaneShell from "../layout/PaneShell.vue";
import AzurePrRow from "./azure/AzurePrRow.vue";
import AzureAuditLog from "./azure/AzureAuditLog.vue";
import AzurePipelinesTab from "./azure/AzurePipelinesTab.vue";

withDefaults(defineProps<{ workspaceId: string; showHeader?: boolean }>(), { showHeader: false });

const appStore = useAppStore();
const pipelinesStore = useAzurePipelinesStore();
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
// prKey currently being opened — drives the per-row spinner and disables the
// button so a slow clone/checkout can't be double-clicked. Single-flight:
// while one PR is opening, other Review buttons are ignored too.
const openingPrKey = ref<string>("");
// Default to the "Needs attention" tab so the most actionable items surface
// first — explicit reviewers, mentions, your-PR comments. Falls back to the
// generic All tab when there's nothing actionable yet.
const activeTab = ref<string>("attention");
const openError = ref<string>("");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const azureData = computed<Record<string, any>>(() => appStore.payload?.azureDevops || {});
// Backend's snapshot now ships connections for every open profile so a save
// in a non-primary window doesn't disappear (see getAzureConnections). Each
// window shows only its own profile's connections — without this filter,
// multi-window setups would see every other window's connections too.

const connections = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (azureData.value.connections || []) as any[];
  const myProfileId = appStore.myActiveProfileId || "default";
  return all.filter((c) => (c.profileId || "default") === myProfileId);
});
// PR summaries in the backend snapshot aggregate across all profiles. Scope
// them to this window by keeping only PRs whose connection belongs to the
// filtered `connections` list. Without this, a window viewing profile A
// still showed PR counts and listings for profile B's connections — and
// clicking Review on one of those leaked PRs created the review sub-
// workspace under profile B, surfacing the cross-profile leak visibly.
const myConnectionIds = computed(() => new Set(connections.value.map((c) => c.id)));
const inbox = computed(() => {
  const raw = azureData.value.inbox || {};
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
const reviewRoot = computed(() => appStore.payload?.appState?.settings?.integrations?.azureDevops?.reviewRoot || "");

// Deep-link: when the user clicks a "connection error" notification, the
// store carries a focus request. If it targets one of this pane's
// connections, switch to the Connections tab and highlight + scroll to it so
// the failing connection is immediately obvious (red border + ❗ already mark
// it; the highlight outline shows which one was clicked). Match on connection
// id membership — ids are unique per provider, so the wrong pane never reacts.
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

// Pipelines with a failed/canceled latest run — surfaced as the Pipelines tab
// badge so failures stand out without opening the tab. Reflects whatever the
// pipelines store has loaded (see the eager background load below).
const failingPipelineCount = computed(() => {
  let n = 0;
  for (const c of connections.value) {
    const entry = pipelinesStore.byConnection[c.id];
    if (!entry) continue;
    for (const p of entry.pipelines) {
      const result = (p.lastRun?.result || "").toLowerCase();
      if (result === "failed" || result === "canceled") n++;
    }
  }
  return n;
});

// Eagerly load pipelines for this profile's connections so the failing badge
// populates without opening the tab. Cached in the store — re-runs only when
// the connection set changes, not on every render.
watch(
  () => connections.value.map((c) => c.id).join(","),
  () => {
    for (const c of connections.value) void pipelinesStore.load(c.id);
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
    id: "pipelines",
    label: "Pipelines",
    count: failingPipelineCount.value || null,
    alert: failingPipelineCount.value > 0,
  },
  {
    id: "connections",
    label: "Connections",
    count: connections.value.length,
    alert: connections.value.some((c) => c.status === "error"),
  },
  { id: "activity", label: "Activity Log", count: null, alert: false },
]);

const repoFilter = ref<string>("");
const authorFilter = ref<string>("");

const activeTabInfo = computed(() => inboxTabs.value.find((t) => t.id === activeTab.value) || inboxTabs.value[0]);

function tabItems(tabId: string) {
  if (tabId === "all") return inbox.value.recentlyUpdated || [];
  if (tabId === "attention") return inbox.value.needsAttention || [];
  if (tabId === "needs-review") return inbox.value.needsMyReview || [];
  if (tabId === "my-prs") return inbox.value.myPullRequests || [];
  return [];
}

function repoKey(item: { project?: { name?: string }; repository?: { name?: string } }) {
  return `${item.project?.name || ""}/${item.repository?.name || ""}`;
}

// Repo names offered as filter buttons — faceted: when an author is selected,
// only repos that actually contain PRs by that author are listed (and vice
// versa for authorOptions below).
const repoNames = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = inbox.value.recentlyUpdated || [];
  const items = authorFilter.value ? all.filter((item) => authorKey(item) === authorFilter.value) : all;
  const names = [...new Set(items.map(repoKey))];
  return names.sort();
});

function authorKey(item: { author?: { id?: string; uniqueName?: string; displayName?: string } }) {
  const author = item.author || {};
  return author.id || author.uniqueName || author.displayName || "unknown-author";
}

const authorOptions = computed(() => {
  const authors = new Map<string, { key: string; label: string; uniqueName: string }>();
  for (const item of inbox.value.recentlyUpdated || []) {
    if (repoFilter.value && repoKey(item) !== repoFilter.value) continue;
    const key = authorKey(item);
    if (authors.has(key)) continue;
    authors.set(key, {
      key,
      label: item.author?.displayName || item.author?.uniqueName || "Unknown author",
      uniqueName: item.author?.uniqueName || "",
    });
  }
  return [...authors.values()].sort((a, b) => a.label.localeCompare(b.label));
});

// Keep a stale selection from silently hiding everything when the facet it
// came from disappears (data refresh or cross-filter narrowing).
watch(authorOptions, (options) => {
  if (authorFilter.value && !options.some((author) => author.key === authorFilter.value)) {
    authorFilter.value = "";
  }
});

watch(repoNames, (names) => {
  if (repoFilter.value && !names.includes(repoFilter.value)) {
    repoFilter.value = "";
  }
});

const hasActiveFilters = computed(() => Boolean(repoFilter.value || authorFilter.value));

function matchesActiveFilters(item: {
  project?: { name?: string };
  repository?: { name?: string };
  author?: { id?: string; uniqueName?: string; displayName?: string };
}) {
  if (repoFilter.value && repoKey(item) !== repoFilter.value) {
    return false;
  }
  return !authorFilter.value || authorKey(item) === authorFilter.value;
}

// Sub-buckets for the "Needs attention" tab: route reviews-of-mine /
// commented-on / mine-as-author into the same screen but split by source.
// First-match wins (no double-counting); the catch-all "other" bucket
// always returns true so anything that didn't match earlier falls through.
const attentionBuckets = [
  {
    bucket: "reviewer",
    label: "You were asked to review",
    hint: "PRs where you are an explicit reviewer with new activity since you last looked.",
    test: (item: { role?: string }) => item.role === "reviewer",
  },
  {
    bucket: "author",
    label: "Your PRs need a look",
    hint: "Pull requests you opened that received a vote, comment, or build update since you last visited.",
    test: (item: { role?: string }) => item.role === "author",
  },
  {
    bucket: "comments",
    label: "New comments on PRs you watch",
    hint: "Comments / replies on pull requests you neither own nor review but follow.",
    test: (item: { role?: string; attentionReason?: string }) =>
      item.role !== "reviewer" && item.role !== "author" && /comment|reply|mention/i.test(item.attentionReason || ""),
  },
  {
    bucket: "other",
    label: "Other activity",
    hint: "Everything else flagged for your attention (build status changes, conflict, etc.).",
    test: () => true,
  },
];

const attentionGroupedItems = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = [...(inbox.value.needsAttention || [])].filter(matchesActiveFilters);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buckets: { bucket: string; label: string; hint: string; items: any[] }[] = attentionBuckets.map((b) => ({
    bucket: b.bucket,
    label: b.label,
    hint: b.hint,
    items: [],
  }));
  outer: for (const item of items) {
    for (let i = 0; i < attentionBuckets.length; i++) {
      if (attentionBuckets[i].test(item)) {
        buckets[i].items.push(item);
        continue outer;
      }
    }
  }
  return buckets.filter((b) => b.items.length);
});

// Group items by project/repo for the active tab, cached as computed
const activeGroupedItems = computed(() => {
  const items: unknown[] = tabItems(activeTab.value).filter(matchesActiveFilters);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups = new Map<string, any[]>();
  for (const item of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyItem = item as any;
    const repo = `${anyItem.project?.name || ""}/${anyItem.repository?.name || ""}`;
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo)!.push(anyItem);
  }
  return [...groups.entries()].map(([repo, items]) => ({ repo, items }));
});

const headerStatus = computed(() => `${inbox.value.recentlyUpdated?.length || 0} PRs`);
const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "refresh-azure", title: "Refresh Azure DevOps", label: "↻" },
]);

async function handleRefresh() {
  busyAction.value = "refresh";
  try {
    await appStore.refreshAzure();
  } finally {
    busyAction.value = "";
  }
}

async function handleDeleteConnection(connId: string) {
  busyAction.value = `delete-${connId}`;
  try {
    await appStore.deleteAzureConnection(connId);
  } finally {
    busyAction.value = "";
  }
}

function onHeaderAction(action: { action: string }) {
  if (action.action === "refresh-azure") handleRefresh();
}

async function onOpenPr({ prKey, workspaceId }: { prKey: string; workspaceId: string }) {
  if (openingPrKey.value) return; // already opening one — ignore extra clicks
  openError.value = "";
  openingPrKey.value = prKey;
  try {
    await appStore.openAzurePullRequest(prKey, workspaceId);
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
  appStore.markAzurePrSeen(prKey);
}
</script>
