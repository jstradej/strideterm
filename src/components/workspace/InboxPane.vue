<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="isGitHub ? 'GitHub' : 'Azure DevOps'"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!connections.length" class="terminal-empty" style="align-content: start; padding-top: 32px">
      <p>{{ isGitHub ? "No GitHub connections yet" : "No Azure DevOps connections yet" }}</p>
      <small>{{
        isGitHub
          ? "Add a connection with host URL, PAT, and review checkout path."
          : "Add a connection with organization URL, login, PAT and review checkout path."
      }}</small>
      <div class="docker-card__actions" style="margin-top: 12px">
        <button type="button" class="button" @click="openConnectionDialog('')">
          {{ isGitHub ? "Add GitHub connection" : "Add Azure connection" }}
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
            :title="
              isGitHub
                ? undefined
                : 'Open the Quick-fix wizard: pick an Azure project & repo, branch off and start work without leaving the IDE.'
            "
            @click="openQuickFixWizard"
          >
            New Branch
          </button>
          <button
            type="button"
            :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']"
            :disabled="!!busyAction"
            :title="
              isGitHub
                ? undefined
                : 'Force re-poll all Azure DevOps connections now (PR list, comments, votes). Skips the configured poll interval.'
            "
            @click="handleRefresh"
          >
            {{ busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
          </button>
          <button
            type="button"
            class="button button--ghost"
            :title="isGitHub ? undefined : 'Add a new Azure DevOps connection (organization URL, login, PAT, project filters).'"
            @click="openConnectionDialog('')"
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
        <span :style="{ color: 'var(--danger, #e53935)', whiteSpace: isGitHub ? 'normal' : 'pre-wrap' }">{{
          openError
        }}</span>
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
          <!-- Connections tab -->
          <template v-if="tab.id === 'connections' && activeTab === 'connections'">
            <div class="section-head" style="padding: 0 0 8px">
              <div>
                <p class="eyebrow">{{ isGitHub ? "GitHub" : "Azure DevOps" }} Connections</p>
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
                :style="`border-left:3px solid ${conn.status === 'ok' ? (isGitHub ? '#238636' : 'var(--accent)') : conn.status === 'error' ? 'var(--danger)' : 'var(--muted)'};`"
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
                    <p v-if="isGitHub" class="docker-card__meta">
                      {{ conn.hostUrl }} · {{ conn.currentUserLogin || "unknown user" }}
                    </p>
                    <p v-else class="docker-card__meta">{{ conn.orgUrl }}</p>
                  </div>
                  <span
                    :class="['workspace-chip', conn.status !== 'ok' && 'workspace-chip--alert']"
                    style="font-size: 10px"
                    >{{ conn.status === "ok" ? "Connected" : conn.status || "idle" }}</span
                  >
                </div>
                <div v-if="isGitHub" style="font-size: 12px; color: var(--muted); padding: 4px 0">
                  {{ conn.ownerFilters?.length ? conn.ownerFilters.join(", ") : "all owners"
                  }}{{ conn.repositoryFilters?.length ? ` · ${conn.repositoryFilters.join(", ")}` : "" }} · poll
                  {{ conn.pollSeconds || 120 }}s
                </div>
                <div v-else style="font-size: 12px; color: var(--muted); padding: 4px 0">
                  {{ conn.login }} · {{ conn.projectFilters?.join(", ") || "all projects" }} · poll
                  {{ conn.pollSeconds || 120 }}s
                </div>
                <div v-if="conn.lastError" class="connection-error"><strong>Error:</strong> {{ conn.lastError }}</div>
                <div v-if="conn.lastSyncAt" style="font-size: 11px; color: var(--muted); padding: 2px 0">
                  Last sync: {{ new Date(conn.lastSyncAt).toLocaleString() }}
                </div>
                <div :class="['docker-card__actions', !isGitHub && 'docker-card__actions--end']">
                  <button
                    type="button"
                    class="button button--ghost"
                    :title="
                      isGitHub
                        ? undefined
                        : 'Edit this connection (organization URL, PAT, project filters, poll interval, review root).'
                    "
                    @click="openConnectionDialog(conn.id)"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    :class="['button', 'button--ghost', 'danger', busyAction === `delete-${conn.id}` && 'button--busy']"
                    :disabled="!!busyAction"
                    :title="
                      isGitHub
                        ? undefined
                        : 'Delete this Azure DevOps connection. PR cache and audit log entries for it remain on disk.'
                    "
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
              {{ isGitHub ? "" : "📂 " }}Review root: <code>{{ reviewRoot || "not set" }}</code>
            </div>
          </template>
          <!-- Activity log tab -->
          <template v-else-if="tab.id === 'activity' && activeTab === 'activity'">
            <AuditLog :provider="provider" />
          </template>
          <!-- Pipelines tab (Azure only) -->
          <template v-else-if="tab.id === 'pipelines' && activeTab === 'pipelines'">
            <AzurePipelinesTab :connections="connections" :workspace-id="workspaceId" />
          </template>
          <!-- PR list tabs -->
          <template v-else-if="activeTab === tab.id">
            <!-- Azure: repo + author faceted filters -->
            <div
              v-if="
                !isGitHub &&
                (hasActiveFilters || (tabItems(activeTab).length && (repoNames.length > 1 || authorOptions.length > 1)))
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
            <!-- GitHub: simple repo filter -->
            <div
              v-if="isGitHub && repoNames.length > 1 && tabItems(activeTab).length"
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
            <!-- Needs Attention (Azure only): same visual frame as the All tab
                 (azure-repo-group), but the groups are sub-buckets by *why* the
                 PR needs attention (reviewer / author / comments / other)
                 instead of by repo. -->
            <template v-if="!isGitHub && tab.id === 'attention' && attentionGroupedItems.length">
              <div v-for="grp in attentionGroupedItems" :key="grp.bucket" class="azure-repo-group">
                <div class="azure-repo-group__header">
                  <span class="azure-repo-group__name">{{ grp.label }}</span>
                  <span class="azure-repo-group__count">{{ grp.items.length }}</span>
                  <small class="azure-repo-group__hint">{{ grp.hint }}</small>
                </div>
                <PrRow
                  v-for="item in grp.items"
                  :key="item.prKey"
                  :item="item"
                  :provider="provider"
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
                <PrRow
                  v-for="item in group.items"
                  :key="item.prKey"
                  :item="item"
                  :provider="provider"
                  :show-seen="isGitHub ? undefined : activeTab !== 'all'"
                  :opening="item.prKey === openingPrKey"
                  @open="onOpenPr"
                  @browser="onOpenBrowser"
                  @seen="onMarkSeen"
                />
              </div>
            </template>
            <div v-else class="azure-empty">
              <p>{{ !isGitHub && hasActiveFilters ? "No pull requests match the selected filters." : tab.emptyMessage }}</p>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useAzurePipelinesStore } from "../../stores/azure-pipelines.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { useMobileShellMenus } from "../../composables/useMobileShellMenus.js";
import { useResourceInterest } from "../../composables/useResourceInterest.js";
import { useInboxConnectionFocus } from "../../composables/useInboxConnectionFocus.js";
import PaneShell from "../layout/PaneShell.vue";
import PrRow from "./PrRow.vue";
import AuditLog from "./azure/AzureAuditLog.vue";
import AzurePipelinesTab from "./azure/AzurePipelinesTab.vue";

const props = withDefaults(
  defineProps<{ workspaceId: string; showHeader?: boolean; provider?: "azure" | "github" }>(),
  { showHeader: false, provider: "azure" },
);

const isGitHub = computed(() => props.provider === "github");
const provider = computed(() => props.provider);

const appStore = useAppStore();
const pipelinesStore = useAzurePipelinesStore();
const notifications = useNotificationStore();
// Fetch + keep this provider's inbox (lists + connections) current while mounted.
useResourceInterest(() => `${props.provider}-inbox`);
const { isMobile, menuOpen, tabsMenuOpen, toggleActionsMenu, toggleTabsMenu, closeAllMenus, onTabClick } =
  useMobileShellMenus({
    onSelectTab: (id) => {
      activeTab.value = id;
    },
  });

const busyAction = ref<string>("");
// prKey currently being opened — drives the per-row spinner and disables the
// button so a slow clone/checkout can't be double-clicked. Single-flight:
// while one PR is opening, other Review buttons are ignored too.
const openingPrKey = ref<string>("");
// Azure defaults to "Needs attention" so the most actionable items surface
// first (it's the only provider with attention sub-bucketing); GitHub has no
// equivalent tab content there, so it defaults to the generic All tab.
const activeTab = ref<string>(isGitHub.value ? "all" : "attention");
const openError = ref<string>("");

// Provider state = core badges/connections + the on-demand inbox detail
// fetched via the resource interest above. Backend ships connections for
// every open profile (see getAzureConnections/getGitHubConnections); each
// window shows only its own profile's connections.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providerData = computed<Record<string, any>>(() => (appStore.providerState(props.provider) as any) || {});
const connections = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = (providerData.value.connections || []) as any[];
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
  const raw = providerData.value.inbox || {};
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
const reviewRoot = computed(
  () => appStore.payload?.appState?.settings?.integrations?.[isGitHub.value ? "github" : "azureDevops"]?.reviewRoot || "",
);

// Deep-link: when the user clicks a "connection error" notification, the
// store carries a focus request targeting one of this pane's connections.
// See useInboxConnectionFocus for the shared switch-tab/highlight/scroll logic.
const { connectionListRef, highlightedConnectionId } = useInboxConnectionFocus(myConnectionIds, activeTab);

// Pipelines with a failed/canceled latest run (Azure only) — surfaced as the
// Pipelines tab badge so failures stand out without opening the tab. Reflects
// whatever the pipelines store has loaded (see the eager background load below).
const failingPipelineCount = computed(() => {
  if (isGitHub.value) return 0;
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

// Eagerly load pipelines (Azure only) for this profile's connections so the
// failing badge populates without opening the tab. Cached in the store —
// re-runs only when the connection set changes, not on every render.
watch(
  () => connections.value.map((c) => c.id).join(","),
  () => {
    if (isGitHub.value) return;
    for (const c of connections.value) void pipelinesStore.load(c.id);
  },
  { immediate: true },
);

const inboxTabs = computed(() => {
  const tabs = [
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
  ];
  if (!isGitHub.value) {
    tabs.push({
      id: "pipelines",
      label: "Pipelines",
      count: failingPipelineCount.value || null,
      alert: failingPipelineCount.value > 0,
    } as (typeof tabs)[number]);
  }
  tabs.push(
    {
      id: "connections",
      label: "Connections",
      count: connections.value.length,
      alert: connections.value.some((c) => c.status === "error"),
    } as (typeof tabs)[number],
    { id: "activity", label: "Activity Log", count: null, alert: false } as (typeof tabs)[number],
  );
  return tabs;
});

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

// Azure groups by project/repository; GitHub identifies a repo by its full
// "owner/repo" name — the two providers' PR summaries don't share a
// repository shape, so the key has to branch on provider.
function repoKey(item: { project?: { name?: string }; repository?: { name?: string; fullName?: string } }) {
  if (isGitHub.value) return item.repository?.fullName || "";
  return `${item.project?.name || ""}/${item.repository?.name || ""}`;
}

// Repo names offered as filter buttons. Azure facets them against the author
// filter (only repos with PRs by the selected author show up, and vice versa
// for authorOptions below) — GitHub has no author filter, so it's unfaceted.
const repoNames = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = inbox.value.recentlyUpdated || [];
  const items = !isGitHub.value && authorFilter.value ? all.filter((item) => authorKey(item) === authorFilter.value) : all;
  const names = [...new Set(items.map(repoKey))];
  return names.sort();
});

function authorKey(item: { author?: { id?: string; uniqueName?: string; displayName?: string } }) {
  const author = item.author || {};
  return author.id || author.uniqueName || author.displayName || "unknown-author";
}

// Author filter (Azure only — GitHub's inbox has no author-filter axis).
const authorOptions = computed(() => {
  if (isGitHub.value) return [];
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

const hasActiveFilters = computed(() => Boolean(repoFilter.value || (!isGitHub.value && authorFilter.value)));

function matchesActiveFilters(item: {
  project?: { name?: string };
  repository?: { name?: string; fullName?: string };
  author?: { id?: string; uniqueName?: string; displayName?: string };
}) {
  if (repoFilter.value && repoKey(item) !== repoFilter.value) {
    return false;
  }
  return isGitHub.value || !authorFilter.value || authorKey(item) === authorFilter.value;
}

// Sub-buckets for the "Needs attention" tab (Azure only): route reviews-of-mine /
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
  if (isGitHub.value) return [];
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

// Group items by repo for the active tab, cached as computed. GitHub never
// facets by author, so matchesActiveFilters is a no-op repo-only check there.
const activeGroupedItems = computed(() => {
  const items: unknown[] = tabItems(activeTab.value).filter(matchesActiveFilters);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups = new Map<string, any[]>();
  for (const item of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyItem = item as any;
    const repo = repoKey(anyItem);
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo)!.push(anyItem);
  }
  return [...groups.entries()].map(([repo, items]) => ({ repo, items }));
});

const headerStatus = computed(() => `${inbox.value.recentlyUpdated?.length || 0} PRs`);
const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: isGitHub.value ? "refresh-github" : "refresh-azure",
    title: isGitHub.value ? "Refresh GitHub" : "Refresh Azure DevOps",
    label: "↻",
  },
]);

