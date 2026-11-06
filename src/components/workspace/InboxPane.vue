<template>
  <div ref="inboxRoot" class="workspace-pane__body workspace-pane__body--git">
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
      <div class="azure-inbox__toolbar subtabs">
        <div class="azure-inbox__tabs">
          <button
            v-for="tab in inboxTabs"
            :key="tab.id"
            type="button"
            :class="[
              'azure-tab',
              'subtabs__tab',
              activeTab === tab.id && 'azure-tab--active subtabs__tab--active',
              tab.alert && 'azure-tab--alert subtabs__tab--alert',
            ]"
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
            :title="
              isGitHub
                ? undefined
                : 'Add a new Azure DevOps connection (organization URL, login, PAT, project filters).'
            "
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

      <div class="azure-inbox__content subtabs-panel">
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
                <div
                  v-if="!isGitHub && conn.groupMembership?.status === 'ok'"
                  style="font-size: 11px; color: var(--muted); padding: 2px 0"
                >
                  Reviewer groups: {{ conn.groupMembership.count }} recognised
                </div>
                <div
                  v-else-if="!isGitHub && conn.groupMembership?.status === 'error'"
                  style="font-size: 11px; color: var(--danger-fg); padding: 2px 0"
                >
                  Reviewer groups not recognised: {{ conn.groupMembership.error }}
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
            <div v-if="tabItems(activeTab).length || hasActiveFilters" class="azure-inbox__filters">
              <div
                v-if="repoChips.length > 1 || repoFilter.length"
                class="azure-inbox__filter-row"
                role="group"
                aria-label="Repository"
              >
                <span class="azure-inbox__filter-label">{{ repoPrefix || "Repo" }}</span>
                <button
                  type="button"
                  class="azure-inbox__chip"
                  :aria-pressed="!repoFilter.length"
                  title="Show pull requests across every project / repository."
                  @click="repoFilter = []"
                >
                  All repos
                </button>
                <button
                  v-for="repo in repoChips"
                  :key="repo.key"
                  type="button"
                  class="azure-inbox__chip"
                  :aria-pressed="repoFilter.includes(repo.key)"
                  :title="`Show PRs from ${repo.key}. Pick several repositories to see them together.`"
                  @click="repoFilter = toggled(repoFilter, repo.key)"
                >
                  {{ repo.label }}
                </button>
              </div>
              <div class="azure-inbox__filter-row azure-inbox__filter-row--split">
                <div
                  v-if="!isGitHub && (authorOptions.length > 1 || authorFilter.length)"
                  :ref="setAuthorGroup"
                  class="azure-inbox__authors"
                  role="group"
                  aria-label="Author"
                >
                  <span class="azure-inbox__filter-label">Author</span>
                  <div class="azure-inbox__author-chips">
                    <button
                      type="button"
                      class="azure-inbox__chip"
                      :aria-pressed="!authorFilter.length"
                      @click="authorFilter = []"
                    >
                      All authors
                    </button>
                    <button
                      v-for="author in visibleAuthors"
                      :key="author.key"
                      type="button"
                      class="azure-inbox__chip azure-inbox__chip--counted"
                      :aria-pressed="authorFilter.includes(author.key)"
                      :title="author.uniqueName || author.name"
                      @click="authorFilter = toggled(authorFilter, author.key)"
                    >
                      <span>{{ author.label }}</span>
                      <span class="azure-inbox__pill">{{ author.count }}</span>
                    </button>
                  </div>
                  <!-- A chip sized to its label, with the native select laid invisibly
                       over it: a bare <select> is as wide as its longest option. -->
                  <label
                    v-if="overflowAuthors.length"
                    class="azure-inbox__chip azure-inbox__more"
                    :data-active="overflowSelected.length ? 'true' : undefined"
                    :title="
                      overflowSelected.map((author) => author.uniqueName || author.name).join(', ') || 'More authors'
                    "
                  >
                    <span class="azure-inbox__more-label">{{ overflowChipLabel }}</span>
                    <span v-if="overflowSelected.length === 1" class="azure-inbox__pill">{{
                      overflowSelected[0].count
                    }}</span>
                    <svg class="pr-icon azure-inbox__more-chevron" viewBox="0 0 24 24" aria-hidden="true">
                      <path v-for="d in icons.chevronDown" :key="d" :d="d" />
                    </svg>
                    <!-- Picking an author adds or removes them; the list itself stays on "+N more". -->
                    <select
                      class="azure-inbox__more-select"
                      aria-label="More authors"
                      value=""
                      @change="onOverflowPick($event.target as HTMLSelectElement)"
                    >
                      <option value="">+{{ overflowAuthors.length }} more</option>
                      <option v-for="author in overflowAuthors" :key="author.key" :value="author.key">
                        {{ authorFilter.includes(author.key) ? "✓ " : "" }}{{ author.label }} ({{ author.count }})
                      </option>
                    </select>
                  </label>
                  <div :ref="setMeasure" class="azure-inbox__measure" aria-hidden="true">
                    <span class="azure-inbox__chip">All authors</span>
                    <span
                      v-for="author in authorOptions"
                      :key="author.key"
                      class="azure-inbox__chip azure-inbox__chip--counted"
                    >
                      <span>{{ author.label }}</span>
                      <span class="azure-inbox__pill">{{ author.count }}</span>
                    </span>
                  </div>
                </div>
                <div class="azure-inbox__filter-tools">
                  <label class="azure-inbox__tool">
                    Sort
                    <select v-model="sortMode" class="azure-inbox__select">
                      <option value="activity">Last activity</option>
                      <option value="attention">Needs attention first</option>
                      <option value="created">Created</option>
                    </select>
                  </label>
                  <label class="azure-inbox__tool">
                    <input v-model="hideDrafts" type="checkbox" />
                    Hide drafts
                  </label>
                </div>
              </div>
            </div>
            <div v-if="displayGroups.length" class="azure-inbox__groups">
              <section v-for="group in displayGroups" :key="group.key" class="azure-repo-group">
                <h2 class="azure-repo-group__heading">
                  <button
                    type="button"
                    class="azure-repo-group__header"
                    :aria-expanded="!isCollapsed(group.key)"
                    @click="toggleGroup(group.key)"
                  >
                    <svg class="pr-icon azure-repo-group__chevron" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        v-for="d in isCollapsed(group.key) ? icons.chevronRight : icons.chevronDown"
                        :key="d"
                        :d="d"
                      />
                    </svg>
                    <span v-if="group.kind === 'repo'" class="azure-repo-group__tile" aria-hidden="true">
                      <svg class="pr-icon" viewBox="0 0 24 24">
                        <path v-for="d in icons.folderGit" :key="d" :d="d" />
                      </svg>
                    </span>
                    <span class="azure-repo-group__title">
                      <span v-if="group.project" class="azure-repo-group__project">{{ group.project }} /</span>
                      <span class="azure-repo-group__name">{{ group.label }}</span>
                    </span>
                    <span class="azure-repo-group__count">{{ group.items.length }}</span>
                    <small v-if="group.hint" class="azure-repo-group__hint">{{ group.hint }}</small>
                    <span v-if="group.kind === 'repo'" class="azure-repo-group__stats">
                      <span v-if="group.unread">{{ group.unread }} unread</span>
                      <span v-if="group.attention" class="azure-repo-group__attention"
                        >{{ group.attention }} {{ group.attention === 1 ? "needs" : "need" }} attention</span
                      >
                    </span>
                  </button>
                </h2>
                <div v-if="!isCollapsed(group.key)" class="azure-repo-group__body">
                  <template v-for="row in group.rows" :key="row.id">
                    <button
                      v-if="row.type === 'toggle'"
                      type="button"
                      class="azure-repo-group__older"
                      :aria-expanded="row.open"
                      @click="toggleOlder(group.key)"
                    >
                      <svg class="pr-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path v-for="d in row.open ? icons.chevronDown : icons.chevronRight" :key="d" :d="d" />
                      </svg>
                      <span class="azure-repo-group__older-label">{{ row.label }}</span>
                      <span>{{ row.sub }}</span>
                    </button>
                    <PrRow
                      v-else
                      :item="row.item"
                      :provider="provider"
                      :focused="
                        focusedPr?.prKey === row.item.prKey && focusedPr?.connectionId === row.item.connectionId
                      "
                      :show-repo="group.kind === 'bucket'"
                      :implied-reason-codes="group.impliedReasonCodes"
                      :current-user-login="connectionLogin(row.item.connectionId)"
                      :opening="row.item.prKey === openingPrKey"
                      @open="onOpenPr"
                      @browser="onOpenBrowser"
                      @seen="onMarkSeen"
                    />
                  </template>
                </div>
              </section>
            </div>
            <div v-else class="azure-empty">
              <p>
                {{ hasActiveFilters ? "No pull requests match the selected filters." : tab.emptyMessage }}
              </p>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch, nextTick } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useAzurePipelinesStore } from "../../stores/azure-pipelines.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { useMobileShellMenus } from "../../composables/useMobileShellMenus.js";
