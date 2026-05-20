<template>
  <div class="git-section git-branches" :class="{ 'git-branches--mobile': isMobile }">
    <!-- Compact toolbar (search + filters + actions).
         Desktop: single row. Mobile: stacked with view-switcher tabs. -->
    <div class="git-branches__toolbar">
      <div class="git-branches__search">
        <input
          v-model="search"
          type="search"
          class="git-branches__search-input"
          placeholder="Filter branches / commits…"
          aria-label="Filter branches and commits"
        />
        <span v-if="search" class="git-branches__search-clear" role="button" tabindex="0" @click="search = ''">×</span>
      </div>
      <label v-if="!isMobile" class="git-branches__filter" title="Include remote-tracking branches in the tree.">
        <input v-model="showRemotes" type="checkbox" />
        Remotes
      </label>
      <label v-if="!isMobile" class="git-branches__filter" title="Show only branches whose tip is reachable from HEAD.">
        <input v-model="showMerged" type="checkbox" />
        Merged only
      </label>
      <button
        type="button"
        class="button button--ghost button--small"
        :disabled="branchesLoading || graphLoading"
        title="Re-list branches and re-read the commit topology. Local only — no fetch."
        @click="refreshAll"
      >
        {{ branchesLoading || graphLoading ? "Loading…" : "Refresh" }}
      </button>
      <button
        type="button"
        class="button button--small"
        :disabled="!!gitUi.busyAction"
        title="Create a new branch at HEAD and switch to it."
        @click="onNewBranchPrompt()"
      >
        + New branch
      </button>
    </div>

    <!-- Mobile view switcher (Tree → Commits → Diff). Hidden on desktop. -->
    <nav v-if="isMobile" class="git-branches__mobile-tabs" role="tablist" aria-label="Branches view">
      <button
        type="button"
        :class="['git-branches__mobile-tab', mobileView === 'tree' && 'git-branches__mobile-tab--active']"
        @click="mobileView = 'tree'"
      >
        Tree
      </button>
      <button
        type="button"
        :class="['git-branches__mobile-tab', mobileView === 'commits' && 'git-branches__mobile-tab--active']"
        :disabled="!selectedRef"
        @click="mobileView = 'commits'"
      >
        Commits<span v-if="selectedRef" class="git-branches__mobile-chip">{{ selectedRef }}</span>
      </button>
      <button
        type="button"
        :class="['git-branches__mobile-tab', mobileView === 'diff' && 'git-branches__mobile-tab--active']"
        :disabled="!selectedHash"
        @click="mobileView = 'diff'"
      >
        Diff
      </button>
    </nav>

    <div v-if="branchesError" class="git-info-banner git-info-banner--warn">
      <strong>Failed to load branches</strong>
      <p>{{ branchesError }}</p>
    </div>

    <!-- Inline "new branch" prompt -->
    <div v-if="newBranchVisible" class="git-branches__inline-form">
      <input
        v-model="newBranchName"
        type="text"
        class="git-pr-form__input"
        placeholder="feature/my-branch"
        @keydown.enter="onCreateBranch"
        @keydown.escape="cancelNewBranch"
      />
      <small v-if="startFrom" class="git-branches__form-hint"
        >from <strong>{{ startFrom }}</strong></small
      >
      <button
        type="button"
        class="button button--small"
        :disabled="!newBranchName.trim() || !!gitUi.busyAction"
        @click="onCreateBranch"
      >
        Create
      </button>
      <button type="button" class="button button--ghost button--small" @click="cancelNewBranch">Cancel</button>
    </div>

    <GitOperationCard :snapshot="snapshot" :workspace-id="workspaceId" :git-ui="gitUi" />

    <!-- ===== Desktop: 3-pane (tree | commits | diff) ===== -->
    <div v-if="!isMobile" class="git-branches__body">
      <Splitpanes class="default-theme git-branches__panes">
        <Pane :size="22" :min-size="14">
          <BranchTreePane
            :tree="branchTree"
            :loading="branchesLoading"
            :selected-ref="selectedRef"
            :head="branchList.current"
            :busy="!!gitUi.busyAction"
            :is-dirty="isDirty"
            @select="onSelectRef"
            @checkout="onCheckout"
            @checkout-remote="onCheckoutRemote"
            @new-from="onNewBranchFrom"
            @rename="onRename"
            @delete="onDeleteLocal"
            @delete-remote="onDeleteRemote"
            @merge="onMergeInto"
            @rebase="onRebaseOnto"
          />
        </Pane>
        <Pane :size="40" :min-size="20">
          <div class="git-branches__commits-pane">
            <div class="git-branches__pane-head">
              <strong>{{ selectedRef ? `Commits on ${selectedRef}` : "All commits" }}</strong>
              <span v-if="loadedCount" class="git-branches__pane-count">{{ loadedCount }}</span>
              <span v-if="graphError" class="git-branches__pane-error">— {{ graphError }}</span>
              <span v-if="selectedRef" class="git-branches__pane-spacer"></span>
              <button
                v-if="selectedRef"
                type="button"
                class="button button--ghost button--small"
                title="Clear branch filter — show commits from all refs."
                @click="onSelectRef('')"
              >
                Show all
              </button>
            </div>
            <GitTreeGraph
              :commits="commits"
              :head="head"
              :refs="refs"
              :selected-hash="selectedHash"
              :loading="graphLoading"
              :error="graphError"
              @select="onSelectCommit"
              @open="onOpenCommitDialog"
            />
          </div>
        </Pane>
        <Pane :size="38" :min-size="20">
          <div class="git-branches__diff-pane">
            <!-- Commit info header (always visible when a commit is picked) -->
            <div v-if="selectedHash" class="git-branches__commit-summary">
              <div class="git-branches__commit-summary-row">
                <span class="git-branches__commit-hash">{{ shortHashOf(selectedHash) }}</span>
                <span class="git-branches__commit-subject" :title="selectedCommitInfo?.subject || ''">{{
                  selectedCommitInfo?.subject || ""
                }}</span>
                <button
                  type="button"
                  class="button button--ghost button--small"
                  title="Open full commit dialog"
                  @click="onOpenCommitDialog(selectedHash)"
                >
                  Details
                </button>
              </div>
              <div class="git-branches__commit-summary-meta">
                <span v-if="selectedCommitInfo?.author"
                  ><strong>{{ selectedCommitInfo.author }}</strong></span
                >
                <span v-if="selectedCommitInfo?.relativeDate" :title="selectedCommitInfo.isoDate">{{
                  selectedCommitInfo.relativeDate
                }}</span>
                <span
                  v-for="refName in selectedCommitInfo?.refs || []"
                  :key="refName"
                  class="git-branches__commit-ref"
                  >{{ refName }}</span
                >
              </div>
            </div>
            <Splitpanes horizontal class="default-theme git-branches__inner-panes">
              <Pane :size="35" :min-size="18">
                <div class="git-branches__commit-files">
                  <div v-if="!selectedHash" class="git-branches__placeholder">Select a commit to see its files.</div>
                  <div v-else-if="commitFilesLoading" class="git-branches__placeholder">Loading…</div>
                  <GitChangeTree
                    v-else-if="selectedHash"
                    :files="commitFiles"
                    :selected-path="selectedCommitFile"
                    selected-scope="commit"
                    @select="onSelectCommitFile"
                  />
                </div>
              </Pane>
              <Pane :size="65" :min-size="20">
                <div class="git-branches__commit-diff">
                  <MonacoDiffPanel
                    v-if="selectedCommitFile"
                    :payload="commitDiffPayload"
                    :loading="commitDiffLoading"
                  />
                  <div v-else class="git-branches__placeholder">
                    {{ selectedHash ? "Pick a file to view its diff." : "" }}
                  </div>
                </div>
              </Pane>
            </Splitpanes>
          </div>
        </Pane>
      </Splitpanes>
    </div>

    <!-- ===== Mobile: stacked single-pane wizard ===== -->
    <div v-else class="git-branches__mobile-body">
      <BranchTreePane
        v-if="mobileView === 'tree'"
        :tree="branchTree"
        :loading="branchesLoading"
        :selected-ref="selectedRef"
        :head="branchList.current"
        :busy="!!gitUi.busyAction"
        :is-dirty="isDirty"
        :compact="true"
        @select="onMobileSelectRef"
        @checkout="onCheckout"
        @checkout-remote="onCheckoutRemote"
        @new-from="onNewBranchFrom"
        @rename="onRename"
        @delete="onDeleteLocal"
        @delete-remote="onDeleteRemote"
        @merge="onMergeInto"
        @rebase="onRebaseOnto"
      />

      <div v-else-if="mobileView === 'commits'" class="git-branches__commits-pane">
        <div class="git-branches__pane-head">
          <button
            type="button"
            class="git-branches__mobile-back"
            title="Back to branch tree"
            @click="mobileView = 'tree'"
          >
            ‹
          </button>
          <strong>{{ selectedRef || "Commits" }}</strong>
          <span v-if="loadedCount" class="git-branches__pane-count">{{ loadedCount }}</span>
        </div>
        <GitTreeGraph
          :commits="commits"
          :head="head"
          :refs="refs"
          :selected-hash="selectedHash"
          :loading="graphLoading"
          :error="graphError"
          :compact="true"
          @select="onMobileSelectCommit"
          @open="onOpenCommitDialog"
        />
      </div>

      <div v-else-if="mobileView === 'diff'" class="git-branches__diff-pane git-branches__diff-pane--mobile">
        <div class="git-branches__pane-head">
          <button
            type="button"
            class="git-branches__mobile-back"
            title="Back to commits"
            @click="mobileView = 'commits'"
          >
            ‹
          </button>
          <span class="git-branches__commit-hash">{{ shortHashOf(selectedHash) }}</span>
          <span class="git-branches__commit-subject" :title="selectedCommitInfo?.subject || ''">{{
            selectedCommitInfo?.subject || ""
          }}</span>
        </div>
        <div class="git-branches__mobile-files">
          <div v-if="commitFilesLoading" class="git-branches__placeholder">Loading…</div>
          <GitChangeTree
            v-else
            :files="commitFiles"
            :selected-path="selectedCommitFile"
            selected-scope="commit"
            @select="onSelectCommitFile"
          />
        </div>
        <div class="git-branches__commit-diff git-branches__commit-diff--mobile">
          <MonacoDiffPanel v-if="selectedCommitFile" :payload="commitDiffPayload" :loading="commitDiffLoading" />
          <div v-else class="git-branches__placeholder">Tap a file to view its diff.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useIsNarrow } from "../../../composables/useIsNarrow.js";
