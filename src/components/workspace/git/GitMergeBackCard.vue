<template>
  <article class="git-card">
    <div class="section-head">
      <div>
        <p class="eyebrow">{{ isCleanupMode ? "Cleanup" : "Merge Back" }}</p>
        <h3>{{ snapshot.branch }} &rarr; {{ resolvedBaseBranch || "?" }}</h3>
      </div>
    </div>

    <div class="git-detail-list" style="margin-bottom: 8px">
      <span class="git-detail-list__row">
        <strong>Target branch:</strong>
        <template v-if="isLinkedWorktree">{{ resolvedBaseBranch || "?" }}</template>
        <CustomSelect
          v-else
          class="git-branch-select"
          :model-value="resolvedBaseBranch"
          placeholder="-- select --"
          :options="baseBranchOptionList"
          searchable
          search-placeholder="Filter branches…"
          @change="onTargetChange"
        />
      </span>
    </div>

    <template v-if="!resolvedBaseBranch">
      <p class="git-card__hint">Base branch was not detected.</p>
    </template>

    <!-- UC-13: Cleanup mode — branch is merged -->
    <template v-else-if="isCleanupMode">
      <div class="git-info-banner" style="margin-bottom: 8px">
        <strong>Branch merged</strong>
        <p>
          Branch <code>{{ snapshot.branch }}</code> has been merged into <code>{{ resolvedBaseBranch }}</code
          >. Ready to clean up.
        </p>
      </div>
      <div class="git-operation-actions">
        <button
          type="button"
          class="button button--ghost danger"
          :disabled="!!gitUi.busyAction"
          title="Remove worktree directory and delete the merged branch"
          @click="
            gitUiStore.confirmRemoveWorktreeDeleteBranch(workspaceId, {
              worktreePath: snapshot.worktreePath,
              branch: snapshot.branch,
              branchMerged: true,
            })
          "
        >
          Remove worktree + delete branch
        </button>
        <button
          type="button"
          class="button button--ghost"
          :disabled="!!gitUi.busyAction"
          title="Remove the worktree but keep the branch"
          @click="
            gitUiStore.confirmRemoveWorktree(workspaceId, {
              worktreePath: snapshot.worktreePath,
              branch: snapshot.branch,
              branchMerged: true,
            })
          "
        >
          Remove worktree only
        </button>
      </div>
    </template>

    <template v-else-if="!compare.aheadCount">
      <!-- Nothing to merge back yet -->
      <template v-if="snapshot.dirty">
        <p class="git-card__hint">
          No commits ahead of {{ resolvedBaseBranch }} yet. Use the <strong>Changes</strong> tab to commit your changes.
        </p>
        <details v-if="dirtyConflicts.length" class="git-details">
          <summary class="git-card__hint git-card__hint--warning">
            Conflict risk: {{ dirtyConflicts.length }} overlapping dirty file{{
              dirtyConflicts.length === 1 ? "" : "s"
            }}
          </summary>
          <p class="git-card__hint git-card__hint--warning">
            Some dirty files were also changed on {{ resolvedBaseBranch }}. Resolve or stash them before merging back.
          </p>
          <details class="git-details">
            <summary>Show overlapping files</summary>
            <ul class="git-file-list">
              <li v-for="(filePath, i) in dirtyConflicts.slice(0, 30)" :key="i">
                <span class="git-file" :title="`Potential conflict: ${filePath}`">
                  <span class="git-status-code">!</span>
                  <span class="git-file__name">{{ filePath }}</span>
                </span>
              </li>
              <li v-if="dirtyConflicts.length > 30">
                <p class="git-card__hint">… and {{ dirtyConflicts.length - 30 }} more files.</p>
              </li>
            </ul>
          </details>
        </details>
      </template>
      <p v-else class="git-card__hint">
        Branch is clean and up to date with {{ resolvedBaseBranch }}. Nothing to merge back.
      </p>
    </template>

    <template v-else>
      <!-- Has commits to merge back -->
      <div class="git-stat-row">
        <span class="workspace-chip"
          ><strong>{{ compare.aheadCount || 0 }}</strong> commits to merge</span
        >
        <span class="workspace-chip"
          ><strong>{{ compare.files?.length || 0 }}</strong> files changed</span
        >
        <span v-if="compare.behindCount > 0" class="workspace-chip workspace-chip--alert"
          ><strong>{{ compare.behindCount }}</strong> behind base</span
        >
      </div>
      <p v-if="compare.behindCount > 0" class="git-card__hint git-card__hint--warning">
        This branch is {{ compare.behindCount }} commit(s) behind {{ resolvedBaseBranch }}. Rebase or merge base first
        to reduce conflict risk.
      </p>

      <details v-if="compare.files?.length" class="git-details">
        <summary>Changed files ({{ compare.files.length }})</summary>
        <ul class="git-file-list">
          <li v-for="(entry, i) in compare.files.slice(0, 30)" :key="i">
            <span class="git-file" :title="`${entry.code || 'M'}: ${entry.path}`">
              <span class="git-status-code">{{ entry.code || "M" }}</span>
              <span class="git-file__name">{{ entry.path }}</span>
            </span>
          </li>
          <li v-if="compare.files.length > 30">
            <p class="git-card__hint">… and {{ compare.files.length - 30 }} more files.</p>
          </li>
        </ul>
      </details>

      <details v-if="potentialConflicts.length" class="git-details">
        <summary class="git-card__hint--warning">Potential conflicts ({{ potentialConflicts.length }})</summary>
        <p class="git-card__hint git-card__hint--warning">
          These files were modified on both your branch and {{ resolvedBaseBranch }}.
        </p>
        <ul class="git-file-list">
          <li v-for="(filePath, i) in potentialConflicts.slice(0, 30)" :key="i">
            <span class="git-file" :title="`Potential conflict: ${filePath}`">
              <span class="git-status-code">!</span>
              <span class="git-file__name">{{ filePath }}</span>
            </span>
          </li>
          <li v-if="potentialConflicts.length > 30">
            <p class="git-card__hint">… and {{ potentialConflicts.length - 30 }} more files.</p>
          </li>
        </ul>
      </details>

      <div class="git-operation-actions">
        <button
          type="button"
          :class="['button', gitUi.busyAction === 'mergeIntoBase' && 'button--busy']"
          :disabled="!!gitUi.busyAction"
          :title="`Runs: git merge ${snapshot.branch} in the ${resolvedBaseBranch} worktree.`"
          @click="gitUiStore.gitMergeIntoBase(workspaceId, resolvedBaseBranch)"
        >
          {{ gitUi.busyAction === "mergeIntoBase" ? "Merging…" : `Merge ${snapshot.branch}` }} &rarr;
          {{ resolvedBaseBranch }}
        </button>
        <button
          v-if="mainWorktreeWorkspaceId"
          type="button"
          class="button button--ghost"
          :title="`Switch to ${resolvedBaseBranch} worktree.`"
          @click="appStore.activateWorkspaceInGrid(mainWorktreeWorkspaceId)"
        >
          Open {{ resolvedBaseBranch }} worktree
        </button>
      </div>

      <details v-if="snapshot.worktreePath && !snapshot.isMainWorktree" class="git-details">
        <summary>After merge: clean up worktree</summary>
        <p class="git-card__hint">Once merged, you can remove this worktree and delete the branch.</p>
        <div class="git-operation-actions">
          <button
            type="button"
            class="button button--ghost danger"
            :disabled="!!gitUi.busyAction"
            title="Removes this worktree directory and deletes the branch."
            @click="
              gitUiStore.confirmRemoveWorktreeDeleteBranch(workspaceId, {
                worktreePath: snapshot.worktreePath,
                branch: snapshot.branch,
                branchMerged: snapshot.branchMerged,
              })
            "
          >
            Remove worktree + delete branch
          </button>
          <button
            type="button"
            class="button button--ghost"
            :disabled="!!gitUi.busyAction"
            title="Removes the worktree but keeps the branch."
            @click="
              gitUiStore.confirmRemoveWorktree(workspaceId, {
                worktreePath: snapshot.worktreePath,
                branch: snapshot.branch,
                branchMerged: snapshot.branchMerged,
              })
            "
          >
            Remove worktree only
          </button>
        </div>
      </details>
    </template>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import CustomSelect from "../../common/CustomSelect.vue";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaces?: any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi?: Record<string, any>;
    effectiveBaseBranch?: string;
    baseBranchOptions?: string[];
    isLinkedWorktree?: boolean;
  }>(),
  {
    workspaces: () => [],
    gitUi: () => ({}),
    effectiveBaseBranch: "",
    baseBranchOptions: () => [],
    isLinkedWorktree: false,
  },
);

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const compare = computed(() => props.snapshot.compareWithBase || {});
const localOverride = ref("");
const resolvedBaseBranch = computed(
  () => localOverride.value || props.effectiveBaseBranch || props.snapshot.baseBranch || compare.value.baseBranch || "",
);

