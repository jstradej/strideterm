<template>
  <div class="git-section git-branches">
    <div class="git-branches__toolbar">
      <div class="git-branches__search">
        <input
          v-model="search"
          type="search"
          class="git-branches__search-input"
          placeholder="Filter branches…"
          aria-label="Filter branches"
        />
        <span v-if="search" class="git-branches__search-clear" role="button" tabindex="0" @click="search = ''">×</span>
      </div>
      <label class="git-branches__filter">
        <input v-model="showRemotes" type="checkbox" />
        Show remote branches
      </label>
      <label class="git-branches__filter">
        <input v-model="showMerged" type="checkbox" />
        Only merged
      </label>
      <button
        type="button"
        class="button button--ghost button--small"
        :disabled="branchesLoading"
        title="Re-list local and remote branches with last-commit metadata and ahead/behind counts. Does NOT fetch from the remote — use the toolbar's Fetch button first if you want fresh tracking info."
        @click="refresh"
      >
        {{ branchesLoading ? "Loading…" : "Refresh" }}
      </button>
      <button
        type="button"
        class="button button--small"
        :disabled="!!gitUi.busyAction"
        title="Create a new branch at the current HEAD and switch to it. Uses git checkout -b. Aborts if uncommitted changes would conflict."
        @click="onNewBranchPrompt"
      >
        + New branch
      </button>
    </div>

    <div v-if="branchesError" class="git-info-banner git-info-banner--warn">
      <strong>Failed to load branches</strong>
      <p>{{ branchesError }}</p>
    </div>

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

    <div class="git-branches__split">
      <!-- ===== Local branches ===== -->
      <section class="git-branches__section">
        <header class="git-branches__section-head">
          <h3>
            <span class="git-branches__section-icon" aria-hidden="true">⌥</span>
            Local
            <span class="git-branches__section-count">{{ filteredLocal.length }}</span>
          </h3>
        </header>
        <div v-if="!branchList.local.length && !branchesLoading" class="git-branches__empty">No local branches.</div>
        <ul v-else class="git-branches__list" role="list">
          <li
            v-for="b in filteredLocal"
            :key="`local:${b.name}`"
            :class="[
              'git-branches__row',
              { 'git-branches__row--current': b.isCurrent, 'git-branches__row--merged': b.merged && !b.isCurrent },
            ]"
          >
            <div class="git-branches__row-main">
              <span
                class="git-branches__row-marker"
                :class="{ 'git-branches__row-marker--current': b.isCurrent }"
                aria-hidden="true"
                >{{ b.isCurrent ? "●" : "○" }}</span
              >
              <span class="git-branches__row-name" :title="b.name">{{ b.name }}</span>
              <span v-if="b.isCurrent" class="git-branches__badge git-branches__badge--current">HEAD</span>
              <span v-if="b.merged && !b.isCurrent" class="git-branches__badge git-branches__badge--merged"
                >merged</span
              >
              <span
                v-if="b.upstream"
                class="git-branches__badge git-branches__badge--upstream"
                :title="`Tracks ${b.upstream}`"
                >↥ {{ b.upstream }}</span
              >
              <span
                v-if="b.ahead > 0"
                class="git-branches__counter"
                :title="`${b.ahead} commit(s) on this branch but not on ${b.isCurrent || !branchList.current ? 'upstream' : branchList.current}`"
                >▲ {{ b.ahead }}</span
              >
              <span
                v-if="b.behind > 0"
                class="git-branches__counter"
                :title="`${b.behind} commit(s) on the other side but not here`"
                >▼ {{ b.behind }}</span
              >
            </div>
            <div class="git-branches__row-meta">
              <span class="git-branches__row-hash">{{ b.lastCommit }}</span>
              <span class="git-branches__row-subject" :title="b.lastSubject">{{ b.lastSubject }}</span>
              <span class="git-branches__row-author">{{ b.lastAuthor }}</span>
              <span class="git-branches__row-date">{{ b.lastRelativeDate }}</span>
            </div>
            <div class="git-branches__row-actions">
              <button
                v-if="!b.isCurrent"
                type="button"
                class="button button--ghost button--small"
                :disabled="!!gitUi.busyAction || isDirty"
                :title="
                  isDirty
                    ? 'Disabled — commit or stash your uncommitted changes before checking out another branch.'
                    : `git checkout ${b.name} — make this branch HEAD.`
                "
                @click="onCheckout(b.name)"
              >
                Checkout
              </button>
              <button
                type="button"
                class="button button--ghost button--small"
                :disabled="!!gitUi.busyAction"
                title="Open the New branch input, starting from this branch's tip."
                @click="onNewBranchFrom(b.name)"
              >
                New from…
              </button>
              <button
                type="button"
                class="button button--ghost button--small"
                :disabled="!!gitUi.busyAction"
                title="Rename this branch via git branch -m. If renaming the current branch, the rename happens in place."
                @click="onRename(b.name)"
              >
                Rename
              </button>
              <button
                v-if="!b.isCurrent"
                type="button"
                class="button button--ghost button--small"
                :disabled="!!gitUi.busyAction"
                title="git merge — replay this branch's commits into the current branch with a single merge commit."
                @click="onMergeInto(b.name)"
              >
                Merge into current
              </button>
              <button
                v-if="!b.isCurrent"
                type="button"
                class="button button--ghost button--small"
                :disabled="!!gitUi.busyAction"
                title="git rebase — re-apply the current branch's commits on top of this branch (commit hashes will change)."
                @click="onRebaseOnto(b.name)"
              >
                Rebase onto
              </button>
              <button
                v-if="!b.isCurrent"
                type="button"
                class="button button--ghost button--small button--danger"
                :disabled="!!gitUi.busyAction"
                :title="
                  b.merged
                    ? `Delete branch ${b.name} (merged into current).`
                    : `Delete branch ${b.name}. Has unmerged commits — will require Force delete.`
                "
                @click="onDeleteLocal(b)"
              >
                Delete
              </button>
            </div>
          </li>
        </ul>
      </section>

      <!-- ===== Remote branches ===== -->
      <section v-if="showRemotes" class="git-branches__section">
        <header class="git-branches__section-head">
          <h3>
            <span class="git-branches__section-icon" aria-hidden="true">☁</span>
            Remote
            <span class="git-branches__section-count">{{ filteredRemotes.length }}</span>
          </h3>
        </header>
        <div v-if="!branchList.remotes.length && !branchesLoading" class="git-branches__empty">No remote branches.</div>
        <ul v-else class="git-branches__list" role="list">
          <li
            v-for="r in filteredRemotes"
            :key="`remote:${r.name}`"
            :class="[
              'git-branches__row',
              'git-branches__row--remote',
              { 'git-branches__row--has-local': remoteHasLocal(r.shortName) },
            ]"
          >
            <div class="git-branches__row-main">
              <span class="git-branches__row-marker" aria-hidden="true">↦</span>
              <span class="git-branches__row-name" :title="r.name">{{ r.name }}</span>
              <span class="git-branches__badge git-branches__badge--remote">{{ r.remote || "remote" }}</span>
              <span
                v-if="remoteHasLocal(r.shortName)"
                class="git-branches__badge git-branches__badge--has-local"
                title="A local branch with this short name already exists."
                >local exists</span
              >
            </div>
            <div class="git-branches__row-meta">
              <span class="git-branches__row-hash">{{ r.lastCommit }}</span>
              <span class="git-branches__row-subject" :title="r.lastSubject">{{ r.lastSubject }}</span>
              <span class="git-branches__row-author">{{ r.lastAuthor }}</span>
              <span class="git-branches__row-date">{{ r.lastRelativeDate }}</span>
            </div>
            <div class="git-branches__row-actions">
              <button
                type="button"
                class="button button--ghost button--small"
                :disabled="!!gitUi.busyAction || isDirty"
                :title="
                  isDirty
                    ? 'Disabled — commit or stash your uncommitted changes first.'
                    : `git checkout -b ${r.shortName} --track ${r.name}`
                "
                @click="onCheckoutRemote(r)"
              >
                Checkout
              </button>
              <button
                type="button"
                class="button button--ghost button--small button--danger"
                :disabled="!!gitUi.busyAction"
                :title="`git push ${r.remote} :refs/heads/${r.shortName} — delete the branch on the remote.`"
                @click="onDeleteRemote(r)"
              >
                Delete on remote
              </button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";