import GitOperationCard from "./GitOperationCard.vue";
import GitTreeGraph from "./GitTreeGraph.vue";
import GitChangeTree from "./GitChangeTree.vue";
import BranchTreePane, { type BranchTreeNode } from "./BranchTreePane.vue";

const MonacoDiffPanel = defineAsyncComponent(() => import("../../shared/MonacoDiffPanel.vue"));

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi: Record<string, any>;
    activeRootPath?: string;
    isReviewWorkspace?: boolean;
  }>(),
  { activeRootPath: "", isReviewWorkspace: false },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();
const { isMobile } = useIsNarrow();

const search = ref("");
const showRemotes = ref(true);
const showMerged = ref(false);
const newBranchVisible = ref(false);
const newBranchName = ref("");
const startFrom = ref("");

// Mobile-only "wizard" step (tree → commits → diff)
const mobileView = ref<"tree" | "commits" | "diff">("tree");

// Which ref is selected in the branch tree (acts as a graph filter).
// Empty string = no filter (shows the full Log).
const selectedRef = ref<string>("");

const branchesLoading = computed(() => props.gitUi?.branchesLoading === true);
const branchesError = computed(() => String(props.gitUi?.branchesError || ""));

interface LocalBranch {
  name: string;
  isCurrent: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  lastCommit: string;
  lastSubject: string;
  lastAuthor: string;
  lastRelativeDate: string;
  merged: boolean;
}
interface RemoteBranch {
  name: string;
  remote: string;
  shortName: string;
  lastCommit: string;
  lastSubject: string;
  lastAuthor: string;
  lastRelativeDate: string;
}
interface TagEntry {
  name: string;
  hash?: string;
  shortHash?: string;
  subject?: string;
}

