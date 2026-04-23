<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="headerTitle"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!snapshot?.available" class="terminal-empty">
      <p>Git workspace is unavailable</p>
      <small>This workspace is not inside a Git repository.</small>
    </div>
    <div v-else class="git-view">
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <!-- Branch chip — detached HEAD gets special styling -->
          <span :class="['workspace-chip', isDetachedHead && 'workspace-chip--warn']">
            <strong>{{ isDetachedHead ? `detached HEAD @ ${snapshot.branch}` : snapshot.branch }}</strong>
            <template v-if="!isDetachedHead"> branch</template>
          </span>
          <span :class="['workspace-chip', isLinkedWorktree && 'workspace-chip--alert']">
            <strong>{{ snapshot.isMainWorktree ? "main" : "linked" }}</strong> worktree
          </span>
          <!-- ahead/behind only when upstream exists -->
          <template v-if="snapshot.upstream">
            <span v-if="snapshot.aheadCount > 0" class="workspace-chip">
              <strong>{{ snapshot.aheadCount }}</strong> ahead
            </span>
            <span v-if="snapshot.behindCount > 0" class="workspace-chip">
              <strong>{{ snapshot.behindCount }}</strong> behind
            </span>
          </template>
          <!-- no-upstream / no-remote contextual chips -->
          <span
            v-if="!snapshot.upstream && remoteCount > 0 && !showAllActions"
            class="workspace-chip workspace-chip--muted"
          >
            no upstream
          </span>
          <span v-if="remoteCount === 0 && !showAllActions" class="workspace-chip workspace-chip--muted">
            no remote
          </span>
          <!-- dirty badge only when actually dirty -->
          <span v-if="snapshot.dirty" class="workspace-chip">
            <strong>{{ snapshot.dirtyCount }}</strong> dirty
          </span>
          <span v-if="operation.inProgress" class="workspace-chip workspace-chip--alert">
            <strong>{{ operation.kind }}</strong> in progress
          </span>
        </div>
        <div class="git-view__actions">
          <!-- Repo picker (multi-root workspaces only) — inline with actions, compact -->
          <label v-if="showRepoPicker" class="git-repo-picker">
            <span class="git-repo-picker__label">Repo</span>
            <CustomSelect
              class="git-repo-picker__select"
              :model-value="activeRootPath"
              :options="repoPickerOptions"
              @change="onRootChange"
            />
            <span class="git-repo-picker__hint">{{ gitRoots.length }}</span>
          </label>
          <!-- Refresh: always visible, never primary -->
          <button
            type="button"
            data-testid="refresh-button"
            :class="['button', 'button--ghost', gitUi.busyAction === 'refresh' && 'button--busy']"
            :disabled="!!gitUi.busyAction"
            title="Re-read git status from disk"
            @click="gitUiStore.refreshGit(workspaceId)"
          >
            {{ gitUi.busyAction === "refresh" ? "Refreshing…" : "Refresh" }}
          </button>

          <!-- Fetch: hidden when no remotes (UC-8), never primary -->
          <button
            v-if="showFetch"
            type="button"
            data-testid="fetch-button"
            :class="['button', 'button--ghost', gitUi.busyAction === 'fetch' && 'button--busy']"
            :disabled="!!gitUi.busyAction || !!gitUi.pendingAction || operation.inProgress"
            title="Download remote refs without changing your working tree"
            @click="gitUiStore.gitFetch(workspaceId)"
          >
            {{ gitUi.busyAction === "fetch" ? "Fetching…" : "Fetch" }}
          </button>

          <!-- Pull: hidden when no upstream (UC-1, UC-9) unless showAllActions -->
          <button
            v-if="showPull"
            type="button"
            data-testid="pull-button"
            :class="['button', pullIsPrimary ? '' : 'button--ghost', gitUi.busyAction === 'pull' && 'button--busy']"
            :disabled="pullDisabled"
            :title="pullTooltip"
            @click="gitUiStore.gitPull(workspaceId)"
          >
            {{ gitUi.busyAction === "pull" ? "Pulling…" : "Pull" }}
          </button>

          <!-- Push: hidden when detached/review/no-remotes (structural impossibility) -->
          <button
            v-if="showPush"
            type="button"
            data-testid="push-button"
            :class="['button', pushIsPrimary ? '' : 'button--ghost', gitUi.busyAction === 'push' && 'button--busy']"
            :disabled="pushDisabled"
            :title="pushTooltip"
            @click="gitUiStore.gitPush(workspaceId)"
          >
            {{ gitUi.busyAction === "push" ? "Pushing…" : pushLabel }}
          </button>

          <!-- New worktree: hidden when commitCount === 0 (UC-7) unless showAllActions -->
          <button
            v-if="showNewWorktree"
            type="button"
            data-testid="new-worktree-button"
            class="button button--ghost"
            :disabled="!!gitUi.busyAction || !!gitUi.pendingAction || operation.inProgress"
            title="Create a new git worktree with its own branch"
            @click="onCreateWorktree"
          >
            New worktree
          </button>

          <!-- Open Lazygit: never primary -->
          <button
            v-if="snapshot.lazygit?.available"
            type="button"
            data-testid="lazygit-button"
            class="button button--ghost"
            style="white-space: nowrap"
            @click="gitUiStore.openLazygit(workspaceId)"
          >
            Open Lazygit
          </button>
          <button
            v-else
            type="button"
            class="button button--ghost"
            disabled
            style="white-space: nowrap; border: 1px dashed var(--accent); color: var(--accent); opacity: 0.9"
            title="Install lazygit to enable"
          >
            Install Lazygit
          </button>

          <CustomSelect
            v-if="availableConnections.length && !isReviewWorkspace"
            class="git-branch-select"
            :model-value="activeConnectionId"
            :options="connectionOptions"
            @change="onConnectionChange"
          />
        </div>
      </div>

      <!-- Tab nav -->
      <nav class="git-tabs" role="tablist" aria-label="Git sections">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="tab.id === activeTab ? 'true' : 'false'"
          :class="['git-tabs__item', tab.id === activeTab && 'git-tabs__item--active']"
          @click="gitUiStore.gitSwitchTab(workspaceId, tab.id)"
        >
          {{ tab.label }}<span v-if="tab.badge" class="git-tabs__badge">{{ tab.badge }}</span>
        </button>
      </nav>

      <section
        role="tabpanel"
        :class="['git-view__panel', isSwitchingRepo && 'git-view__panel--busy']"
        style="min-height: 0; overflow: auto; display: grid"
      >
        <div v-if="isSwitchingRepo" class="git-view__overlay" aria-hidden="true">
          <div class="git-view__spinner"></div>
        </div>
        <!-- ===== Branch tab ===== -->
        <template v-if="activeTab === 'branch'">
          <div class="git-section">
            <!-- UC-7: empty repo banner -->
            <div v-if="isEmptyRepo" data-testid="empty-repo-banner" class="git-info-banner git-info-banner--warn">
              <strong>No commits yet</strong>
              <p>Make your first commit in the Changes tab to get started.</p>
            </div>

            <!-- UC-8: no remote banner -->
            <div v-if="hasNoRemote && !showAllActions" data-testid="no-remote-banner" class="git-info-banner">
              <strong>No remote configured</strong>
              <p>This repo has no remote. Add a remote to enable fetch/pull/push.</p>
            </div>

            <!-- UC-3: diverged banner -->
            <div v-if="isDiverged" data-testid="diverged-banner" class="git-diverged-banner">
              <strong
                >Upstream has diverged ({{ snapshot.aheadCount }} ahead, {{ snapshot.behindCount }} behind)</strong
              >
              <p>Pull or rebase if upstream has new work, or force-push if you intentionally rewrote local history.</p>
              <div class="git-diverged-banner__actions">
                <button
                  type="button"
                  class="button button--ghost"
                  :disabled="!!gitUi.busyAction || operation.inProgress"
                  title="Open Update Current Branch to pull/rebase"
                  @click="gitUiStore.gitSwitchTab(workspaceId, 'branch')"
                >
                  Pull / Rebase
                </button>
                <button
                  v-if="!isReviewWorkspace"
                  type="button"
                  data-testid="force-push-button"
                  class="button button--ghost button--danger"
                  :disabled="!!gitUi.busyAction || operation.inProgress || !!gitUi.pendingAction"
                  title="Force-push with lease — aborts if remote was updated since your last fetch"
                  @click="
                    gitUiStore.confirmForcePushWithLease(
                      workspaceId,
                      {
                        branch: snapshot.branch,
                        remote: pushRemote,
                        behindCount: snapshot.behindCount,
                      },
                      snapshot,
                    )
                  "
                >
                  Force push (with lease)
                </button>
              </div>
            </div>

            <GitOperationCard :snapshot="snapshot" :workspace-id="workspaceId" :git-ui="gitUi" />

            <!-- UC-6: detached HEAD banner in Changes tab is handled there; here just info -->

            <!-- Update current branch — hidden when current === base -->
            <article v-if="showUpdateCurrentBranch" class="git-card" data-testid="update-current-branch-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Update Current Branch</p>
                  <h3>{{ effectiveBaseBranch || "?" }} &rarr; {{ snapshot.branch }}</h3>
                </div>
              </div>
              <div class="git-detail-list">
                <span><strong>Current branch:</strong> {{ snapshot.branch }}</span>
                <template v-if="isLinkedWorktree">
                  <span class="git-detail-list__row">
                    <strong>Base branch:</strong>
                    {{ effectiveBaseBranch || "?" }}
                  </span>
                </template>
                <GitBaseBranchPicker
                  v-else
                  :model-value="effectiveBaseBranch"
                  :options="baseBranchOptions"
                  @update:model-value="(v) => gitUiStore.gitSetBaseBranch(workspaceId, v)"
                />
                <span><strong>Upstream:</strong> {{ snapshot.upstream || "none" }}</span>
                <span
                  ><strong>Ahead/behind upstream:</strong> {{ snapshot.aheadCount || 0 }} /
                  {{ snapshot.behindCount || 0 }}</span
                >
                <span><strong>Last fetch:</strong> {{ formatDateLabel(snapshot.lastFetchAt) }}</span>
              </div>
              <template v-if="effectiveBaseBranch">
                <div v-if="!isReviewWorkspace" class="git-operation-actions">
                  <button
                    type="button"
                    class="button"
                    :disabled="!!(gitUi.busyAction || operation.inProgress || !!gitUi.pendingAction)"
                    :title="`Rebase current branch onto local ${effectiveBaseBranch}`"
                    @click="gitUiStore.gitRebaseBase(workspaceId, effectiveBaseBranch)"
                  >
                    {{ gitUi.busyAction === "rebase" ? "Rebasing…" : `Rebase onto ${effectiveBaseBranch}` }}
                  </button>
                  <button
                    v-if="!isReviewWorkspace"
                    type="button"
                    class="button button--ghost"
                    :disabled="!!(gitUi.busyAction || operation.inProgress || !!gitUi.pendingAction)"
                    :title="`Merge local ${effectiveBaseBranch} into current branch`"
                    @click="gitUiStore.gitMergeBase(workspaceId, effectiveBaseBranch)"
                  >
                    {{ gitUi.busyAction === "merge" ? "Merging…" : `Merge ${effectiveBaseBranch} in` }}
                  </button>
                </div>
                <p class="git-card__hint">
                  Operations use the local {{ effectiveBaseBranch }} branch. Fetch first to sync with remote.
                </p>
              </template>
              <template v-else>
                <p class="git-card__hint">Select a base branch above to enable rebase/merge operations.</p>
                <p v-if="baseBranchOptions.length === 0" class="git-card__hint">
                  No local branches found. Run Fetch to populate remote branches.
                  <button
                    type="button"
                    class="button button--ghost button--small"
                    style="margin-left: 6px"
                    @click="gitUiStore.gitFetch(workspaceId)"
                  >
                    Fetch
                  </button>
                </p>
              </template>
            </article>

            <!-- Stash card — hidden when clean and 0 stashes -->
            <article v-if="showStashCard" data-testid="stash-card" class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Stash</p>
                  <h3>{{ snapshot.stashCount || 0 }} stash{{ (snapshot.stashCount || 0) !== 1 ? "es" : "" }}</h3>
                </div>
              </div>
              <div class="git-operation-actions">
                <button
                  type="button"
                  class="button"
                  :disabled="!!(gitUi.busyAction || !snapshot.dirty || !!gitUi.pendingAction || operation.inProgress)"
                  title="Save uncommitted changes to the stash"
                  @click="gitUiStore.gitStash(workspaceId)"
                >
                  {{ gitUi.busyAction === "stash" ? "Stashing…" : "Stash" }}
                </button>
                <button
                  type="button"
                  class="button button--ghost"
                  :disabled="
                    !!(gitUi.busyAction || !(snapshot.stashCount > 0) || !!gitUi.pendingAction || operation.inProgress)
                  "
                  :title="
                    snapshot.dirty ? 'Pop may conflict with local changes' : 'Restore the most recent stash entry'
                  "
                  @click="gitUiStore.gitStashPop(workspaceId)"
                >
                  {{ gitUi.busyAction === "stash-pop" ? "Popping…" : "Unstash (pop)" }}
                </button>
              </div>
              <p class="git-card__hint">
                Stash saves uncommitted changes. Unstash restores the most recent stash entry.
              </p>
            </article>

            <!-- Switch / Create branch (main worktree only) -->
            <article v-if="!isLinkedWorktree && !isReviewWorkspace" class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Switch Branch</p>
                  <h3>{{ snapshot.branch }}</h3>
                </div>
              </div>
              <div v-if="snapshot.dirty" class="git-card__hint git-card__hint--warning" style="margin-bottom: 8px">
                Working tree is dirty. Commit or stash changes before switching branches.
              </div>
              <template v-else>
                <div class="git-detail-list" style="margin-bottom: 8px">
                  <span class="git-detail-list__row">
                    <strong>Checkout:</strong>
                    <CustomSelect
                      v-model="switchBranchTarget"
                      class="git-branch-select"
                      placeholder="-- select branch --"
                      :options="switchBranchOptionsList"
                    />
                    <button
                      type="button"
                      class="button"
                      :disabled="!switchBranchTarget || !!gitUi.busyAction"
                      title="Checkout the selected branch"
                      style="margin-left: 6px"
                      @click="onCheckoutBranch"
                    >
                      {{ gitUi.busyAction === "checkout" ? "Switching…" : "Switch" }}
                    </button>
                  </span>
                </div>
                <div class="git-detail-list">
                  <span class="git-detail-list__row">
                    <strong>New branch:</strong>
                    <input
                      v-model="newBranchName"
                      class="git-pr-form__input"
                      type="text"
                      placeholder="feature/my-branch"
                      style="flex: 1; min-width: 120px"
                    />
                    <button
                      type="button"
                      class="button button--ghost"
                      :disabled="!newBranchName.trim() || !!gitUi.busyAction"
                      title="Create a new branch from the current one and switch to it"
                      style="margin-left: 6px"
                      @click="onCreateBranch"
                    >
                      {{ gitUi.busyAction === "create-branch" ? "Creating…" : "Create & switch" }}
                    </button>
                  </span>
                </div>
              </template>
            </article>

            <GitMergeBackCard
              v-if="showMergeBack"
              :snapshot="snapshot"
              :workspace-id="workspaceId"
              :workspaces="workspaces"
              :git-ui="gitUi"
              :effective-base-branch="effectiveBaseBranch"
              :base-branch-options="baseBranchOptions"
              :is-linked-worktree="isLinkedWorktree"
            />
          </div>
        </template>

        <!-- ===== Changes tab ===== -->
        <template v-else-if="activeTab === 'changes'">
          <div class="git-section git-section--changes">
            <div class="git-section__files">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Changes</p>
                    <h3>{{ snapshot.dirty ? "Working tree overview" : "No local changes" }}</h3>
                  </div>
                </div>
                <!-- UC-6: detached HEAD banner -->
                <div v-if="isDetachedHead" class="git-info-banner git-info-banner--warn" style="margin-bottom: 8px">
                  <strong>Detached HEAD</strong>
                  <p>You are on a detached HEAD. Commits will be lost unless you create a branch.</p>
                  <button
                    v-if="!isReviewWorkspace"
                    type="button"
                    class="button button--ghost button--small"
                    @click="gitUiStore.gitCreateBranch(workspaceId, `branch-from-detached`)"
                  >
                    Create branch from HEAD
                  </button>
                </div>
                <GitDiffStat :stat="snapshot.diffStat" />
                <GitChangeList
                  title="Staged"
                  scope="staged"
                  :files="snapshot.staged || []"
                  :selected-diff="gitUi.selectedDiff"
                  :workspace-id="workspaceId"
                  @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
                  @open-editor="onOpenInEditor"
                />
                <GitChangeList
                  title="Unstaged"
                  scope="unstaged"
                  :files="unstagedWithConflicts"
                  :selected-diff="gitUi.selectedDiff"
                  :workspace-id="workspaceId"
                  @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
                  @open-editor="onOpenInEditor"
                />
                <GitChangeList
                  title="Untracked"
                  scope="untracked"
                  :files="snapshot.untracked || []"
                  :selected-diff="gitUi.selectedDiff"
                  :workspace-id="workspaceId"
                  @select="(p, s) => gitUiStore.gitSelectDiff(workspaceId, p, s)"
                  @open-editor="onOpenInEditor"
                />
                <div v-if="snapshot.dirty && !isReviewWorkspace" class="git-commit-form" style="margin-top: 12px">
                  <input
                    v-model="commitMessage"
                    name="commit-message"
                    type="text"
                    placeholder="Commit message"
                    :disabled="operation.inProgress"
                    :title="!snapshot.staged?.length && snapshot.dirty ? 'Will stage and commit all changes' : ''"
                    @keydown.enter="onCommitAll"
                  />
                  <button
                    type="button"
                    class="button"
                    :disabled="
                      !!gitUi.busyAction || !commitMessage.trim() || operation.inProgress || !!gitUi.pendingAction
                    "
                    title="Stage all changes and commit"
                    @click="onCommitAll"
                  >
                    {{ gitUi.busyAction === "commit" ? "Committing\u2026" : "Commit all" }}
                  </button>
                </div>
              </article>
            </div>
            <div class="git-section__preview">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Diff Preview</p>
                    <h3>{{ gitUi.diffPreview?.path || "Select a file" }}</h3>
                  </div>
                </div>
                <template v-if="gitUi.diffPreview">
                  <p v-if="gitUi.diffPreview.summary" class="git-card__hint">{{ gitUi.diffPreview.summary }}</p>
                  <DiffViewer :diff="gitUi.diffPreview.diff || ''" />
                </template>
                <p v-else class="git-card__hint">Click a file to load a diff preview.</p>
              </article>
            </div>
          </div>
        </template>

        <!-- ===== History tab ===== -->
        <template v-else-if="activeTab === 'history'">
          <div class="git-section git-section--history">
            <div class="git-history__header">
              <article class="git-card">
                <div class="section-head">
                  <div>
                    <p class="eyebrow">Compare With Base</p>
                    <h3>{{ effectiveBaseBranch || "No base branch" }}</h3>
                  </div>
                </div>
                <!-- CTA when no base branch is selected (was just "No base branch" text before) -->
                <template v-if="!effectiveBaseBranch">
                  <p class="git-card__hint">Select a base branch to see which commits are unique to this branch.</p>
                  <div class="git-detail-list" style="margin-top: 8px">
                    <GitBaseBranchPicker
                      :model-value="effectiveBaseBranch"
                      :options="baseBranchOptions"
                      @update:model-value="(v) => gitUiStore.gitSetBaseBranch(workspaceId, v)"
                    />
                  </div>
                </template>
                <template v-else>
                  <GitDiffStat :stat="compare.diffStat" />
                  <div class="git-detail-list">
                    <span><strong>Branch commits:</strong> {{ compare.aheadCount || 0 }}</span>
                    <span><strong>Missing from base:</strong> {{ compare.behindCount || 0 }}</span>
                  </div>
                </template>
              </article>
            </div>
            <div class="git-history__panels">
              <div class="git-history__log">
                <GitCommitLog
                  :commits="allCommits"
                  :selected-commit="gitUi.selectedCommit"
                  :ahead-count="snapshot.aheadCount || 0"
                  @select="(hash) => gitUiStore.gitSelectCommit(workspaceId, hash)"
                />
              </div>
              <div class="git-history__detail">
                <template v-if="gitUi.commitDiffPreview">
                  <p v-if="gitUi.commitDiffPreview.summary" class="git-card__hint">
                    {{ gitUi.commitDiffPreview.summary }}
                  </p>
                  <DiffViewer :diff="gitUi.commitDiffPreview.diff || ''" />
                </template>
                <p v-else class="git-card__hint">Select a commit to view its diff.</p>
              </div>
            </div>
          </div>
        </template>

        <!-- ===== Pull Request tab ===== -->
        <template v-else-if="activeTab === 'pr'">
          <div class="git-section" data-testid="pr-tab-panel">
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Create Pull Request</p>
                  <h3>{{ snapshot.branch }} &rarr; {{ prTargetBranch || "?" }}</h3>
                </div>
              </div>
              <!-- UC-8: no remote -->
              <div v-if="hasNoRemote" class="git-card__hint git-card__hint--warning" style="margin-bottom: 8px">
                This repo has no remote. Add a remote before connecting a PR provider.
              </div>
              <!-- No connection selected -->
              <div
                v-else-if="!activeConnectionId && !hasAzureConnection"
                class="git-card__hint git-card__hint--warning"
                style="margin-bottom: 8px"
              >
                Connect Azure DevOps or GitHub to create pull requests. Use the credentials dropdown in the toolbar.
              </div>
              <template v-else>
                <p class="git-card__hint" style="margin-bottom: 8px">
                  Using connection: <strong>{{ activeConnectionLabel }}</strong>
                </p>
                <div class="git-pr-form">
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Source branch</span>
                    <input class="git-pr-form__input" type="text" :value="snapshot.branch" disabled />
                  </label>
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Target branch</span>
                    <CustomSelect
                      v-model="prTargetBranch"
                      class="git-branch-select"
                      placeholder="-- select target --"
                      :options="prTargetOptionsList"
                    />
                    <button
                      v-if="!gitUi.remoteBranchesLoading"
                      type="button"
                      class="button button--ghost button--small"
                      style="margin-left: 6px"
                      @click="gitUiStore.azureListRemoteBranches(workspaceId)"
                    >
                      Load remote branches
                    </button>
                    <span v-else style="font-size: 12px; color: var(--muted); margin-left: 6px">Loading...</span>
                  </label>
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Title</span>
                    <input v-model="prTitle" class="git-pr-form__input" type="text" placeholder="Pull request title" />
                  </label>
                  <label class="git-pr-form__field">
                    <span class="git-pr-form__label">Description</span>
                    <textarea
                      v-model="prDescription"
                      class="git-pr-form__input git-pr-form__textarea"
                      placeholder="Optional description"
                      rows="4"
                    ></textarea>
                  </label>
                  <div class="git-operation-actions">
                    <button
                      type="button"
                      class="button"
                      :disabled="
                        !prCanSubmit ||
                        !!gitUi.busyAction ||
                        snapshot.aheadCount === 0 ||
                        !snapshot.upstream ||
                        snapshot.dirty
                      "
                      :title="
                        !snapshot.upstream
                          ? 'Publish the branch first before creating a PR'
                          : snapshot.dirty
                            ? 'Commit or stash changes before creating a PR'
                            : snapshot.aheadCount === 0
                              ? 'Nothing to PR — no commits ahead of upstream'
                              : ''
                      "
                      @click="onCreatePr"
                    >
                      {{ gitUi.busyAction === "create-pr" ? "Creating…" : "Create Pull Request" }}
                    </button>
                  </div>
                  <p v-if="prResult" :class="['git-card__hint', prResult.ok ? '' : 'git-card__hint--warning']">
                    {{ prResult.summary || (prResult.ok ? "Pull request created." : "Failed to create pull request.") }}
                    <a
                      v-if="prResult.url"
                      :href="prResult.url"
                      style="color: var(--accent); text-decoration: underline"
                      @click.prevent="openExternal(prResult.url)"
                      >Open in browser</a
                    >
                  </p>
                </div>
              </template>
            </article>
          </div>
        </template>

        <!-- ===== Tags tab ===== -->
        <template v-else-if="activeTab === 'tags'">
          <div class="git-section">
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Tags</p>
                  <h3>{{ snapshot.branch }} &mdash; {{ (gitUi.tags || []).length }} tag(s)</h3>
                </div>
              </div>
              <GitTagList
                :workspace-id="workspaceId"
                :git-ui="gitUi"
                :snapshot="snapshot"
                :is-review-workspace="isReviewWorkspace"
              />
            </article>
          </div>
        </template>

        <!-- ===== Worktrees tab ===== -->
        <template v-else-if="activeTab === 'worktrees'">
          <div class="git-section">
            <article class="git-card">
              <div class="section-head">
                <div>
                  <p class="eyebrow">Worktree Context</p>
                  <h3>{{ snapshot.repository || snapshot.root }}</h3>
                </div>
              </div>
              <p class="git-card__path">{{ snapshot.root }}</p>
              <div class="git-detail-list">
                <span><strong>Current branch:</strong> {{ snapshot.branch }}</span>
                <span><strong>Main worktree:</strong> {{ snapshot.mainWorktreePath || snapshot.root }}</span>
                <span><strong>Current path:</strong> {{ snapshot.worktreePath || snapshot.root }}</span>
              </div>
              <GitWorktreeList
                :snapshot="snapshot"
                :workspaces="workspaces"
                :workspace-id="workspaceId"
                :git-ui="gitUi"
                :push-remote="pushRemote"
                :is-review-workspace="isReviewWorkspace"
              />
            </article>
          </div>
        </template>

        <!-- ===== Bulk tab (multi-repo only) ===== -->
        <template v-else-if="activeTab === 'bulk'">
          <BulkRepoTable
            :roots-snapshots="allRootsSnapshots"
            :workspace-id="props.workspaceId"
            :on-fetch-all="() => gitUiStore.bulkFetch(props.workspaceId)"
            :on-pull-all="() => gitUiStore.bulkPull(props.workspaceId)"
            :on-refresh-root="(rootPath) => gitUiStore.refreshRoot(props.workspaceId, rootPath)"
            :on-pull-root="(rootPath) => gitUiStore.pullRoot(props.workspaceId, rootPath)"
            :on-reveal-root="(rootPath) => gitUiStore.revealRoot(props.workspaceId, rootPath)"
          />
        </template>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import PaneShell from "../layout/PaneShell.vue";
