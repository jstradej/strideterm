<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      title="Azure DevOps"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!connections.length" class="terminal-empty" style="align-content:start;padding-top:32px;">
      <p>No Azure DevOps connections yet</p>
      <small>Add a connection with organization URL, login, PAT and review checkout path.</small>
      <div class="docker-card__actions" style="margin-top:12px;">
        <button type="button" class="button" @click="appStore.openAzureConnectionDialog('')">Add Azure connection</button>
      </div>
    </div>
    <div v-else class="azure-inbox">
      <div class="azure-inbox__toolbar">
        <div class="azure-inbox__tabs">
          <button v-for="tab in inboxTabs" :key="tab.id" type="button" :class="['azure-tab', activeTab === tab.id && 'azure-tab--active', tab.alert && 'azure-tab--alert']" @click="activeTab = tab.id">
            {{ tab.label }} <span class="azure-tab__count">{{ tab.count }}</span>
          </button>
        </div>
        <div class="azure-inbox__actions">
          <button type="button" :class="['button', 'button--ghost', busyAction === 'refresh' && 'button--busy']" :disabled="!!busyAction" @click="handleRefresh">{{ busyAction === 'refresh' ? 'Refreshing…' : 'Refresh' }}</button>
          <button type="button" class="button" @click="appStore.openAzureConnectionDialog('')">Add connection</button>
        </div>
      </div>

      <div class="azure-inbox__content">
        <section v-for="tab in inboxTabs" :key="tab.id" :class="['azure-section', activeTab === tab.id && 'azure-section--active']">
          <!-- Only render heavy content for the active tab -->
          <template v-if="tab.id === 'connections' && activeTab === 'connections'">
            <div class="section-head" style="padding:0 0 8px;">
              <div>
                <p class="eyebrow">Azure DevOps Connections</p>
                <h3>{{ connections.length }} connection{{ connections.length !== 1 ? 's' : '' }}</h3>
              </div>
            </div>
            <div class="docker-list azure-connection-list" style="gap:8px;">
              <article v-for="conn in connections" :key="conn.id" class="docker-card" :style="`border-left:3px solid ${conn.status === 'ok' ? 'var(--accent)' : 'var(--muted)'};`">
                <div class="docker-card__head">
                  <div>
                    <h4>{{ conn.label }}</h4>
                    <p class="docker-card__meta">{{ conn.orgUrl }}</p>
                  </div>
                  <span :class="['workspace-chip', conn.status !== 'ok' && 'workspace-chip--alert']" style="font-size:10px;">{{ conn.status === 'ok' ? 'Connected' : conn.status || 'idle' }}</span>
                </div>
                <div style="font-size:12px;color:var(--muted);padding:4px 0;">
                  {{ conn.login }} · {{ conn.projectFilters?.join(', ') || 'all projects' }}
                </div>
                <div class="docker-card__actions">
                  <button type="button" class="button button--ghost" @click="appStore.openAzureConnectionDialog(conn.id)">Edit</button>
                  <button type="button" :class="['button', 'button--ghost', 'danger', busyAction === `delete-${conn.id}` && 'button--busy']" :disabled="!!busyAction" @click="handleDeleteConnection(conn.id)">Delete</button>
                </div>
              </article>
            </div>
            <div style="margin-top:12px;padding:8px 10px;font-size:12px;color:var(--muted);border-top:1px solid var(--border);">
              📂 Review root: <code>{{ reviewRoot || 'not set' }}</code>
            </div>
          </template>
          <!-- PR list tabs — only render when this tab is active -->
          <template v-else-if="activeTab === tab.id">
            <!-- Repo filter -->
            <div v-if="repoNames.length > 1 && tabItems(activeTab).length" style="display:flex;gap:4px;padding:0 0 8px;flex-wrap:wrap;">
              <button type="button" :class="['button', 'button--ghost', !repoFilter && 'button--active']" :style="!repoFilter ? 'font-size:11px;padding:2px 8px;background:var(--accent);color:var(--bg);' : 'font-size:11px;padding:2px 8px;'" @click="repoFilter = ''">All repos</button>
              <button v-for="repo in repoNames" :key="repo" type="button" :class="['button', 'button--ghost', repoFilter === repo && 'button--active']" :style="repoFilter === repo ? 'font-size:11px;padding:2px 8px;background:var(--accent);color:var(--bg);' : 'font-size:11px;padding:2px 8px;'" @click="repoFilter = repoFilter === repo ? '' : repo">{{ repo }}</button>
            </div>
            <template v-if="activeGroupedItems.length">
              <div v-for="group in activeGroupedItems" :key="group.repo" class="azure-repo-group">
                <div v-if="!repoFilter && repoNames.length > 1" class="azure-repo-group__header">
                  <span class="azure-repo-group__name">{{ group.repo }}</span>
                  <span class="azure-repo-group__count">{{ group.items.length }}</span>
                </div>
                <AzurePrRow
                  v-for="item in group.items"
                  :key="item.prKey"
                  :item="item"
                  @open="onOpenPr"
                  @browser="onOpenBrowser"
                  @seen="onMarkSeen"
                />
              </div>
            </template>
            <div v-else class="azure-empty"><p>{{ tab.emptyMessage }}</p></div>
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
import AzurePrRow from "./azure/AzurePrRow.vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();