import GitOperationCard from "./GitOperationCard.vue";

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi: Record<string, any>;
    isReviewWorkspace?: boolean;
  }>(),
  { isReviewWorkspace: false },
);

const gitUiStore = useGitUiStore();

const search = ref("");
const showRemotes = ref(true);
const showMerged = ref(false);
const newBranchVisible = ref(false);
const newBranchName = ref("");
const startFrom = ref("");

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

const isDirty = computed(() => !!props.snapshot?.dirty);

const localShortNames = computed(() => new Set(branchList.value.local.map((b) => b.name)));
function remoteHasLocal(shortName: string): boolean {
  return localShortNames.value.has(shortName);
}

const filteredLocal = computed<LocalBranch[]>(() => {
  const q = search.value.trim().toLowerCase();
  return branchList.value.local
    .filter((b) => !q || b.name.toLowerCase().includes(q) || b.lastSubject.toLowerCase().includes(q))
    .filter((b) => !showMerged.value || b.merged || b.isCurrent);
});

const filteredRemotes = computed<RemoteBranch[]>(() => {
  const q = search.value.trim().toLowerCase();
  return branchList.value.remotes.filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.lastSubject.toLowerCase().includes(q),
  );
});

function refresh() {
  gitUiStore.gitListBranches(props.workspaceId);
}

function onNewBranchPrompt() {
  startFrom.value = "";
  newBranchName.value = "";
  newBranchVisible.value = true;
}

function onNewBranchFrom(branch: string) {
  startFrom.value = branch;
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
  refresh();
}

async function onCheckout(branch: string) {
  await gitUiStore.gitCheckoutBranch(props.workspaceId, branch);
  refresh();
}