import DiffViewer from "./DiffViewer.vue";
import GitDiffStat from "./git/GitDiffStat.vue";
import GitChangeList from "./git/GitChangeList.vue";
import GitOperationCard from "./git/GitOperationCard.vue";
import GitMergeBackCard from "./git/GitMergeBackCard.vue";
import GitWorktreeList from "./git/GitWorktreeList.vue";
import GitTagList from "./git/GitTagList.vue";
import GitCommitLog from "./git/GitCommitLog.vue";
import GitBaseBranchPicker from "./git/GitBaseBranchPicker.vue";
import BulkRepoTable from "./git/BulkRepoTable.vue";
import CustomSelect from "../common/CustomSelect.vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
  showHeader: { type: Boolean, default: false },
});

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const snapshot = computed(() => appStore.getActiveGitSnapshot(props.workspaceId));
const gitUi = computed(() => gitUiStore.get(props.workspaceId));
const workspaces = computed(() => appStore.filteredWorkspaces);

const workspace = computed(() => (appStore.filteredWorkspaces || []).find((ws) => ws.id === props.workspaceId));
const isReviewWorkspace = computed(() => !!workspace.value?.review?.prKey);

// Multi-repo computed values
const gitRoots = computed(() => workspace.value?.gitRoots || []);
const isMultiRepo = computed(() => gitRoots.value.length >= 2);
const showRepoPicker = computed(() => isMultiRepo.value && !isReviewWorkspace.value);
const activeRootPath = computed(() => gitUiStore.getActiveRoot(props.workspaceId) || snapshot.value?.rootPath || "");
const allRootsSnapshots = computed(() => {
  const entry = appStore.payload?.git?.workspaces?.[props.workspaceId];
  if (!entry?.roots) return [];
  return Object.entries(entry.roots).map(([rootPath, snap]) => ({ rootPath, ...snap }));
});
const isLinkedWorktree = computed(() => snapshot.value?.isWorktree && !snapshot.value?.isMainWorktree);
const operation = computed(() => snapshot.value?.operationState || {});
const baseBranch = computed(() => snapshot.value?.baseBranch || snapshot.value?.compareWithBase?.baseBranch || "");
const compare = computed(() => snapshot.value?.compareWithBase || {});
const activeTab = computed(() => gitUi.value.activeTab || "branch");
const showAllActions = computed(() => appStore.payload?.appState?.settings?.git?.ui?.showAllActions === true);