const busyAction = ref("");
const activeTab = ref("all");

const azureData = computed(() => appStore.payload?.azureDevops || {});
const connections = computed(() => azureData.value.connections || []);
const inbox = computed(() => azureData.value.inbox || {});
const reviewRoot = computed(() => appStore.payload?.appState?.settings?.integrations?.azureDevops?.reviewRoot || "");

const inboxTabs = computed(() => [
  { id: "all", label: "All", count: inbox.value.recentlyUpdated?.length || 0, alert: false, emptyMessage: "No active pull requests." },
  { id: "attention", label: "Needs attention", count: inbox.value.needsAttention?.length || 0, alert: !!(inbox.value.needsAttention?.length), emptyMessage: "No pull requests need your attention right now." },
  { id: "needs-review", label: "Needs review", count: inbox.value.needsMyReview?.length || 0, alert: false, emptyMessage: "No pull requests waiting for your review." },
  { id: "my-prs", label: "My PRs", count: inbox.value.myPullRequests?.length || 0, alert: false, emptyMessage: "You have no active pull requests." },
  { id: "connections", label: "Connections", count: connections.value.length, alert: false },
]);

const repoFilter = ref("");

function tabItems(tabId) {
  if (tabId === "all") return inbox.value.recentlyUpdated || [];
  if (tabId === "attention") return inbox.value.needsAttention || [];
  if (tabId === "needs-review") return inbox.value.needsMyReview || [];
  if (tabId === "my-prs") return inbox.value.myPullRequests || [];
  return [];
}

// All unique repo names across all PRs (for filter buttons)
const repoNames = computed(() => {
  const all = inbox.value.recentlyUpdated || [];
  const names = [...new Set(all.map((item) => `${item.project?.name || ""}/${item.repository?.name || ""}`))];
  return names.sort();
});

// Group items by project/repo for the active tab, cached as computed
const activeGroupedItems = computed(() => {
  let items = tabItems(activeTab.value);
  if (repoFilter.value) {
    items = items.filter((item) => `${item.project?.name || ""}/${item.repository?.name || ""}` === repoFilter.value);
  }
  const groups = new Map();
  for (const item of items) {
    const repo = `${item.project?.name || ""}/${item.repository?.name || ""}`;
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo).push(item);
  }
  return [...groups.entries()].map(([repo, items]) => ({ repo, items }));
});

const headerStatus = computed(() => `${inbox.value.recentlyUpdated?.length || 0} PRs`);
const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "refresh-azure", title: "Refresh Azure DevOps", label: "↻" },
]);

async function handleRefresh() {
  busyAction.value = "refresh";
  try { await appStore.refreshAzure(); }
  finally { busyAction.value = ""; }
}

async function handleDeleteConnection(connId) {
  busyAction.value = `delete-${connId}`;
  try { await appStore.deleteAzureConnection(connId); }
  finally { busyAction.value = ""; }
}

function onHeaderAction(action) {
  if (action.action === "refresh-azure") handleRefresh();
}

function onOpenPr({ prKey, workspaceId }) {
  appStore.openAzurePullRequest(prKey, workspaceId);
}

function onOpenBrowser(url) {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

function onMarkSeen(prKey) {
  appStore.markAzurePrSeen(prKey);
}
</script>