const branchList = computed<{ current: string; upstream: string; local: LocalBranch[]; remotes: RemoteBranch[] }>(
  () => {
    const bl = props.gitUi?.branchList || {};
    return {
      current: bl.current || "",
      upstream: bl.upstream || "",
      local: (bl.local as LocalBranch[]) || [],
      remotes: (bl.remotes as RemoteBranch[]) || [],
    };
  },
);

const tags = computed<TagEntry[]>(() => (props.gitUi?.tags as TagEntry[]) || []);

const isDirty = computed(() => !!props.snapshot?.dirty);

const localShortNames = computed(() => new Set(branchList.value.local.map((b) => b.name)));

// --- Build the hierarchical branch tree ----------------------------------
//
// Sections:
//   HEAD          → single node pointing at the current branch
//   Local         → tree of local branches, split by "/" so feature/foo
//                   appears under a collapsible "feature" folder
//   Remote/<r>    → one section per remote name (origin, upstream, …) with
//                   the same `/`-split sub-tree
//   Tags          → flat list of tag names
//
// `search` filters branch/tag names case-insensitively; folders are kept
// when at least one descendant matches.

const branchTree = computed<BranchTreeNode[]>(() => {
  const q = search.value.trim().toLowerCase();
  const head = branchList.value.current;
  const out: BranchTreeNode[] = [];

  if (head) {
    out.push({
      key: "head",
      kind: "section",
      label: "HEAD (Current Branch)",
      icon: "★",
      children: [
        {
          key: `head:${head}`,
          kind: "branch-local",
          label: head,
          ref: head,
          isCurrent: true,
          upstream: branchList.value.upstream,
          children: [],
        },
      ],
    });
  }

  // Build a `/`-split forest from a list of names.
  function buildForest(
    entries: Array<{ shortName: string; ref: string; meta: BranchTreeNode["meta"]; kind: BranchTreeNode["kind"] }>,
    keyPrefix: string,
  ): BranchTreeNode[] {
    interface Cursor extends BranchTreeNode {
      childMap: Map<string, Cursor>;
    }
    const root: Cursor = {
      key: keyPrefix,
      kind: "folder",
      label: "",
      ref: "",
      children: [],
      childMap: new Map(),
    } as Cursor;
    for (const entry of entries) {
      if (q && !entry.shortName.toLowerCase().includes(q)) continue;
      const parts = entry.shortName.split("/").filter(Boolean);
      let cursor: Cursor = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        let next = cursor.childMap!.get(seg);
        if (!next) {
          const folderPath = parts.slice(0, i + 1).join("/");
          next = {
            key: `${keyPrefix}:dir:${folderPath}`,
            kind: "folder",
            label: seg,
            ref: "",
            children: [],
            childMap: new Map(),
          } as Cursor;
          cursor.childMap!.set(seg, next);
          cursor.children!.push(next);
        }
        cursor = next;
      }
      const leaf: BranchTreeNode = {
        key: `${keyPrefix}:${entry.ref}`,
        kind: entry.kind,
        label: parts[parts.length - 1] || entry.shortName,
        ref: entry.ref,
        isCurrent: entry.kind === "branch-local" && entry.ref === head,
        meta: entry.meta,
        children: [],
      };
      cursor.children!.push(leaf);
    }
    // Strip cursor-only helper data before returning
    function strip(node: BranchTreeNode): BranchTreeNode {
      const { childMap: _drop, ...rest } = node as Cursor;
      void _drop;
      return { ...rest, children: (rest.children || []).map(strip) };
    }
    sortForest(root);
    return root.children!.map(strip);

    function sortForest(node: Cursor) {
      const folders = node.children!.filter((c) => c.kind === "folder") as Cursor[];
      const leaves = node.children!.filter((c) => c.kind !== "folder");
      folders.sort((a, b) => a.label.localeCompare(b.label));
      leaves.sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) return -1;
        if (!a.isCurrent && b.isCurrent) return 1;
        return a.label.localeCompare(b.label);
      });
      node.children = [...folders, ...leaves];
      for (const f of folders) sortForest(f);
    }
  }

  // ---- Local ----
  const locals = branchList.value.local
    .filter((b) => !showMerged.value || b.merged || b.isCurrent)
    .map((b) => ({
      shortName: b.name,
      ref: b.name,
      kind: "branch-local" as const,
      meta: {
        ahead: b.ahead,
        behind: b.behind,
        upstream: b.upstream,
        merged: b.merged,
        lastCommit: b.lastCommit,
        lastSubject: b.lastSubject,
        lastAuthor: b.lastAuthor,
        lastRelativeDate: b.lastRelativeDate,
        isCurrent: b.isCurrent,
      },
    }));
  const localTree = buildForest(locals, "local");
  if (localTree.length) {
    out.push({
      key: "local",
      kind: "section",
      label: "Local",
      icon: "⌥",
      children: localTree,
      meta: { count: locals.length },
    });
  }

  // ---- Remotes ----
  if (showRemotes.value) {
    const byRemote = new Map<string, RemoteBranch[]>();
    for (const r of branchList.value.remotes) {
      const list = byRemote.get(r.remote) || [];
      list.push(r);
      byRemote.set(r.remote, list);
    }
    const remoteNames = Array.from(byRemote.keys()).sort();
    for (const remoteName of remoteNames) {
      const entries = byRemote.get(remoteName) || [];
      const mapped = entries.map((r) => ({
        shortName: r.shortName,
        ref: r.name,
        kind: "branch-remote" as const,
        meta: {
          remote: r.remote,
          lastCommit: r.lastCommit,
          lastSubject: r.lastSubject,
          lastAuthor: r.lastAuthor,
          lastRelativeDate: r.lastRelativeDate,
          hasLocal: localShortNames.value.has(r.shortName),
        },
      }));
      const subTree = buildForest(mapped, `remote:${remoteName}`);
      if (!subTree.length) continue;
      out.push({
        key: `remote:${remoteName}`,
        kind: "section",
        label: `Remote · ${remoteName}`,
        icon: "☁",
        children: subTree,
        meta: { count: entries.length },
      });
    }
  }

  // ---- Tags ----
  const tagNames = tags.value.map((t) => t.name).filter((n) => !q || n.toLowerCase().includes(q));
  if (tagNames.length) {
    const mapped = tagNames.map((name) => ({
      shortName: name,
      ref: name,
      kind: "tag" as const,
      meta: { tag: true },
    }));
    out.push({
      key: "tags",
      kind: "section",
      label: "Tags",
      icon: "🏷",
      children: buildForest(mapped, "tag"),
      meta: { count: tagNames.length },
    });
  }

  return out;
});