// Effective base branch: override from UI, or auto-detected
const effectiveBaseBranch = computed(() => gitUi.value.overrideBaseBranch || baseBranch.value);

// Remote / upstream state
const remoteCount = computed(() => Object.keys(snapshot.value?.remotes || {}).filter((k) => !k.includes(":")).length);
const hasNoRemote = computed(() => remoteCount.value === 0);
const isDetachedHead = computed(() => snapshot.value?.branch === "HEAD" || !snapshot.value?.branch);
const isEmptyRepo = computed(() => (snapshot.value?.commitCount || 0) === 0);
const isDiverged = computed(() => {
  const s = snapshot.value;
  return s && s.aheadCount > 0 && s.behindCount > 0 && s.upstream;
});

// Push button state — detect remote name from upstream or remotes list
const pushRemote = computed(() => {
  const s = snapshot.value;
  if (!s) return "origin";
  const remoteNames = Object.keys(s.remotes || {}).filter((k) => !k.includes(":"));
  if (s.upstream) {
    return remoteNames.find((r) => s.upstream.startsWith(`${r}/`)) || remoteNames[0] || "origin";
  }
  return remoteNames[0] || "origin";
});
const upstreamMatchesBranch = computed(() => {
  const s = snapshot.value;
  return s?.upstream === `${pushRemote.value}/${s?.branch}`;
});
const canPush = computed(() => {
  const s = snapshot.value;
  if (!s) return false;
  return s.aheadCount > 0 || !s.upstream || !upstreamMatchesBranch.value;
});