function openConnectionDialog(connectionId: string) {
  if (isGitHub.value) appStore.openGitHubConnectionDialog(connectionId);
  else appStore.openAzureConnectionDialog(connectionId);
}

function openQuickFixWizard() {
  if (isGitHub.value) appStore.openGitHubQuickFixWizard();
  else appStore.openQuickFixWizard();
}

async function handleRefresh() {
  busyAction.value = "refresh";
  try {
    await notifications.runWithToast("Refresh failed", () =>
      isGitHub.value ? appStore.refreshGitHub() : appStore.refreshAzure(),
    );
  } finally {
    busyAction.value = "";
  }
}

async function handleDeleteConnection(connId: string) {
  busyAction.value = `delete-${connId}`;
  try {
    await notifications.runWithToast("Delete connection failed", () =>
      isGitHub.value ? appStore.deleteGitHubConnection(connId) : appStore.deleteAzureConnection(connId),
    );
  } finally {
    busyAction.value = "";
  }
}

function onHeaderAction(action: { action: string }) {
  if (action.action === "refresh-azure" || action.action === "refresh-github") handleRefresh();
}

async function onOpenPr({ prKey, workspaceId }: { prKey: string; workspaceId: string }) {
  if (openingPrKey.value) return; // already opening one — ignore extra clicks
  openError.value = "";
  openingPrKey.value = prKey;
  try {
    if (isGitHub.value) await appStore.openGitHubPullRequest(prKey, workspaceId);
    else await appStore.openAzurePullRequest(prKey, workspaceId);
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
  if (isGitHub.value) appStore.markGitHubPrSeen(prKey);
  else appStore.markAzurePrSeen(prKey);
}
</script>