import { useResourceInterest } from "../../composables/useResourceInterest.js";
import { useInboxConnectionFocus } from "../../composables/useInboxConnectionFocus.js";
import PaneShell from "../layout/PaneShell.vue";
import PrRow from "./PrRow.vue";
import { PR_ICONS, daysSince, isUnread } from "./prRowFormat.js";
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
  () =>
    appStore.payload?.appState?.settings?.integrations?.[isGitHub.value ? "github" : "azureDevops"]?.reviewRoot || "",
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
      alert: false,
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
      alert: false,
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

// Several repositories / authors can be picked at once; an empty list means all.
const repoFilter = ref<string[]>([]);
const authorFilter = ref<string[]>([]);
type SortMode = "activity" | "attention" | "created";
const SORT_MODES: SortMode[] = ["activity", "attention", "created"];
const sortMode = ref<SortMode>("activity");
const hideDrafts = ref(false);
// Names of picked authors, so a restored pick still reads as a name while that author has no PR in the inbox.
const savedAuthorNames = ref(new Map<string, string>());

function toggled(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key];
}

// The filters are this client's view preference — the desktop and a phone each keep their own — remembered
// per inbox workspace, so the next start opens the inbox the way it was left.
const FILTERS_STORAGE_PREFIX = "strideterm-inbox-filters-v1:";

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
}

