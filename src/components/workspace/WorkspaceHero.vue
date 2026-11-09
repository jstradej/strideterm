<template>
  <section data-role="workspace-hero">
    <div
      v-if="isRemote && !isNativeMobile && store.remoteConnectionIssue && !issueDismissed"
      class="workspace-remote-alert"
      role="alert"
    >
      <div class="workspace-remote-alert__body">
        <p class="workspace-remote-alert__message">{{ remoteConnectionMessage }}</p>
        <p v-if="store.remoteConnectionHint" class="workspace-remote-alert__hint">
          {{ store.remoteConnectionHint }}
        </p>
      </div>
      <button
        type="button"
        class="workspace-remote-alert__dismiss"
        title="Dismiss this message"
        aria-label="Dismiss this message"
        @click="issueDismissed = true"
      >
        ×
      </button>
    </div>

    <template v-if="!workspace">
      <p class="workspace-empty-copy">Select or create a workspace to open it.</p>
    </template>

    <template v-else-if="activeWorkspace?.kind === 'azure' || activeWorkspace?.kind === 'github'">
      <div class="workspace-meta" :style="`--accent:${safeColor(activeWorkspace.color)}`">
        <div class="workspace-meta__main">
          <span
            class="workspace-chip workspace-meta__path workspace-meta__path--copyable"
            :title="pathTooltip"
            @click="copyPath"
          >
            <svg class="workspace-meta__path-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" />
            </svg>
            <template v-if="pathCopied || pathCopyFailed">{{ pathCopied ? "Copied!" : "Copy failed" }}</template>
            <template v-else
              ><span class="workspace-meta__path-head">{{ pathParts.head }}</span
              ><span class="workspace-meta__path-tail">{{ pathParts.tail }}</span></template
            >
          </span>
        </div>
        <JiraHeaderSearch />
        <div class="workspace-meta__stats">
          <span class="workspace-chip" :title="inboxTitle"
            ><strong>{{ activeWorkspace.kind === "github" ? "GitHub" : "Azure" }}</strong> inbox</span
          >
          <span class="workspace-chip" :title="reviewTabsTitle"
            ><strong>{{ reviewTabCount }}</strong> review tabs</span
          >
          <span
            v-if="attention?.count"
            class="workspace-chip workspace-chip--alert"
            :class="{ 'workspace-chip--alert-fresh': isFreshAttention(attention) }"
            :title="attentionTitle(attention)"
          >
            <strong>{{ attention.count }}</strong> attention
          </span>
          <WorkspaceLayoutChip />
        </div>
        <AgentRunChip />
        <MobileConnectedIndicator />
        <NotificationBell />
      </div>
    </template>

    <template v-else>
      <div class="workspace-meta" :style="`--accent:${safeColor(activeWorkspace.color)}`">
        <div class="workspace-meta__main">
          <span
            class="workspace-chip workspace-meta__path workspace-meta__path--copyable"
            :title="pathTooltip"
            @click="copyPath"
          >
            <svg class="workspace-meta__path-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" />
            </svg>
            <template v-if="pathCopied || pathCopyFailed">{{ pathCopied ? "Copied!" : "Copy failed" }}</template>
            <template v-else
              ><span class="workspace-meta__path-head">{{ pathParts.head }}</span
              ><span class="workspace-meta__path-tail">{{ pathParts.tail }}</span></template
            >
          </span>
        </div>
        <JiraHeaderSearch />
        <div class="workspace-meta__stats">
          <span class="workspace-chip" :title="tabsTitle"
            ><strong>{{ sessionCount }}</strong> tabs</span
          >
          <span class="workspace-chip" :title="runningTitle"
            ><strong>{{ runningCount }}</strong> running</span
          >
          <span
            v-if="gitSnapshot?.available"
            class="workspace-chip"
            :class="gitSnapshot.dirty ? 'workspace-chip--dirty' : 'workspace-chip--clean'"
            :title="branchTitle"
          >
            <strong class="workspace-chip__branch">{{ gitSnapshot.branch }}</strong>
            <span v-if="gitSnapshot.dirty" style="margin-left: 4px">{{ gitSnapshot.dirtyCount }} uncommitted</span>
            <span v-else style="margin-left: 4px">clean</span>
          </span>
          <span v-if="activeWorkspace.kind === 'docker' && dockerAvailable" class="workspace-chip" :title="dockerTitle"
            ><strong>{{ dockerRunning }}</strong
            >/{{ dockerTotal }} containers up</span
          >
          <span
            v-if="attention?.count"
            class="workspace-chip workspace-chip--alert"
            :class="{ 'workspace-chip--alert-fresh': isFreshAttention(attention) }"
            :title="attentionTitle(attention)"
          >
            <strong>{{ attention.count }}</strong> attention
          </span>
          <WorkspaceLayoutChip />
        </div>
        <AgentRunChip />
        <MobileConnectedIndicator />
        <NotificationBell />
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { apiKey } from "../../types/keys.js";
import { useAppStore } from "../../stores/app.js";
import { safeColor, attentionTitle, isFreshAttention } from "../../app/helpers.js";
import WorkspaceLayoutChip from "./WorkspaceLayoutChip.vue";
import NotificationBell from "../layout/NotificationBell.vue";
import JiraHeaderSearch from "../layout/JiraHeaderSearch.vue";
import MobileConnectedIndicator from "../layout/MobileConnectedIndicator.vue";
import AgentRunChip from "../layout/AgentRunChip.vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey);
const store = useAppStore();