// --- Commit graph state (per-branch filter applied via gitLoadGraph) ----

interface GraphCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  relativeDate: string;
  isoDate: string;
  refs: string[];
}

const graphLoading = computed(() => props.gitUi?.graphLoading === true);
const graphError = computed(() => String(props.gitUi?.graphError || ""));
const commits = computed<GraphCommit[]>(() => (props.gitUi?.graph?.commits as GraphCommit[]) || []);
const head = computed(() => String(props.gitUi?.graph?.head || ""));
const refs = computed<Record<string, string>>(() => (props.gitUi?.graph?.refs as Record<string, string>) || {});
const loadedCount = computed(() => commits.value.length);

const selectedHash = computed(() => String(props.gitUi?.selectedCommit || ""));
const selectedCommitInfo = computed<GraphCommit | null>(
  () => commits.value.find((c) => c.hash === selectedHash.value) || null,
);

function shortHashOf(hash: string): string {
  if (!hash) return "";
  return hash.length > 7 ? hash.slice(0, 7) : hash;
}

function refreshBranches() {
  gitUiStore.gitListBranches(props.workspaceId);
  if (!tags.value.length && !props.gitUi?.tagsLoading) {
    gitUiStore.gitListTags(props.workspaceId);
  }
}

function refreshGraph() {
  gitUiStore.gitLoadGraph(props.workspaceId, {
    limit: 500,
    includeRemotes: showRemotes.value,
    branch: selectedRef.value || "",
  });
}