function loadFilters(workspaceId: string) {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FILTERS_STORAGE_PREFIX + workspaceId) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    // No storage, or an unreadable entry: start unfiltered.
  }
  repoFilter.value = stringList(saved.repos);
  authorFilter.value = stringList(saved.authors);
  const names = saved.authorNames;
  savedAuthorNames.value = new Map(
    names && typeof names === "object"
      ? Object.entries(names).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      : [],
  );
  sortMode.value = SORT_MODES.includes(saved.sort as SortMode) ? (saved.sort as SortMode) : "activity";
  hideDrafts.value = saved.hideDrafts === true;
}

watch(() => props.workspaceId, loadFilters, { immediate: true });

watch([repoFilter, authorFilter, sortMode, hideDrafts], () => {
  const authorNames = new Map(authorFilter.value.map((key) => [key, authorNameOf(key)]));
  savedAuthorNames.value = authorNames;
  try {
    localStorage.setItem(
      FILTERS_STORAGE_PREFIX + props.workspaceId,
      JSON.stringify({
        repos: repoFilter.value,
        authors: authorFilter.value,
        authorNames: Object.fromEntries(authorNames),
        sort: sortMode.value,
        hideDrafts: hideDrafts.value,
      }),
    );
  } catch {
    // Without storage the filters still apply for this session.
  }
});

