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
    <div v-else class="azure-inbox">
      <div class="azure-inbox__toolbar">
        <div class="azure-inbox__tabs">
          <button
            v-for="tab in inboxTabs"
            :key="tab.id"
            type="button"
            :class="['azure-tab', activeTab === tab.id && 'azure-tab--active', tab.alert && 'azure-tab--alert']"
            @click="activeTab = tab.id"
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
            <div class="docker-list azure-connection-list" style="gap: 8px">
              <article
                v-for="conn in connections"
                :key="conn.id"
                class="docker-card"
                :style="`border-left:3px solid ${conn.status === 'ok' ? '#238636' : 'var(--muted)'};`"
              >
                <div class="docker-card__head">
                  <div>
                    <h4>{{ conn.label }}</h4>
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

<script setup>
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import PaneShell from "../layout/PaneShell.vue";
import GitHubPrRow from "./github/GitHubPrRow.vue";
import AuditLog from "./azure/AzureAuditLog.vue";

defineProps({
  workspaceId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();

const busyAction = ref("");
const activeTab = ref("all");
const repoFilter = ref("");

const githubData = computed(() => appStore.payload?.github || {});
const connections = computed(() => githubData.value.connections || []);
const inbox = computed(() => githubData.value.inbox || {});
const reviewRoot = computed(() => appStore.payload?.appState?.settings?.integrations?.github?.reviewRoot || "");

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
  { id: "connections", label: "Connections", count: connections.value.length, alert: false },
  { id: "activity", label: "Activity Log", count: null, alert: false },
]);

function tabItems(tabId) {
  if (tabId === "all") return inbox.value.recentlyUpdated || [];
  if (tabId === "attention") return inbox.value.needsAttention || [];
  if (tabId === "needs-review") return inbox.value.needsMyReview || [];
  if (tabId === "my-prs") return inbox.value.myPullRequests || [];
  return [];
}

const repoNames = computed(() => {
  const all = inbox.value.recentlyUpdated || [];
  const names = [...new Set(all.map((item) => item.repository?.fullName || ""))];
  return names.sort();
});

const activeGroupedItems = computed(() => {
  let items = tabItems(activeTab.value);
  if (repoFilter.value) {
    items = items.filter((item) => (item.repository?.fullName || "") === repoFilter.value);
  }
  const groups = new Map();
  for (const item of items) {
    const repo = item.repository?.fullName || "";
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo).push(item);
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

async function handleDeleteConnection(connId) {
  busyAction.value = `delete-${connId}`;
  try {
    await appStore.deleteGitHubConnection(connId);
  } finally {
    busyAction.value = "";
  }
}

function onHeaderAction(action) {
  if (action.action === "refresh-github") handleRefresh();
}

const openError = ref("");

async function onOpenPr({ prKey, workspaceId }) {
  openError.value = "";
  try {
    await appStore.openGitHubPullRequest(prKey, workspaceId);
  } catch (err) {
    openError.value = err?.message || "Failed to open review workspace.";
  }
}

function onOpenBrowser(url) {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

function onMarkSeen(prKey) {
  appStore.markGitHubPrSeen(prKey);
}
</script>