function refreshAll() {
  refreshBranches();
  refreshGraph();
}

watch(
  () => props.workspaceId,
  () => refreshAll(),
  { immediate: true },
);

watch(
  () => props.activeRootPath,
  () => refreshAll(),
);

watch(showRemotes, () => refreshGraph());

watch(
  () => props.gitUi?.activeTab,
  (tab) => {
    if (tab !== "branches") return;
    if (!props.gitUi?.branchList) refreshBranches();
    if (!props.gitUi?.graph?.commits?.length) refreshGraph();
  },
);

// --- Branch tree interactions -------------------------------------------

function onSelectRef(ref: string) {
  selectedRef.value = ref;
  // Clear current commit selection so the diff pane doesn't show a commit
  // unrelated to the new branch view.
  gitUiStore.gitSelectCommit(props.workspaceId, "");
  refreshGraph();
}

function onMobileSelectRef(ref: string) {
  onSelectRef(ref);
  if (ref) mobileView.value = "commits";
}

function onNewBranchPrompt() {
  startFrom.value = "";
  newBranchName.value = "";
  newBranchVisible.value = true;
}

function onNewBranchFrom(ref: string) {
  startFrom.value = ref;
  newBranchName.value = "";
  newBranchVisible.value = true;
}

function cancelNewBranch() {
  newBranchVisible.value = false;
  newBranchName.value = "";
  startFrom.value = "";
}