const inboxRoot = ref<HTMLElement | null>(null);
const focusedPr = ref<{ prKey: string; connectionId: string } | null>(null);
let focusedPrTimer: ReturnType<typeof setTimeout> | null = null;
let focusExpiryTimer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => ({
    request: appStore.inboxPullRequestFocus,
    provider: provider.value,
    profileId: appStore.myActiveProfileId,
    connectionIds: myConnectionIds.value,
    items: inbox.value.recentlyUpdated,
  }),
  async ({ request, provider: currentProvider, profileId: currentProfileId, connectionIds, items }) => {
    if (!request) return;
    if (request.workspaceId !== props.workspaceId) return;
    if (Date.now() - request.ts > 15_000) {
      appStore.inboxPullRequestFocus = null;
      return;
    }
    if (!focusExpiryTimer) {
      focusExpiryTimer = setTimeout(
        () => {
          if (appStore.inboxPullRequestFocus?.ts === request.ts) appStore.inboxPullRequestFocus = null;
          focusExpiryTimer = null;
        },
        Math.max(0, 15_000 - (Date.now() - request.ts)),
      );
    }
    const expectedProvider = currentProvider === "github" ? "github" : "azure-devops";
    const profileId = currentProfileId || "default";
    if (
      request.provider !== expectedProvider ||
      request.profileId !== profileId ||
      !connectionIds.has(request.connectionId)
    )
      return;

    activeTab.value = "all";
    const target = (items || []).find(
      (item: { prKey?: string; connectionId?: string }) =>
        item.prKey === request.prKey && item.connectionId === request.connectionId,
    );
    if (!target) return;
    // The saved filters stay unless they would hide the very PR the user asked to see.
    if (!matchesActiveFilters(target)) {
      repoFilter.value = [];
      authorFilter.value = [];
      hideDrafts.value = false;
    }

    if (focusExpiryTimer) clearTimeout(focusExpiryTimer);
    focusExpiryTimer = null;
    appStore.inboxPullRequestFocus = null;
    if (focusedPrTimer) clearTimeout(focusedPrTimer);
    focusedPr.value = null;
    await nextTick();
    focusedPr.value = { prKey: request.prKey, connectionId: request.connectionId };
    await nextTick();
    const row = [...(inboxRoot.value?.querySelectorAll<HTMLElement>("[data-pr-key][data-connection-id]") || [])].find(
      (element) => element.dataset.prKey === request.prKey && element.dataset.connectionId === request.connectionId,
    );
    row?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    focusedPrTimer = setTimeout(() => {
      if (focusedPr.value?.prKey === request.prKey && focusedPr.value.connectionId === request.connectionId) {
        focusedPr.value = null;
      }
    }, 4_000);
  },
  { immediate: true },
);

onUnmounted(() => {
  if (focusedPrTimer) clearTimeout(focusedPrTimer);
  if (focusExpiryTimer) clearTimeout(focusExpiryTimer);
});

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

const icons = PR_ICONS;

const collapsedGroups = reactive(new Set<string>());
const olderOpenGroups = reactive(new Set<string>());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InboxItem = Record<string, any>;

function isDraftItem(item: InboxItem) {
  return Boolean(item.pullRequest?.isDraft || item.pullRequest?.draft);
}

function timeOf(value: unknown) {
  const ms = Date.parse(value as string);
  return Number.isNaN(ms) ? 0 : ms;
}

function activityOf(item: InboxItem) {
  return item.lastActivityAt || item.lastRemoteActivityAt;
}

function createdOf(item: InboxItem) {
  return item.pullRequest?.creationDate || item.pullRequest?.createdAt;
}

// Items the repo / author facets are computed from: the whole inbox minus
// whatever Hide drafts removes, so a chip's count matches what it filters to.
function facetItems(): InboxItem[] {
  const all: InboxItem[] = inbox.value.recentlyUpdated || [];
  return hideDrafts.value ? all.filter((item) => !isDraftItem(item)) : all;
}

// Repo names offered as filter chips. Azure facets them against the author
// filter (only repos with PRs by the selected authors show up, and vice versa
// for authorOptions below) — GitHub has no author filter, so it's unfaceted.
// A picked repo is always offered, even with no PR right now: an active filter
// must stay visible, never hide the list silently.
const repoNames = computed(() => {
  const all = facetItems();
  const items =
    !isGitHub.value && authorFilter.value.length
      ? all.filter((item) => authorFilter.value.includes(authorKey(item)))
      : all;
  return [...new Set([...items.map(repoKey), ...repoFilter.value])].sort();
});