// UC-17: primary button arbitration — at most 1 primary in toolbar
const primaryAction = computed(() => {
  if (showAllActions.value) {
    // legacy: all primary-qualified get primary
    const s = snapshot.value;
    if (!s) return null;
    if (s.behindCount > 0 && !isDiverged.value) return "pull";
    if (s.aheadCount > 0 && s.upstream) return "push";
    return null;
  }
  if (operation.value.inProgress) return null;
  if (gitUi.value.pendingAction) return null;
  if (isDiverged.value) return null;
  if (isDetachedHead.value) return null;
  const s = snapshot.value;
  if (!s) return null;
  if (s.behindCount > 0) return "pull";
  if (s.aheadCount > 0 && s.upstream) return "push";
  return null;
});

// Visibility rules for toolbar buttons
const showFetch = computed(() => showAllActions.value || remoteCount.value > 0);
const showPull = computed(() => {
  if (showAllActions.value) return true;
  return !!snapshot.value?.upstream;
});
const showPush = computed(() => {
  if (isDetachedHead.value) return false; // structural
  if (isReviewWorkspace.value) return false; // structural
  if (hasNoRemote.value) return false; // structural
  return true;
});
const showNewWorktree = computed(() => {
  if (isReviewWorkspace.value) return false;
  return showAllActions.value || (snapshot.value?.commitCount || 0) > 0;
});