async function onCreateBranch() {
  const name = newBranchName.value.trim();
  if (!name) return;
  await gitUiStore.gitCreateBranch(props.workspaceId, name, startFrom.value);
  cancelNewBranch();
  refreshAll();
}

async function onCheckout(ref: string) {
  await gitUiStore.gitCheckoutBranch(props.workspaceId, ref);
  refreshAll();
}

async function onCheckoutRemote(remoteRef: string) {
  const slash = remoteRef.indexOf("/");
  const remoteName = slash >= 0 ? remoteRef.slice(0, slash) : "";
  const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  const localBranch = localShortNames.value.has(shortName) ? `${remoteName}-${shortName}` : shortName;
  await gitUiStore.gitCheckoutRemoteBranch(props.workspaceId, remoteRef, localBranch);
  refreshAll();
}

async function onDeleteLocal(ref: string) {
  const entry = branchList.value.local.find((b) => b.name === ref);
  if (!entry) return;
  const force = !entry.merged;
  const verb = force ? "Force delete" : "Delete";
  if (
    !window.confirm(`${verb} branch '${entry.name}'?${force ? "\nIt has unmerged commits — they will be lost." : ""}`)
  )
    return;
  await gitUiStore.gitDeleteBranch(props.workspaceId, entry.name, force);
  refreshAll();
}

async function onDeleteRemote(remoteRef: string) {
  const slash = remoteRef.indexOf("/");
  const remoteName = slash >= 0 ? remoteRef.slice(0, slash) : "origin";
  const shortName = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  if (
    !window.confirm(
      `Delete branch '${shortName}' on remote '${remoteName}'?\nThis runs git push ${remoteName} :${shortName} and CANNOT be undone server-side.`,
    )
  )
    return;
  await gitUiStore.gitDeleteRemoteBranch(props.workspaceId, shortName, remoteName);
  refreshAll();
}

async function onRename(ref: string) {
  const next = window.prompt(`Rename branch '${ref}' to:`, ref);
  if (!next || next.trim() === ref) return;
  await gitUiStore.gitRenameBranch(props.workspaceId, ref, next.trim());
  refreshAll();
}