// When every Azure repo lives in one project the project becomes the row
// prefix and the chips only carry the repo name.
const repoPrefix = computed(() => {
  if (isGitHub.value) return "";
  const projects = new Set(repoNames.value.map((key) => key.split("/")[0]));
  return projects.size === 1 && repoNames.value.length ? `${[...projects][0]} /` : "";
});

const repoChips = computed(() =>
  repoNames.value.map((key) => ({
    key,
    label: repoPrefix.value ? key.slice(key.indexOf("/") + 1) : key,
  })),
);

function authorKey(item: { author?: { id?: string; uniqueName?: string; displayName?: string } }) {
  const author = item.author || {};
  return author.id || author.uniqueName || author.displayName || "unknown-author";
}

// Author filter (Azure only — GitHub's inbox has no author-filter axis).
// The current user comes first as "You", then by PR count, then by name.
const authorOptions = computed(() => {
  if (isGitHub.value) return [];
  const authors = new Map<
    string,
    { key: string; name: string; label: string; uniqueName: string; count: number; isMe: boolean }
  >();
  for (const item of facetItems()) {
    if (repoFilter.value.length && !repoFilter.value.includes(repoKey(item))) continue;
    const key = authorKey(item);
    let entry = authors.get(key);
    if (!entry) {
      const name = item.author?.displayName || item.author?.uniqueName || "Unknown author";
      entry = { key, name, label: name, uniqueName: item.author?.uniqueName || "", count: 0, isMe: false };
      authors.set(key, entry);
    }
    entry.count++;
    if (item.role === "author") {
      entry.isMe = true;
      entry.label = "You";
    }
  }
  // Like a picked repo, a picked author stays on offer with no matching PR.
  for (const key of authorFilter.value) {
    if (authors.has(key)) continue;
    const name = authorNameOf(key);
    authors.set(key, { key, name, label: name, uniqueName: "", count: 0, isMe: false });
  }
  return [...authors.values()].sort(
    (a, b) => Number(b.isMe) - Number(a.isMe) || b.count - a.count || a.name.localeCompare(b.name),
  );
});

function authorNameOf(key: string): string {
  const item = (inbox.value.recentlyUpdated || []).find((entry: InboxItem) => authorKey(entry) === key);
  return item?.author?.displayName || item?.author?.uniqueName || savedAuthorNames.value.get(key) || "Unknown author";
}

// Author chips are fitted to the row: the ones that do not fit move into a
// native <select>. `null` means "show them all" (not measured / no layout).
const authorFit = ref<number | null>(null);
const visibleAuthors = computed(() =>
  authorFit.value == null ? authorOptions.value : authorOptions.value.slice(0, authorFit.value),
);
const overflowAuthors = computed(() => (authorFit.value == null ? [] : authorOptions.value.slice(authorFit.value)));
const overflowSelected = computed(() =>
  overflowAuthors.value.filter((author) => authorFilter.value.includes(author.key)),
);
const overflowChipLabel = computed(() => {
  const picked = overflowSelected.value;
  if (picked.length === 1) return picked[0].label;
  return picked.length ? `+${picked.length} authors` : `+${overflowAuthors.value.length} more`;
});

function onOverflowPick(select: HTMLSelectElement) {
  if (select.value) authorFilter.value = toggled(authorFilter.value, select.value);
  // Back on "+N more", so the same author can be picked again to remove them.
  select.value = "";
}

let authorGroupEl: HTMLElement | null = null;
let measureEl: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;
let measurePending = false;

function scheduleMeasure() {
  if (measurePending) return;
  measurePending = true;
  void nextTick(() => {
    measurePending = false;
    measureAuthors();
  });
}

function setAuthorGroup(el: unknown) {
  const next = el as HTMLElement | null;
  if (next === authorGroupEl) return;
  resizeObserver?.disconnect();
  resizeObserver = null;
  authorGroupEl = next;
  if (next && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(next);
  }
  scheduleMeasure();
}

function setMeasure(el: unknown) {
  measureEl = el as HTMLElement | null;
  scheduleMeasure();
}

// The label column (52px) plus a 4px gap precede the chips.
const AUTHOR_LABEL_WIDTH = 56;
const AUTHOR_GAP = 4;
const AUTHOR_SELECT_WIDTH = 170;