const pathCopied = ref(false);
const pathCopyFailed = ref(false);
let pathCopiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyPath() {
  const cwd = activeWorkspace.value?.cwd;
  if (!cwd) return;
  navigator.clipboard.writeText(cwd).then(
    () => {
      pathCopied.value = true;
      pathCopyFailed.value = false;
      if (pathCopiedTimer != null) clearTimeout(pathCopiedTimer);
      pathCopiedTimer = setTimeout(() => {
        pathCopied.value = false;
      }, 1200);
    },
    () => {
      pathCopyFailed.value = true;
      if (pathCopiedTimer != null) clearTimeout(pathCopiedTimer);
      pathCopiedTimer = setTimeout(() => {
        pathCopyFailed.value = false;
      }, 1200);
    },
  );
}

const pathText = computed(() => {
  const workspace = activeWorkspace.value;
  if (!workspace) return "";
  if (workspace.cwd) return workspace.cwd;
  if (workspace.kind === "github") return "GitHub inbox";
  if (workspace.kind === "azure") return "Azure DevOps inbox";
  return "Not set";
});

const pathParts = computed(() => {
  const text = pathText.value;
  const cut = text.replace(/[\\/]+$/, "").search(/[^\\/]*$/);
  return cut > 0 ? { head: text.slice(0, cut), tail: text.slice(cut) } : { head: "", tail: text };
});

const pathTooltip = computed(() =>
  activeWorkspace.value?.cwd ? `${activeWorkspace.value.cwd}\nClick to copy this path to the clipboard.` : "",
);

const isRemote = computed(() => api?.isRemote || false);
const isNativeMobile = computed(() => typeof window.StridetermHost?.postMessage === "function");

// The transport supplies an absolute deadline, so this renders a real countdown
// rather than the stale "in 10s" snapshot emitted when the backoff began.
const reconnectNow = ref(Date.now());
const remoteConnectionMessage = computed(() => {
  const deadline = store.remoteReconnectAt;
  if (!deadline) return store.remoteConnectionIssue;
  const seconds = Math.max(0, Math.ceil((deadline - reconnectNow.value) / 1000));
  return store.remoteConnectionIssue.replace(
    /Reconnecting in \d+s\.\.\./i,
    seconds > 0 ? `Reconnecting in ${seconds}s...` : "Reconnecting...",
  );
});
watch(
  () => store.remoteReconnectAt,
  (deadline, _, onCleanup) => {
    reconnectNow.value = Date.now();
    if (!deadline || deadline <= reconnectNow.value) return;
    const clock = setInterval(() => {
      reconnectNow.value = Date.now();
      if (reconnectNow.value >= deadline) clearInterval(clock);
    }, 250);
    onCleanup(() => clearInterval(clock));
  },
  { immediate: true },
);

// Dismissed per message, not for good: a NEW issue clears the flag, so hiding one banner can never
// hide the next one. Without this the only way to get rid of a banner about something the user has
// decided to live with was to fix it.
const issueDismissed = ref(false);
watch(
  () => store.remoteConnectionIssue,
  () => {
    issueDismissed.value = false;
  },
);
const workspace = computed<Record<string, any> | null>(() => (store.payload as any)?.workspace || null); // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
const activeWorkspace = computed(() => store.activeWorkspace);
// The hero reads only light git fields (available/branch/dirty/dirtyCount), so
// it pulls the summary — present for every workspace on the remote slim core
// without fetching the heavy snapshot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: git summary is open-ended server JSON
const gitSnapshot = computed<Record<string, any> | null>(
  () => (activeWorkspace.value ? (store.getGitSummary(activeWorkspace.value.id) as Record<string, any> | null) : null), // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: attention blob is open-ended server JSON
const attention = computed<Record<string, any> | null>(() =>
  activeWorkspace.value
    ? (store.getWorkspaceAttentionForId(activeWorkspace.value.id) as Record<string, any> | null) // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT
    : null,
);
const reviewTabCount = computed(() => activeWorkspace.value?.panels?.length || 0);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: sessions sub-array from server JSON
const sessionCount = computed(() => (workspace.value?.sessions as any[] | undefined)?.length || 0);
const runningCount = computed(
  () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: sessions sub-array from server JSON
    ((workspace.value?.sessions as any[] | undefined) || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: session item from server JSON
      (s: any) => s.status === "running",
    ).length,
);
// Docker hero shows only counts — read them from the transport-aware accessor
// (core `counts` on remote, computed from the full list on desktop).
const dockerCounts = computed(() =>
  activeWorkspace.value?.kind === "docker" ? store.dockerCounts() : { available: false, total: 0, running: 0 },
);
const dockerAvailable = computed(() => dockerCounts.value.available);
const dockerRunning = computed(() => dockerCounts.value.running);
const dockerTotal = computed(() => dockerCounts.value.total);

const inboxTitle = computed(
  () =>
    `This workspace is your ${activeWorkspace.value?.kind === "github" ? "GitHub" : "Azure DevOps"} pull request inbox.`,
);
const reviewTabsTitle = computed(() => `Tabs open in this inbox: ${reviewTabCount.value}.`);
const tabsTitle = computed(
  () => `Terminal sessions in this workspace: ${sessionCount.value}. Views such as Files or Git are not counted.`,
);
const runningTitle = computed(
  () => `Terminal sessions whose program is still running: ${runningCount.value} of ${sessionCount.value}.`,
);
const branchTitle = computed(() => {
  const snapshot = gitSnapshot.value;
  if (!snapshot) return "";
  const state = snapshot.dirty
    ? `${snapshot.dirtyCount} uncommitted change${snapshot.dirtyCount === 1 ? "" : "s"} in the working tree.`
    : "No uncommitted changes.";
  return `Current Git branch: ${snapshot.branch}. ${state} The Git tab has the details.`;
});
const dockerTitle = computed(() => `Containers running: ${dockerRunning.value} of ${dockerTotal.value}.`);
</script>