// Pull state
const pullIsPrimary = computed(() => primaryAction.value === "pull");
const pullDisabled = computed(() => {
  if (!!gitUi.value.busyAction || operation.value.inProgress || !!gitUi.value.pendingAction) return true;
  if (!snapshot.value?.upstream) return true;
  if (snapshot.value?.dirty) return true;
  if (isDetachedHead.value) return true;
  if ((snapshot.value?.behindCount || 0) === 0 && !isDiverged.value) return true;
  return false;
});
const pullTooltip = computed(() => {
  const s = snapshot.value;
  if (!s?.upstream) return "No upstream tracking branch";
  if (s.dirty) return "Commit or stash changes before pulling";
  if (isDetachedHead.value) return "Cannot pull in detached HEAD state";
  if (s.behindCount > 0) return `Pull ${s.behindCount} commit${s.behindCount !== 1 ? "s" : ""} from ${s.upstream}`;
  return "Nothing to pull";
});

// Push state
const pushLabel = computed(() => {
  const s = snapshot.value;
  if (!s) return "Push";
  if (!s.upstream || !upstreamMatchesBranch.value) return "Publish branch";
  return "Push";
});
const pushIsPrimary = computed(() => primaryAction.value === "push");
const pushDisabled = computed(() => {
  if (!!gitUi.value.busyAction || operation.value.inProgress || !!gitUi.value.pendingAction) return true;
  if (isDiverged.value && !showAllActions.value) return true;
  if (!canPush.value) return true;
  return false;
});
const pushTooltip = computed(() => {
  const s = snapshot.value;
  if (!s) return "Push";
  if (isDiverged.value && !showAllActions.value)
    return "Push may be rejected — branch diverged from upstream. Use Force push (with lease) in the banner above if you rewrote history intentionally.";
  const target = `${pushRemote.value}/${s.branch}`;
  if (!s.upstream || !upstreamMatchesBranch.value) {
    return `Push ${s.branch} and set upstream to ${target}`;
  }
  if (s.aheadCount > 0) return `Push ${s.aheadCount} commit${s.aheadCount !== 1 ? "s" : ""} to ${target}`;
  return "Nothing to push";
});