function measureAuthors() {
  if (!authorGroupEl || !measureEl || typeof ResizeObserver === "undefined") {
    authorFit.value = null;
    return;
  }
  const widths = Array.from(measureEl.children).map((el) => (el as HTMLElement).offsetWidth);
  const available = authorGroupEl.clientWidth - AUTHOR_LABEL_WIDTH;
  if (available <= 0 || !widths.length || widths.some((width) => width <= 0)) {
    authorFit.value = null;
    return;
  }
  const [allWidth, ...chipWidths] = widths;
  const full = chipWidths.reduce((sum, width) => sum + AUTHOR_GAP + width, allWidth);
  if (full <= available) {
    authorFit.value = chipWidths.length;
    return;
  }
  let used = allWidth + AUTHOR_GAP + AUTHOR_SELECT_WIDTH;
  let fit = 0;
  for (const width of chipWidths) {
    if (used + AUTHOR_GAP + width > available) break;
    used += AUTHOR_GAP + width;
    fit++;
  }
  authorFit.value = fit;
}

watch(authorOptions, scheduleMeasure);

onMounted(() => {
  void document.fonts?.ready?.then(scheduleMeasure);
});

const hasActiveFilters = computed(() =>
  Boolean(repoFilter.value.length || (!isGitHub.value && authorFilter.value.length) || hideDrafts.value),
);

function matchesActiveFilters(item: InboxItem) {
  if (repoFilter.value.length && !repoFilter.value.includes(repoKey(item))) return false;
  if (hideDrafts.value && isDraftItem(item)) return false;
  return isGitHub.value || !authorFilter.value.length || authorFilter.value.includes(authorKey(item));
}

function sortItems(items: InboxItem[]): InboxItem[] {
  const byActivity = (a: InboxItem, b: InboxItem) => timeOf(activityOf(b)) - timeOf(activityOf(a));
  if (sortMode.value === "attention") {
    return [...items].sort(
      (a, b) => Number(Boolean(b.hasAttention)) - Number(Boolean(a.hasAttention)) || byActivity(a, b),
    );
  }
  if (sortMode.value === "created") {
    return [...items].sort((a, b) => timeOf(createdOf(b)) - timeOf(createdOf(a)) || byActivity(a, b));
  }
  return [...items].sort(byActivity);
}

function isCollapsed(groupKey: string) {
  return collapsedGroups.has(groupKey);
}

function toggleGroup(groupKey: string) {
  if (!collapsedGroups.delete(groupKey)) collapsedGroups.add(groupKey);
}

function toggleOlder(groupKey: string) {
  if (!olderOpenGroups.delete(groupKey)) olderOpenGroups.add(groupKey);
}