// UC-13: cleanup mode — branch merged into base, no commits ahead
const isCleanupMode = computed(
  () => props.snapshot.branchMerged === true && (compare.value.aheadCount || 0) === 0 && props.isLinkedWorktree,
);

function onTargetChange(value: string | number) {
  localOverride.value = String(value);
}

const baseBranchOptionList = computed(() => props.baseBranchOptions.map((b: string) => ({ value: b, label: b })));
const potentialConflicts = computed(() => compare.value.potentialConflicts || []);

const workspaceIdsByPath = computed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  () => new Map(props.workspaces.map((ws: any) => [String(ws.cwd || "").toLowerCase(), ws.id])),
);
const mainWorktree = computed(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (props.snapshot.siblingWorktrees || []).find((e: any) => e.isMainWorktree && !e.isCurrent),
);
const mainWorktreeWorkspaceId = computed(() =>
  mainWorktree.value ? workspaceIdsByPath.value.get(String(mainWorktree.value.path || "").toLowerCase()) || "" : "",
);

const dirtyFiles = computed(() =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [...(props.snapshot.staged || []), ...(props.snapshot.unstaged || [])].map((e: any) => e.path),
);
const baseChangedFiles = computed(() => new Set(compare.value.baseChangedFiles || []));
const dirtyConflicts = computed(() =>
  baseChangedFiles.value.size > 0 ? dirtyFiles.value.filter((p) => baseChangedFiles.value.has(p)) : [],
);
</script>