// Card visibility
const showStashCard = computed(() => {
  if (isReviewWorkspace.value) return false;
  return showAllActions.value || snapshot.value?.dirty || (snapshot.value?.stashCount || 0) > 0;
});
const showUpdateCurrentBranch = computed(() => {
  if (!snapshot.value) return false;
  if (!showAllActions.value && effectiveBaseBranch.value === snapshot.value.branch) return false;
  return true;
});
const showMergeBack = computed(() => {
  if (isReviewWorkspace.value) return false;
  if (!showAllActions.value) {
    if (!isLinkedWorktree.value) return false;
    if (!effectiveBaseBranch.value) return false;
    if (effectiveBaseBranch.value === snapshot.value?.branch) return false;
  }
  return true;
});

// Commit form (Changes tab)
const commitMessage = ref("");
function onCommitAll() {
  const msg = commitMessage.value.trim();
  if (!msg) return;
  gitUiStore.gitCommitAll(props.workspaceId, msg);
  commitMessage.value = "";
}

// Multi-repo root picker
const isSwitchingRepo = ref(false);
async function onRootChange(newRoot) {
  if (newRoot === activeRootPath.value) return;
  isSwitchingRepo.value = true;
  gitUiStore.setActiveRoot(props.workspaceId, newRoot);
  try {
    await gitUiStore.refreshGit(props.workspaceId);
  } finally {
    // Min 180ms visibility so the user sees the transition even on cache-warm switches
    await new Promise((resolve) => setTimeout(resolve, 180));
    isSwitchingRepo.value = false;
  }
}