function onMergeInto(ref: string) {
  gitUiStore.gitMergeBase(props.workspaceId, ref);
}

function onRebaseOnto(ref: string) {
  gitUiStore.gitRebaseBase(props.workspaceId, ref);
}

// --- Commit selection + file diff (mirrors GitGraphTab) -----------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const commitFiles = ref<any[]>([]);
const commitFilesLoading = ref(false);
const selectedCommitFile = ref("");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const commitDiffPayload = ref<Record<string, any> | null>(null);
const commitDiffLoading = ref(false);
let commitFilesSeq = 0;
let commitDiffSeq = 0;

async function loadCommitFiles(hash: string) {
  if (!hash || !props.activeRootPath) {
    commitFiles.value = [];
    return;
  }
  const seq = ++commitFilesSeq;
  commitFilesLoading.value = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await api.fileCommitFiles({ rootPath: props.activeRootPath, hash })) as any;
    if (seq !== commitFilesSeq) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitFiles.value = (result?.files || []).map((f: any) => ({ ...f, scope: "commit" }));
  } catch {
    if (seq !== commitFilesSeq) return;
    commitFiles.value = [];
  } finally {
    if (seq === commitFilesSeq) commitFilesLoading.value = false;
  }
}

async function loadCommitFileDiff(hash: string, relativePath: string) {
  if (!hash || !relativePath || !props.activeRootPath) {
    commitDiffPayload.value = null;
    return;
  }
  const seq = ++commitDiffSeq;
  commitDiffLoading.value = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = (await api.fileCommitDiff({ rootPath: props.activeRootPath, relativePath, hash })) as any;
    if (seq !== commitDiffSeq) return;
    commitDiffPayload.value = payload;
  } catch (err) {
    if (seq !== commitDiffSeq) return;
    commitDiffPayload.value = {
      ok: false,
      leftError: (err as Error)?.message || "Failed to load commit diff",
      leftContent: "",
      rightContent: "",
      leftLabel: "",
      rightLabel: "",
      leftMissing: true,
      rightMissing: true,
      language: "plaintext",
    };
  } finally {
    if (seq === commitDiffSeq) commitDiffLoading.value = false;
  }
}

function onSelectCommit(hash: string) {
  if (!hash) return;
  gitUiStore.gitSelectCommit(props.workspaceId, hash);
}

function onMobileSelectCommit(hash: string) {
  onSelectCommit(hash);
  if (hash) mobileView.value = "diff";
}

function onSelectCommitFile(path: string) {
  selectedCommitFile.value = path;
  if (selectedHash.value) loadCommitFileDiff(selectedHash.value, path);
}

function onOpenCommitDialog(hash: string) {
  const entry = commits.value.find((c) => c.hash === hash);
  appStore.openDialog("GitCommitInfoDialog", {
    workspaceId: props.workspaceId,
    rootPath: props.activeRootPath || "",
    hash: entry?.shortHash || hash,
    seed: {
      shortHash: entry?.shortHash || "",
      hash: entry?.hash || hash,
      subject: entry?.subject || "",
      author: entry?.author || "",
      relativeDate: entry?.relativeDate || "",
      refs: (entry?.refs || []).join(", "),
    },
    onClose: () => appStore.closeDialog(),
  });
}

watch(
  () => selectedHash.value,
  (hash) => {
    selectedCommitFile.value = "";
    commitDiffPayload.value = null;
    if (hash) loadCommitFiles(hash);
    else commitFiles.value = [];
  },
  { immediate: true },
);
</script>

<style scoped>
.git-branches {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  height: 100%;
  min-height: 0;
}

.git-branches--mobile {
  padding: 6px;
  gap: 6px;
}

.git-branches__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
  flex: 0 0 auto;
}

.git-branches--mobile .git-branches__toolbar {
  padding: 4px 6px;
  gap: 6px;
}

.git-branches__search {
  position: relative;
  flex: 1 1 220px;
  max-width: 360px;
}