async function onCheckoutRemote(remote: RemoteBranch) {
  // Default local name is the part after the remote/ prefix; if it collides
  // with an existing local branch we suffix with the remote so git doesn't
  // refuse the operation.
  const localBranch = localShortNames.value.has(remote.shortName)
    ? `${remote.remote}-${remote.shortName}`
    : remote.shortName;
  await gitUiStore.gitCheckoutRemoteBranch(props.workspaceId, remote.name, localBranch);
  refresh();
}

async function onDeleteLocal(b: LocalBranch) {
  const force = !b.merged;
  const verb = force ? "Force delete" : "Delete";
  if (!window.confirm(`${verb} branch '${b.name}'?${force ? "\nIt has unmerged commits — they will be lost." : ""}`))
    return;
  await gitUiStore.gitDeleteBranch(props.workspaceId, b.name, force);
}

async function onDeleteRemote(r: RemoteBranch) {
  if (
    !window.confirm(
      `Delete branch '${r.shortName}' on remote '${r.remote}'?\nThis runs git push ${r.remote} :${r.shortName} and CANNOT be undone server-side.`,
    )
  )
    return;
  await gitUiStore.gitDeleteRemoteBranch(props.workspaceId, r.shortName, r.remote);
}

async function onRename(branch: string) {
  const next = window.prompt(`Rename branch '${branch}' to:`, branch);
  if (!next || next.trim() === branch) return;
  await gitUiStore.gitRenameBranch(props.workspaceId, branch, next.trim());
}

function onMergeInto(branch: string) {
  // Reuse the existing pending-confirm flow so the merge runs through the
  // same preflight / dirty-check pipeline as the Update Current Branch card.
  gitUiStore.gitMergeBase(props.workspaceId, branch);
}

function onRebaseOnto(branch: string) {
  gitUiStore.gitRebaseBase(props.workspaceId, branch);
}

watch(
  () => props.workspaceId,
  () => {
    refresh();
  },
  { immediate: true },
);

watch(
  () => props.gitUi?.activeTab,
  (tab) => {
    if (tab === "branches" && !props.gitUi?.branchList) refresh();
  },
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

.git-branches__search {
  position: relative;
  flex: 1 1 220px;
  max-width: 360px;
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

.git-branches__split {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.git-branches__section {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(var(--tint), 0.03);
}

.git-branches__section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: rgba(var(--tint), 0.05);
}

.git-branches__section-head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.git-branches__section-icon {
  font-size: 14px;
  color: var(--accent);
}

.git-branches__section-count {
  margin-left: 6px;
  font-size: 10px;
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 8px;
  text-transform: none;
  letter-spacing: 0;
}

.git-branches__list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
}

.git-branches__empty {
  padding: 16px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
  font-style: italic;
}

.git-branches__row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 6px 10px;
  border-top: 1px solid transparent;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.git-branches__row:last-child {
  border-bottom: none;
}

.git-branches__row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.git-branches__row--current {
  background: rgba(255, 164, 36, 0.07);
  border-left: 2px solid var(--accent);
}
.git-branches__row--current:hover {
  background: rgba(255, 164, 36, 0.12);
}

.git-branches__row--merged {
  opacity: 0.78;
}

.git-branches__row--has-local {
  opacity: 0.85;
}

.git-branches__row-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.git-branches__row-marker {
  width: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--muted);
  font-weight: 600;
}

.git-branches__row-marker--current {
  color: var(--accent);
}

.git-branches__row-name {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.git-branches__badge {
  display: inline-block;
  font-size: 10px;
  padding: 0 6px;
  line-height: 16px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  font-weight: 600;
}

.git-branches__badge--current {
  background: rgba(255, 164, 36, 0.2);
  color: var(--accent);
}

.git-branches__badge--merged {
  background: rgba(76, 175, 80, 0.15);
  color: #6dc070;
}

.git-branches__badge--upstream {
  background: rgba(76, 110, 175, 0.18);
  color: #80a8e0;
  text-transform: none;
  letter-spacing: 0;
}

.git-branches__badge--remote {
  background: rgba(120, 100, 200, 0.18);
  color: #b0a0e8;
  text-transform: none;
  letter-spacing: 0;
}

.git-branches__badge--has-local {
  background: rgba(200, 100, 100, 0.18);
  color: #d99a9a;
  text-transform: none;
  letter-spacing: 0;
}

.git-branches__counter {
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  padding: 0 4px;
  line-height: 14px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--muted);
}

.git-branches__row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.git-branches__row-hash {
  color: var(--accent);
  font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
  font-weight: 600;
  flex: 0 0 auto;
}

.git-branches__row-subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1 1 0;
  min-width: 0;
  color: var(--text);
  opacity: 0.85;
}

.git-branches__row-author {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-branches__row-date {
  flex: 0 0 auto;
  min-width: 70px;
  text-align: right;
}

.git-branches__row-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 900px) {
  .git-branches__row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .git-branches__row-actions {
    justify-content: flex-start;
  }
  .git-branches__row-meta {
    flex-wrap: wrap;
  }
}
</style>