function connectionLogin(connectionId: string): string {
  return (connections.value.find((c) => c.id === connectionId)?.currentUserLogin as string) || "";
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

const reasonBuckets = [
  {
    bucket: "waiting-review",
    label: "Waiting for your review",
    hint: "You (or a group you belong to) were asked to review, or the PR changed after your vote.",
    codes: ["review-requested", "group-review-requested", "push-after-approval", "push-after-feedback"],
    // The heading says it; a "Your review" chip on every row only repeats it.
    implied: ["review-requested"],
  },
  {
    bucket: "yours",
    label: "Your pull requests",
    hint: "Pull requests you opened that need changes, have conflicts or failed to merge.",
    codes: ["changes-requested", "conflicts", "merge-failed"],
  },
  { bucket: "replies", label: "Replies to you", hint: "Someone replied to your comments.", codes: ["replies"] },
  {
    bucket: "other",
    label: "Other activity",
    hint: "Everything else flagged for your attention.",
    codes: [] as string[],
  },
];

const attentionGroupedItems = computed(() => {
  if (isGitHub.value) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = [...(inbox.value.needsAttention || [])].filter(matchesActiveFilters);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buckets: { bucket: string; label: string; hint: string; implied?: string[]; items: any[] }[] =
    attentionBuckets.map((b) => ({
      bucket: b.bucket,
      label: b.label,
      hint: b.hint,
      items: [],
    }));
  if (items.some((item) => Array.isArray(item.attentionReasons) && item.attentionReasons.length)) {
    const byCode = reasonBuckets.map((b) => ({
      bucket: b.bucket,
      label: b.label,
      hint: b.hint,
      implied: b.implied,
      items: [] as typeof items,
    }));
    for (const item of items) {
      const code = item.attentionReasons?.[0]?.code;
      const index = reasonBuckets.findIndex((b) => b.codes.includes(code));
      byCode[index === -1 ? byCode.length - 1 : index].items.push(item);
    }
    return byCode.filter((b) => b.items.length);
  }
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

const OLDER_THAN_DAYS = 30;

type GroupRow =
  | { id: string; type: "row"; item: InboxItem }
  | { id: string; type: "toggle"; open: boolean; label: string; sub: string };

function buildGroup(
  base: {
    key: string;
    kind: "repo" | "bucket";
    project: string;
    label: string;
    hint: string;
    impliedReasonCodes?: string[];
  },
  items: InboxItem[],
) {
  const key = `${activeTab.value}:${base.key}`;
  const recent: InboxItem[] = [];
  const older: InboxItem[] = [];
  for (const item of sortItems(items)) {
    ((daysSince(activityOf(item)) ?? 0) >= OLDER_THAN_DAYS ? older : recent).push(item);
  }
  const asRow = (item: InboxItem): GroupRow => ({ id: item.prKey, type: "row", item });
  const rows: GroupRow[] = recent.map(asRow);
  if (older.length) {
    const open = olderOpenGroups.has(key);
    const days = older.map((item) => Math.floor(daysSince(activityOf(item)) ?? 0));
    const newest = Math.min(...days);
    const oldest = Math.max(...days);
    rows.push({
      id: `older:${key}`,
      type: "toggle",
      open,
      label: open ? `Hide ${older.length} older pull requests` : `${older.length} older than ${OLDER_THAN_DAYS} days`,
      sub: open ? "" : `· last activity ${newest === oldest ? `${newest} d` : `${newest} d – ${oldest} d`} ago`,
    });
    if (open) rows.push(...older.map(asRow));
  }
  return {
    ...base,
    key,
    items,
    rows,
    unread: items.filter(isUnread).length,
    attention: items.filter((item) => item.hasAttention).length,
  };
}

// The Azure "Needs attention" tab groups by why a PR needs attention; every
// other tab (and GitHub) groups by repository.
const displayGroups = computed(() => {
  if (!isGitHub.value && activeTab.value === "attention") {
    return attentionGroupedItems.value.map((bucket) =>
      buildGroup(
        {
          key: bucket.bucket,
          kind: "bucket",
          project: "",
          label: bucket.label,
          hint: bucket.hint,
          impliedReasonCodes: bucket.implied,
        },
        bucket.items,
      ),
    );
  }
  const groups = new Map<string, InboxItem[]>();
  for (const item of tabItems(activeTab.value).filter(matchesActiveFilters) as InboxItem[]) {
    const repo = repoKey(item);
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo)!.push(item);
  }
  return [...groups.entries()].map(([repo, items]) => {
    const first = items[0];
    const [project, name] = isGitHub.value
      ? repo.includes("/")
        ? [repo.slice(0, repo.indexOf("/")), repo.slice(repo.indexOf("/") + 1)]
        : ["", repo]
      : [first.project?.name || "", first.repository?.name || ""];
    return buildGroup({ key: repo, kind: "repo", project, label: name, hint: "" }, items);
  });
});

onUnmounted(() => resizeObserver?.disconnect());

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

async function onOpenPr({
  prKey,
  workspaceId,
  forceReview = false,
}: {
  prKey: string;
  workspaceId: string;
  forceReview?: boolean;
}) {
  if (openingPrKey.value) return; // already opening one — ignore extra clicks
  openError.value = "";
  openingPrKey.value = prKey;
  try {
    if (isGitHub.value) await appStore.openGitHubPullRequest(prKey, workspaceId, { forceReview });
    else await appStore.openAzurePullRequest(prKey, workspaceId, { forceReview });
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