.git-branches--mobile .git-branches__search {
  max-width: none;
}

.git-branches__search-input {
  width: 100%;
  padding: 4px 26px 4px 8px;
  font-size: 12px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 3px;
  outline: none;
}

.git-branches__search-input:focus {
  border-color: var(--accent);
}

.git-branches__search-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.git-branches__search-clear:hover {
  color: var(--text);
}

.git-branches__filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.git-branches__filter input {
  margin: 0;
}

.git-branches__inline-form {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px dashed var(--accent);
  border-radius: 4px;
  background: rgba(255, 164, 36, 0.05);
  flex: 0 0 auto;
}

.git-branches__inline-form input[type="text"] {
  flex: 1;
  min-width: 0;
}

.git-branches__form-hint {
  color: var(--muted);
  font-size: 11px;
}

.git-branches__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.git-branches__panes,
.git-branches__inner-panes {
  height: 100%;
  background: transparent !important;
}

:deep(.git-branches__panes.splitpanes > .splitpanes__pane),
:deep(.git-branches__inner-panes.splitpanes > .splitpanes__pane) {
  background: transparent !important;
  overflow: hidden;
}

:deep(.git-branches__panes.splitpanes > .splitpanes__splitter),
:deep(.git-branches__inner-panes.splitpanes > .splitpanes__splitter) {
  background: var(--border) !important;
  min-width: 3px;
  min-height: 3px;
}

:deep(.git-branches__panes.splitpanes > .splitpanes__splitter:hover),
:deep(.git-branches__inner-panes.splitpanes > .splitpanes__splitter:hover) {
  background: var(--accent) !important;
}

.git-branches__commits-pane,
.git-branches__diff-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
  overflow: hidden;
}

.git-branches__diff-pane {
  border: none;
  background: transparent;
}

.git-branches__commits-pane {
  border: none;
  background: transparent;
}

.git-branches__pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  background: rgba(var(--tint), 0.05);
  flex: 0 0 auto;
}

.git-branches__pane-head strong {
  font-size: 12px;
  color: var(--text);
  text-transform: none;
  letter-spacing: 0;
}

.git-branches__pane-count {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.git-branches__pane-error {
  color: #e07b8e;
  font-size: 11px;
  text-transform: none;
}

.git-branches__pane-spacer {
  flex: 1;
}

.git-branches__commits-pane > .git-tree,
.git-branches__commits-pane > :deep(.git-tree) {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
}

.git-branches__commit-files,
.git-branches__commit-diff {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}

.git-branches__commit-diff {
  position: relative;
}

.git-branches__commit-diff > * {
  flex: 1;
  min-height: 0;
}

.git-branches__commit-files-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  background: rgba(var(--tint), 0.05);
  flex: 0 0 auto;
}

.git-branches__commit-hash {
  font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
  font-weight: 600;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.git-branches__commit-subject {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font-size: 12px;
}

.git-branches__commit-meta {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 11px;
}

.git-branches__commit-summary {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--tint), 0.05);
}

.git-branches__commit-summary-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.git-branches__commit-summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  color: var(--muted);
}

.git-branches__commit-ref {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(76, 175, 80, 0.18);
  color: #6dc070;
  font-weight: 600;
}

.git-branches__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
  padding: 12px;
  text-align: center;
}

/* ===== Mobile / minimal layout ===== */
.git-branches__mobile-tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  flex: 0 0 auto;
}

.git-branches__mobile-tab {
  flex: 1;
  padding: 8px 6px;
  font-size: 12px;
  background: rgba(var(--tint), 0.05);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.git-branches__mobile-tab[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.git-branches__mobile-tab--active {
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  border-color: var(--accent);
}

.git-branches__mobile-chip {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-branches__mobile-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.git-branches__mobile-back {
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.git-branches__diff-pane--mobile {
  gap: 4px;
}

.git-branches__mobile-files {
  flex: 0 0 35%;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}

.git-branches__commit-diff--mobile {
  flex: 1;
  min-height: 0;
}
</style>