function formatRootLabel(rootPath) {
  if (!rootPath) return "";
  const basename = rootPath.split(/[\\/]/).filter(Boolean).at(-1) || rootPath;
  // collision check: if two roots share the same basename, show parent/basename
  const others = gitRoots.value.filter((r) => r !== rootPath);
  const collision = others.some((r) => (r.split(/[\\/]/).filter(Boolean).at(-1) || r) === basename);
  if (collision) {
    const parts = rootPath.split(/[\\/]/).filter(Boolean);
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : basename;
  }
  return basename;
}

// Branch options for combo box
const baseBranchOptions = computed(() => {
  const names = snapshot.value?.branchNames || [];
  const current = snapshot.value?.branch || "";
  const filtered = names.filter((n) => n !== current);
  // Put the detected base branch first if present
  const detected = baseBranch.value;
  if (detected && !filtered.includes(detected)) {
    filtered.unshift(detected);
  } else if (detected) {
    const idx = filtered.indexOf(detected);
    if (idx > 0) {
      filtered.splice(idx, 1);
      filtered.unshift(detected);
    }
  }
  return filtered;
});

// Azure DevOps connection detection
const azureSnapshot = computed(() => appStore.payload?.azureDevops || {});
const hasAzureConnection = computed(() => {
  const remoteUrl = (snapshot.value?.remotes?.origin || "")
    .toLowerCase()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!remoteUrl) return false;
  const connections = azureSnapshot.value.connections || [];
  return connections.some(
    (c) => c.enabled && remoteUrl.startsWith(c.orgUrl?.toLowerCase().replace(/\/+$/, "") || "---"),
  );
});

// Connection selection for authenticated git operations (push/fetch/PR).
const availableConnections = computed(() => (appStore.payload?.git?.connections || []).filter((c) => c.enabled));
const activeConnectionId = computed(() => workspace.value?.connectionId || "");
const activeConnectionLabel = computed(() => {
  if (!activeConnectionId.value) return "auto-detected";
  const found = availableConnections.value.find((c) => c.id === activeConnectionId.value);
  return found?.label || activeConnectionId.value;
});

// Branch switch/create state
const switchBranchTarget = ref("");
const newBranchName = ref("");
const switchBranchOptions = computed(() => {
  const names = snapshot.value?.branchNames || [];
  const current = snapshot.value?.branch || "";
  return names.filter((n) => n !== current);
});

// PR form state
const prTitle = ref("");
const prDescription = ref("");
const prTargetBranch = ref("");
const prResult = ref(null);

// PR target branch options: local branch names + remote branches loaded from Azure
const prTargetOptions = computed(() => {
  const localBranches = (snapshot.value?.branchNames || []).filter(
    (n) => !n.startsWith("origin/") && n !== snapshot.value?.branch,
  );
  const remoteBranches = (gitUi.value.remoteBranches || []).filter((n) => n !== snapshot.value?.branch);
  const merged = [...new Set([...localBranches, ...remoteBranches])];
  // Put common targets first
  const priority = ["develop", "main", "master"];
  merged.sort((a, b) => {
    const aIdx = priority.indexOf(a);
    const bIdx = priority.indexOf(b);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return a.localeCompare(b);
  });
  return merged;
});

const prCanSubmit = computed(() => prTitle.value.trim() && prTargetBranch.value);

// Initialize PR target from base branch
watch(
  baseBranch,
  (val) => {
    if (!prTargetBranch.value && val) {
      const stripped = val.replace(/^origin\//, "");
      prTargetBranch.value = stripped;
    }
  },
  { immediate: true },
);

// UC-12: auto-dismiss stale pending confirm when snapshot state changes
watch(snapshot, (newSnapshot) => {
  if (newSnapshot && gitUi.value.pendingAction) {
    gitUiStore.dismissStalePending(props.workspaceId, newSnapshot);
  }
});

const tabs = computed(() => {
  const list = [
    { id: "branch", label: "Branch", badge: operation.value.inProgress ? "!" : "" },
    {
      id: "changes",
      label: "Changes",
      badge: (snapshot.value?.dirtyCount || 0) > 0 ? String(snapshot.value.dirtyCount) : "",
    },
    { id: "history", label: "History", badge: "" },
    { id: "pr", label: "Pull Request", badge: "" },
    { id: "tags", label: "Tags", badge: "" },
    { id: "worktrees", label: "Worktrees", badge: "" },
  ];
  if (isMultiRepo.value) {
    list.push({ id: "bulk", label: "Bulk", badge: "" });
  }
  return list;
});

const unstagedWithConflicts = computed(() => [
  ...(snapshot.value?.unstaged || []),
  ...(operation.value.conflicts || []).map((entry) => ({ path: entry, code: "UU" })),
]);

const allCommits = computed(() => {
  const seen = new Set();
  const result = [];
  for (const entry of [...(compare.value.commits || []), ...(snapshot.value?.log || [])]) {
    if (!entry.shortHash || seen.has(entry.shortHash)) continue;
    seen.add(entry.shortHash);
    result.push(entry);
  }
  return result;
});

const headerTitle = computed(() => `Git: ${snapshot.value?.branch || props.workspaceId}`);
const headerStatus = computed(() => (snapshot.value?.dirty ? `${snapshot.value.dirtyCount} dirty` : ""));
const headerActions = computed(() => [
  {
    className: "workspace-pane__icon-btn",
    action: "select-tab",
    viewId: `git:${props.workspaceId}`,
    title: "Focus tab",
    label: "◉",
  },
  {
    className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger",
    action: "close-tab",
    viewId: `git:${props.workspaceId}`,
    title: "Close tab",
    label: "×",
  },
]);

function formatDateLabel(value) {
  if (!value) return "Not fetched yet";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function onHeaderAction(action) {
  if (action.action === "select-tab") appStore.activateView(action.viewId);
  else if (action.action === "close-tab") appStore.closeTab(action.viewId);
}

function onCreateWorktree() {
  appStore.createWorktreeWithDialog(props.workspaceId, { preselectedRootPath: activeRootPath.value || "" });
}

function onCheckoutBranch() {
  if (switchBranchTarget.value) {
    gitUiStore.gitCheckoutBranch(props.workspaceId, switchBranchTarget.value);
    switchBranchTarget.value = "";
  }
}

function onCreateBranch() {
  const name = newBranchName.value.trim();
  if (name) {
    gitUiStore.gitCreateBranch(props.workspaceId, name);
    newBranchName.value = "";
  }
}

function onConnectionChange(value) {
  const existing = (appStore.payload?.appState?.workspaces || []).find((ws) => ws.id === props.workspaceId);
  if (existing) {
    appStore.saveWorkspace({ ...existing, connectionId: value });
  }
}

const repoPickerOptions = computed(() => gitRoots.value.map((root) => ({ value: root, label: formatRootLabel(root) })));
const connectionOptions = computed(() => [
  { value: "", label: "System credentials" },
  ...availableConnections.value.map((c) => ({ value: c.id, label: c.label || c.id })),
]);
const switchBranchOptionsList = computed(() => switchBranchOptions.value.map((b) => ({ value: b, label: b })));
const prTargetOptionsList = computed(() => prTargetOptions.value.map((b) => ({ value: b, label: b })));

async function onCreatePr() {
  prResult.value = null;
  await gitUiStore.azureCreatePullRequest(props.workspaceId, {
    title: prTitle.value.trim(),
    description: prDescription.value.trim(),
    sourceBranch: snapshot.value?.branch || "",
    targetBranch: prTargetBranch.value,
    connectionId: activeConnectionId.value || "",
  });
  const result = gitUi.value.lastResult;
  if (result?.ok) {
    prResult.value = { ok: true, summary: `PR #${result.pullRequestId || ""} created.`, url: result.url || "" };
  } else {
    prResult.value = { ok: false, summary: result?.summary || "Failed to create pull request." };
  }
}

function onOpenInEditor(filePath) {
  const root = (snapshot.value?.worktreePath || snapshot.value?.root || "").replace(/\\/g, "/");
  if (!root) return;
  const absPath = root.endsWith("/") ? root + filePath : root + "/" + filePath;
  const editor = appStore.payload?.appState?.settings?.externalEditor || "";
  const api = appStore.getApi();
  if (api?.fileOpenInEditor) {
    api.fileOpenInEditor({ absPath, editor });
  }
}

function openExternal(url) {
  if (window.strideterm?.openExternal) {
    window.strideterm.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
}
</script>

<style scoped>
.git-repo-picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.git-repo-picker__label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.git-view__actions .git-repo-picker__select {
  width: 180px;
}

.git-repo-picker__hint {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
  opacity: 0.7;
}

.git-view__panel--busy {
  position: relative;
  overflow: hidden;
}
.git-view__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(1px);
  pointer-events: none;
}
.git-view__spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--accent, #e8a838);
  border-radius: 50%;
  animation: git-spin 0.8s linear infinite;
}
@keyframes git-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
