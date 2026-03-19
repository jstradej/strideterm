import { html, nothing } from "lit";
import { APP_CONFIG } from "../../config/app-config.js";
import { currentDockerContext, isContainerRunning } from "./helpers.js";

function formatDateLabel(value) {
  if (!value) {
    return "Not fetched yet";
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function renderDiffStat(diffStat = {}) {
  return html`
    <div class="git-stat-row">
      <span class="workspace-chip"><strong>${String(diffStat.files || 0)}</strong> files</span>
      <span class="workspace-chip"><strong>${String(diffStat.insertions || 0)}</strong> +</span>
      <span class="workspace-chip"><strong>${String(diffStat.deletions || 0)}</strong> -</span>
      ${(diffStat.renames || 0)
        ? html`<span class="workspace-chip"><strong>${String(diffStat.renames || 0)}</strong> renames</span>`
        : nothing}
      ${(diffStat.deletes || 0)
        ? html`<span class="workspace-chip"><strong>${String(diffStat.deletes || 0)}</strong> deletes</span>`
        : nothing}
    </div>
  `;
}

const STATUS_LABELS = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Unmerged",
  UU: "Both modified",
  "??": "Untracked",
  "!": "Ignored",
  T: "Type changed",
};

function statusTooltip(code) {
  return STATUS_LABELS[code] || STATUS_LABELS[code?.[0]] || code || "Unknown";
}

function splitFilePath(filePath = "") {
  const fileName = filePath.split("/").pop() || filePath;
  const dirPath = filePath.slice(0, -(fileName.length || 0));
  return { fileName, dirPath };
}

function renderFilePath(filePath) {
  const { fileName, dirPath } = splitFilePath(filePath);
  return html`
    <span class="git-file__name">
      ${dirPath ? html`<span class="git-file__dir">${dirPath}</span>` : nothing}
      ${fileName}
    </span>
  `;
}

function renderDiffLine(line) {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")
    || line.startsWith("index ") || line.startsWith("new ") || line.startsWith("deleted ")
    || line.startsWith("similarity ") || line.startsWith("rename ")) {
    return html`<span class="diff-meta">${line}</span>`;
  }
  if (line.startsWith("@@")) {
    return html`<span class="diff-hunk">${line}</span>`;
  }
  if (line.startsWith("+")) {
    return html`<span class="diff-add">${line}</span>`;
  }
  if (line.startsWith("-")) {
    return html`<span class="diff-del">${line}</span>`;
  }
  return line;
}

function renderDiffPreview(rawDiff) {
  if (!rawDiff) {
    return nothing;
  }

  return rawDiff.split("\n").map((line, index) => html`${index > 0 ? "\n" : nothing}${renderDiffLine(line)}`);
}

function renderChangeList({ title, scope, files = [], selectedDiff = null, workspaceId }) {
  return html`
    <section class="git-change-section">
      <p class="eyebrow">${title} <strong>${String(files.length)}</strong></p>
      ${files.length
        ? html`
            <ul class="git-file-list">
              ${files.slice(0, APP_CONFIG.ui.recentGitEntriesVisible).map((entry) => {
                const code = entry.code || entry.stagedStatus || entry.unstagedStatus || "??";
                const isSelected = selectedDiff?.path === entry.path && selectedDiff?.scope === scope;
                return html`
                  <li>
                    <button
                      type="button"
                      class=${`git-file ${isSelected ? "git-file--active" : ""}`}
                      data-action="git-select-diff"
                      data-workspace-id=${workspaceId}
                      data-path=${entry.path}
                      data-scope=${scope}
                      title=${`${statusTooltip(code)}: ${entry.path}`}
                    >
                      <span class="git-status-code" title=${statusTooltip(code)}>${code || "??"}</span>
                      ${renderFilePath(entry.path)}
                    </button>
                  </li>
                `;
              })}
            </ul>
          `
        : html`<p class="git-card__hint">No files.</p>`}
    </section>
  `;
}

function renderWorktreeList(snapshot, workspaces = []) {
  const workspaceIdsByPath = new Map(workspaces.map((workspace) => [String(workspace.cwd || "").toLowerCase(), workspace.id]));
  const siblings = snapshot.siblingWorktrees || [];

  return siblings.length
    ? html`
        <ul class="git-sibling-list">
          ${siblings.map((entry) => {
            const targetWorkspaceId = workspaceIdsByPath.get(String(entry.path || "").toLowerCase()) || "";
            return html`
              <li class=${entry.isCurrent ? "git-sibling--current" : ""}>
                <div class="git-sibling__meta">
                  <strong>${entry.branch || "detached"}</strong>
                  <small>${entry.path}</small>
                </div>
                <div class="git-sibling__badges">
                  <span class="workspace-chip"><strong>${entry.isMainWorktree ? "main" : "linked"}</strong> worktree</span>
                  <span class="workspace-chip"><strong>${entry.dirty ? String(entry.dirtyCount || 0) : "0"}</strong> ${entry.dirty ? "dirty" : "clean"}</span>
                  ${entry.isCurrent
                    ? html`<span class="workspace-chip workspace-chip--alert"><strong>active</strong></span>`
                    : targetWorkspaceId
                      ? html`<button type="button" class="button button--ghost" data-action="activate-workspace" data-workspace-id=${targetWorkspaceId}>Open</button>`
                      : nothing}
                </div>
              </li>
            `;
          })}
        </ul>
      `
    : html`<p class="git-card__hint">No sibling worktrees detected.</p>`;
}

function renderPendingActionBanner(workspaceId, gitUi = {}) {
  const pending = gitUi.pendingAction;
  if (!pending) {
    return nothing;
  }

  const lines = String(pending.message || "").split("\n");

  return html`
    <div class="git-operation-banner git-operation-banner--confirm">
      <strong>${lines[0] || ""}</strong>
      ${lines.slice(1).map((line) => html`<p>${line}</p>`)}
      <div class="git-operation-actions">
        <button type="button" class="button" data-action="git-confirm-action" data-workspace-id=${workspaceId}>Confirm</button>
        <button type="button" class="button button--ghost" data-action="git-cancel-action" data-workspace-id=${workspaceId}>Cancel</button>
      </div>
    </div>
  `;
}

function renderOperationCard(snapshot, workspaceId, gitUi = {}) {
  const operation = snapshot.operationState || {};
  const result = gitUi.lastResult || null;
  const hasPendingAction = Boolean(gitUi.pendingAction);
  const pendingBanner = renderPendingActionBanner(workspaceId, gitUi);

  if (!operation.inProgress && !result && !hasPendingAction) {
    return html`
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Operation Status</p>
            <h3>Idle</h3>
          </div>
        </div>
        <p class="git-card__hint">No merge, rebase, cherry-pick, or bisect is currently running.</p>
      </article>
    `;
  }

  const activeBlock = operation.inProgress
    ? html`
        <div class="git-operation-banner git-operation-banner--warning">
          <strong>${operation.label || "Git operation in progress"}</strong>
          ${operation.details ? html`<p>${operation.details}</p>` : nothing}
          ${operation.conflicts?.length
            ? html`<small>${operation.conflicts.join(", ")}</small>`
            : nothing}
          <div class="git-operation-actions">
            ${operation.canContinue ? html`<button type="button" class="button" data-action="git-continue" data-workspace-id=${workspaceId}>Continue</button>` : nothing}
            ${operation.canAbort ? html`<button type="button" class="button button--ghost danger" data-action="git-abort" data-workspace-id=${workspaceId}>Abort</button>` : nothing}
            <button type="button" class="button button--ghost" data-action="open-lazygit" data-workspace-id=${workspaceId}>Open Lazygit</button>
          </div>
        </div>
      `
    : nothing;

  const resultTone = result?.ok ? "ok" : "error";
  const resultBlock = result
    ? html`
        <div class=${`git-operation-banner git-operation-banner--${resultTone}`}>
          <div class="section-head">
            <strong>${result.summary || (result.ok ? "Git action completed." : "Git action failed.")}</strong>
            <button type="button" class="button button--ghost" data-action="git-clear-result" data-workspace-id=${workspaceId}>Clear</button>
          </div>
          ${result.warnings?.length
            ? html`<ul class="git-inline-list">${result.warnings.map((warning) => html`<li>${warning}</li>`)}</ul>`
            : nothing}
          ${result.conflicts?.length
            ? html`<p class="git-card__hint">Conflicts: ${result.conflicts.join(", ")}</p>`
            : nothing}
          ${result.rawOutput
            ? html`<pre class="git-output">${result.rawOutput}</pre>`
            : nothing}
        </div>
      `
    : nothing;

  const heading = hasPendingAction
    ? "Confirm action"
    : operation.inProgress ? operation.label : "Last result";

  return html`
    <article class="git-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Operation Status</p>
          <h3>${heading}</h3>
        </div>
      </div>
      ${pendingBanner}
      ${activeBlock}
      ${resultBlock}
    </article>
  `;
}

function renderTabNav(activeTab, workspaceId, { operation, dirtyCount }) {
  const tabs = [
    { id: "status", label: "Status", badge: operation.inProgress ? "!" : "" },
    { id: "changes", label: "Changes", badge: dirtyCount > 0 ? String(dirtyCount) : "" },
    { id: "history", label: "History", badge: "" },
    { id: "worktrees", label: "Worktrees", badge: "" },
  ];

  return html`
    <nav class="git-tabs" role="tablist" aria-label="Git sections">
      ${tabs.map((tab) => html`
        <button
          type="button"
          id="git-tab-${workspaceId}-${tab.id}"
          role="tab"
          aria-selected="${tab.id === activeTab ? "true" : "false"}"
          aria-controls="git-panel-${workspaceId}"
          class="git-tabs__item ${tab.id === activeTab ? "git-tabs__item--active" : ""}"
          data-action="git-switch-tab"
          data-workspace-id=${workspaceId}
          data-tab=${tab.id}
        >${tab.label}${tab.badge ? html` <span class="git-tabs__badge">${tab.badge}</span>` : nothing}</button>
      `)}
    </nav>
  `;
}

function renderMergeBackCard(gitSnapshot, workspaceId, workspaces, gitUi) {
  const compare = gitSnapshot.compareWithBase || {};
  const baseBranch = gitSnapshot.baseBranch || compare.baseBranch || "";
  const files = compare.files || [];
  const busyAction = gitUi?.busyAction || "";
  const mainWorktree = (gitSnapshot.siblingWorktrees || []).find((entry) => entry.isMainWorktree && !entry.isCurrent);
  const workspaceIdsByPath = new Map((workspaces || []).map((ws) => [String(ws.cwd || "").toLowerCase(), ws.id]));
  const mainWorktreeWorkspaceId = mainWorktree ? (workspaceIdsByPath.get(String(mainWorktree.path || "").toLowerCase()) || "") : "";

  if (!baseBranch) {
    return html`
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Merge Back</p>
            <h3>${gitSnapshot.branch} &rarr; ?</h3>
          </div>
        </div>
        <p class="git-card__hint">Base branch was not detected.</p>
      </article>
    `;
  }

  const dirtyFiles = [...(gitSnapshot.staged || []), ...(gitSnapshot.unstaged || [])].map((entry) => entry.path);
  const baseChangedFiles = new Set(compare.baseChangedFiles || []);
  const dirtyConflicts = baseChangedFiles.size > 0
    ? dirtyFiles.filter((filePath) => baseChangedFiles.has(filePath))
    : [];

  if (!compare.aheadCount) {
    const overlapWarning = dirtyConflicts.length > 0
      ? html`
        <details class="git-details">
          <summary class="git-card__hint git-card__hint--warning">Conflict risk: ${String(dirtyConflicts.length)} overlapping dirty file${dirtyConflicts.length === 1 ? "" : "s"}</summary>
          <p class="git-card__hint git-card__hint--warning">Some dirty files were also changed on ${baseBranch}. Resolve or stash them before merging back.</p>
          <details class="git-details">
            <summary>Show overlapping files</summary>
            <ul class="git-file-list">
              ${dirtyConflicts.slice(0, 30).map((filePath) => {
                return html`
                  <li>
                    <span class="git-file" title=${`Potential conflict: ${filePath}`}>
                      <span class="git-status-code">!</span>
                      ${renderFilePath(filePath)}
                    </span>
                  </li>
                `;
              })}
              ${dirtyConflicts.length > 30 ? html`<li><p class="git-card__hint">... and ${dirtyConflicts.length - 30} more files.</p></li>` : nothing}
            </ul>
          </details>
        </details>
      `
      : nothing;

    const commitBlock = gitSnapshot.dirty
      ? html`
        <p class="git-card__hint">No commits ahead of ${baseBranch} yet. Commit your changes first.</p>
        <div class="git-commit-form">
          <input name="commit-message" type="text" .value=${gitSnapshot.branch.replace(/-/g, " ")} placeholder="Commit message" />
          <button type="button" class="button" data-action="git-commit-all" data-workspace-id=${workspaceId} ?disabled=${Boolean(busyAction)}>${busyAction === "commit" ? "Committing..." : "Commit all changes"}</button>
        </div>
        ${overlapWarning}
      `
      : html`<p class="git-card__hint">Branch is clean and up to date with ${baseBranch}. Nothing to merge back.</p>`;

    return html`
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Merge Back</p>
            <h3>${gitSnapshot.branch} &rarr; ${baseBranch}</h3>
          </div>
        </div>
        ${commitBlock}
      </article>
    `;
  }

  const potentialConflicts = compare.potentialConflicts || [];

  return html`
    <article class="git-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Merge Back</p>
          <h3>${gitSnapshot.branch} &rarr; ${baseBranch}</h3>
        </div>
      </div>
      <div class="git-stat-row">
        <span class="workspace-chip"><strong>${String(compare.aheadCount || 0)}</strong> commits to merge</span>
        <span class="workspace-chip"><strong>${String(files.length)}</strong> files changed</span>
        ${compare.behindCount > 0 ? html`<span class="workspace-chip workspace-chip--alert"><strong>${String(compare.behindCount)}</strong> behind base</span>` : nothing}
      </div>
      ${compare.behindCount > 0
        ? html`<p class="git-card__hint git-card__hint--warning">This branch is ${String(compare.behindCount)} commit(s) behind ${baseBranch}. Rebase or merge base first to reduce conflict risk.</p>`
        : nothing
      }
      ${files.length
        ? html`
          <details class="git-details">
            <summary>Changed files (${String(files.length)})</summary>
            <ul class="git-file-list">
              ${files.slice(0, 30).map((entry) => {
                return html`
                  <li>
                    <span class="git-file" title=${`${entry.code || "M"}: ${entry.path}`}>
                      <span class="git-status-code">${entry.code || "M"}</span>
                      ${renderFilePath(entry.path)}
                    </span>
                  </li>
                `;
              })}
              ${files.length > 30 ? html`<li><p class="git-card__hint">... and ${files.length - 30} more files.</p></li>` : nothing}
            </ul>
          </details>
        `
        : nothing
      }
      ${potentialConflicts.length > 0
        ? html`
          <details class="git-details">
            <summary class="git-card__hint--warning">Potential conflicts (${String(potentialConflicts.length)})</summary>
            <p class="git-card__hint git-card__hint--warning">These files were modified on both your branch and ${baseBranch}. Merging may require manual conflict resolution.</p>
            <ul class="git-file-list">
              ${potentialConflicts.slice(0, 30).map((filePath) => {
                return html`
                  <li>
                    <span class="git-file" title=${`Potential conflict: ${filePath}`}>
                      <span class="git-status-code">!</span>
                      ${renderFilePath(filePath)}
                    </span>
                  </li>
                `;
              })}
              ${potentialConflicts.length > 30 ? html`<li><p class="git-card__hint">... and ${potentialConflicts.length - 30} more files.</p></li>` : nothing}
            </ul>
          </details>
        `
        : nothing
      }
      <div class="git-operation-actions">
        <button
          type="button"
          class="button"
          data-action="git-merge-into-base"
          data-workspace-id=${workspaceId}
          data-base-branch=${baseBranch}
          title=${`Runs: git merge ${gitSnapshot.branch} in the ${baseBranch} worktree.`}
        >Merge ${gitSnapshot.branch} &rarr; ${baseBranch}</button>
        ${mainWorktreeWorkspaceId
          ? html`<button type="button" class="button button--ghost" data-action="activate-workspace" data-workspace-id=${mainWorktreeWorkspaceId} title=${`Switch to ${baseBranch} worktree.`}>Open ${baseBranch} worktree</button>`
          : nothing
        }
      </div>
      ${gitSnapshot.worktreePath && !gitSnapshot.isMainWorktree
        ? html`
          <details class="git-details">
            <summary>After merge: clean up worktree</summary>
            <p class="git-card__hint">Once merged, you can remove this worktree and delete the branch.</p>
            <div class="git-operation-actions">
              <button type="button" class="button button--ghost danger" data-action="git-remove-worktree" data-workspace-id=${workspaceId} data-worktree-path=${gitSnapshot.worktreePath} data-delete-branch="true" title="Removes this worktree directory and deletes the branch.">Remove worktree + delete branch</button>
              <button type="button" class="button button--ghost" data-action="git-remove-worktree" data-workspace-id=${workspaceId} data-worktree-path=${gitSnapshot.worktreePath} data-delete-branch="false" title="Removes the worktree but keeps the branch.">Remove worktree only</button>
            </div>
          </details>
        `
        : nothing
      }
    </article>
  `;
}

function renderStatusSection(gitSnapshot, workspaceId, gitUi, workspaces) {
  const baseBranch = gitSnapshot.baseBranch || gitSnapshot.compareWithBase?.baseBranch || "";
  const busyAction = gitUi.busyAction || "";
  const operation = gitSnapshot.operationState || {};
  const canIntegrateWithBase = Boolean(baseBranch);

  return html`
    <div class="git-section">
      ${renderOperationCard(gitSnapshot, workspaceId, gitUi)}
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Update Current Branch</p>
            <h3>${baseBranch || "?"} &rarr; ${gitSnapshot.branch}</h3>
          </div>
        </div>
        <div class="git-detail-list">
          <span><strong>Current branch:</strong> ${gitSnapshot.branch}</span>
          <span><strong>Base branch (local):</strong> ${baseBranch || "not detected"}</span>
          <span><strong>Upstream:</strong> ${gitSnapshot.upstream || "none"}</span>
          <span><strong>Ahead/behind upstream:</strong> ${String(gitSnapshot.aheadCount || 0)} / ${String(gitSnapshot.behindCount || 0)}</span>
          <span><strong>Last fetch:</strong> ${formatDateLabel(gitSnapshot.lastFetchAt)}</span>
        </div>
        ${canIntegrateWithBase
          ? html`
            <div class="git-operation-actions">
              <button
                type="button"
                class="button"
                data-action="git-rebase-base"
                data-workspace-id=${workspaceId}
                data-base-branch=${baseBranch}
                ?disabled=${Boolean(busyAction || operation.inProgress)}
                title=${`Runs: git rebase ${baseBranch} (local). Replays your commits on top of the local ${baseBranch} branch.`}
              >${busyAction === "rebase" ? "Rebasing..." : `Rebase onto ${baseBranch}`}</button>
              <button
                type="button"
                class="button button--ghost"
                data-action="git-merge-base"
                data-workspace-id=${workspaceId}
                data-base-branch=${baseBranch}
                ?disabled=${Boolean(busyAction || operation.inProgress)}
                title=${`Runs: git merge ${baseBranch} (local). Brings commits from the local ${baseBranch} branch into ${gitSnapshot.branch}.`}
              >${busyAction === "merge" ? "Merging..." : `Merge ${baseBranch} in`}</button>
            </div>
            <p class="git-card__hint">Operations use the local ${baseBranch} branch. Fetch first to sync with remote.</p>
          `
          : html`<p class="git-card__hint">Base branch could not be detected automatically for this repository.</p>`
        }
      </article>
      ${renderMergeBackCard(gitSnapshot, workspaceId, workspaces, gitUi)}
    </div>
  `;
}

function renderChangesSection(gitSnapshot, workspaceId, gitUi) {
  const diffPreview = gitUi.diffPreview || null;
  const selectedDiff = gitUi.selectedDiff || null;
  const operation = gitSnapshot.operationState || {};

  return html`
    <div class="git-section git-section--changes">
      <div class="git-section__files">
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Changes</p>
              <h3>${gitSnapshot.dirty ? "Working tree overview" : "No local changes"}</h3>
            </div>
          </div>
          ${renderDiffStat(gitSnapshot.diffStat)}
          ${renderChangeList({ title: "Staged", scope: "staged", files: gitSnapshot.staged || [], selectedDiff, workspaceId })}
          ${renderChangeList({ title: "Unstaged", scope: "unstaged", files: [...(gitSnapshot.unstaged || []), ...(operation.conflicts || []).map((entry) => ({ path: entry, code: "UU" }))], selectedDiff, workspaceId })}
          ${renderChangeList({ title: "Untracked", scope: "untracked", files: gitSnapshot.untracked || [], selectedDiff, workspaceId })}
        </article>
      </div>
      <div class="git-section__preview">
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Diff Preview</p>
              <h3>${diffPreview?.path || "Select a file"}</h3>
            </div>
          </div>
          ${diffPreview
            ? html`
                ${diffPreview.summary ? html`<p class="git-card__hint">${diffPreview.summary}</p>` : nothing}
                <pre class="git-output git-output--preview">${renderDiffPreview(diffPreview.diff || "")}</pre>
              `
            : html`<p class="git-card__hint">Click a file to load a diff preview.</p>`
          }
        </article>
      </div>
    </div>
  `;
}

function renderHistorySection(gitSnapshot, workspaceId, gitUi) {
  const compare = gitSnapshot.compareWithBase || {};
  const baseBranch = gitSnapshot.baseBranch || compare.baseBranch || "";
  const selectedCommit = gitUi?.selectedCommit || "";
  const commitDiffPreview = gitUi?.commitDiffPreview || null;

  // Merge compare.commits and gitSnapshot.log, dedup by shortHash
  const seen = new Set();
  const allCommits = [];
  for (const entry of [...(compare.commits || []), ...(gitSnapshot.log || [])]) {
    if (!entry.shortHash || seen.has(entry.shortHash)) continue;
    seen.add(entry.shortHash);
    allCommits.push(entry);
  }

  return html`
    <div class="git-section git-section--history">
      <div class="git-history__header">
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Compare With Base</p>
              <h3>${baseBranch || "No base branch"}</h3>
            </div>
          </div>
          ${renderDiffStat(compare.diffStat)}
          <div class="git-detail-list">
            <span><strong>Branch commits:</strong> ${String(compare.aheadCount || 0)}</span>
            <span><strong>Missing from base:</strong> ${String(compare.behindCount || 0)}</span>
          </div>
        </article>
      </div>
      <div class="git-history__panels">
        <div class="git-history__log">
          ${allCommits.length
            ? html`
              <table class="git-log-table">
                <thead>
                  <tr><th scope="col">Hash</th><th scope="col">Message</th><th scope="col">Date</th><th scope="col">Author</th></tr>
                </thead>
                <tbody>
                  ${allCommits.map((entry) => html`
                    <tr
                      class=${selectedCommit === entry.shortHash ? "git-log-table--active" : ""}
                      data-action="git-select-commit"
                      data-workspace-id=${workspaceId}
                      data-hash=${entry.shortHash}
                      title=${entry.subject}
                    >
                      <td class="git-log-table__hash">${entry.shortHash}</td>
                      <td class="git-log-table__msg">${entry.subject}</td>
                      <td class="git-log-table__date">${entry.relativeDate}</td>
                      <td class="git-log-table__author">${entry.author || ""}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            `
            : html`<p class="git-card__hint">No commit history available yet.</p>`
          }
        </div>
        <div class="git-history__detail">
          ${commitDiffPreview
            ? html`
                ${commitDiffPreview.summary ? html`<p class="git-card__hint">${commitDiffPreview.summary}</p>` : nothing}
                <pre class="git-output git-output--preview">${renderDiffPreview(commitDiffPreview.diff || "")}</pre>
              `
            : html`<p class="git-card__hint">Select a commit to view its diff.</p>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderWorktreesSection(gitSnapshot, workspaceId, workspaces) {
  return html`
    <div class="git-section">
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Worktree Context</p>
            <h3>${gitSnapshot.repository || gitSnapshot.root}</h3>
          </div>
        </div>
        <p class="git-card__path">${gitSnapshot.root}</p>
        <div class="git-detail-list">
          <span><strong>Current branch:</strong> ${gitSnapshot.branch}</span>
          <span><strong>Main worktree:</strong> ${gitSnapshot.mainWorktreePath || gitSnapshot.root}</span>
          <span><strong>Current path:</strong> ${gitSnapshot.worktreePath || gitSnapshot.root}</span>
        </div>
        ${renderWorktreeList(gitSnapshot, workspaces)}
      </article>
    </div>
  `;
}

export function renderGitMarkup(gitSnapshot, workspaceId, gitUi = {}, workspaces = []) {
  if (!gitSnapshot?.available) {
    return html`
      <div class="terminal-empty">
        <p>Git workspace is unavailable</p>
        <small>This workspace is not inside a Git repository.</small>
      </div>
    `;
  }

  const operation = gitSnapshot.operationState || {};
  const busyAction = gitUi.busyAction || "";
  const activeTab = gitUi.activeTab || "status";

  const sectionRenderers = {
    status: () => renderStatusSection(gitSnapshot, workspaceId, gitUi, workspaces),
    changes: () => renderChangesSection(gitSnapshot, workspaceId, gitUi),
    history: () => renderHistorySection(gitSnapshot, workspaceId, gitUi),
    worktrees: () => renderWorktreesSection(gitSnapshot, workspaceId, workspaces),
  };

  const sectionContent = (sectionRenderers[activeTab] || sectionRenderers.status)();

  return html`
    <div class="git-view">
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"><strong>${gitSnapshot.branch}</strong> branch</span>
          <span class="workspace-chip"><strong>${gitSnapshot.isMainWorktree ? "main" : "linked"}</strong> worktree</span>
          <span class="workspace-chip"><strong>${String(gitSnapshot.aheadCount || 0)}</strong> ahead</span>
          <span class="workspace-chip"><strong>${String(gitSnapshot.behindCount || 0)}</strong> behind</span>
          <span class="workspace-chip"><strong>${gitSnapshot.dirty ? String(gitSnapshot.dirtyCount) : "0"}</strong> ${gitSnapshot.dirty ? "dirty" : "clean"}</span>
          ${operation.inProgress ? html`<span class="workspace-chip workspace-chip--alert"><strong>${operation.kind}</strong> in progress</span>` : nothing}
        </div>
        <div class="git-view__actions">
          <button type="button" class="button button--ghost" data-action="refresh-git" data-workspace-id=${workspaceId}>Refresh</button>
          <button type="button" class="button button--ghost" data-action="git-fetch" data-workspace-id=${workspaceId} ?disabled=${Boolean(busyAction)}>${busyAction === "fetch" ? "Fetching..." : "Fetch"}</button>
          <button type="button" class="button button--ghost" data-action="create-worktree" data-workspace-id=${workspaceId}>New worktree</button>
          ${gitSnapshot.lazygit?.available
            ? html`<button type="button" class="button" data-action="open-lazygit" data-workspace-id=${workspaceId} style="white-space:nowrap;">Open Lazygit</button>`
            : html`<button type="button" class="button button--ghost" disabled style="white-space:nowrap;border:1px dashed var(--accent);color:var(--accent);opacity:0.9;" title="Install lazygit to enable">Install Lazygit</button>`
          }
        </div>
      </div>
      ${renderTabNav(activeTab, workspaceId, { operation, dirtyCount: gitSnapshot.dirtyCount || 0 })}
      <section id="git-panel-${workspaceId}" role="tabpanel" aria-labelledby="git-tab-${workspaceId}-${activeTab}">
        ${sectionContent}
      </section>
    </div>
  `;
}

export function renderDockerMarkup(dockerState = {}) {
  const containers = dockerState.containers || [];
  const runningCount = containers.filter(isContainerRunning).length;
  const activeContext = currentDockerContext(dockerState.contexts);

  if (!dockerState.available) {
    return html`<div class="empty-card"><p>Docker runtime is unavailable.</p><small>${dockerState.error || "Install Docker CLI on Windows or expose it via WSL."}</small></div>`;
  }

  const lazydockerInfo = dockerState.lazydocker || {};
  const lazydockerAvailable = lazydockerInfo.available || false;

  return html`
    <section class="docker-manager" aria-label="Docker manager">
      <header class="docker-manager__header">
        <div class="docker-manager__summary">
          <article class="docker-stat">
            <span class="eyebrow">Context</span>
            <strong>${activeContext?.Name || "n/a"}</strong>
            <small>${activeContext?.DockerEndpoint || "No context"}</small>
          </article>
          <article class="docker-stat">
            <span class="eyebrow">Containers</span>
            <strong>${containers.length}</strong>
            <small>${runningCount} running</small>
          </article>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${lazydockerAvailable
            ? html`<button type="button" class="button" data-action="open-lazydocker" style="white-space:nowrap;">Open Lazydocker</button>`
            : html`<button type="button" class="button button--ghost" disabled style="white-space:nowrap;border:1px dashed var(--accent);color:var(--accent);opacity:0.9;" title="Install lazydocker: winget install JesseDuffield.lazygit or brew install lazydocker">Install Lazydocker</button>`
          }
        </div>
      </header>
      <ul class="docker-list" role="list">
        ${containers.length
          ? containers.map((container) => {
              const running = isContainerRunning(container);
              return html`
                <li>
                  <article class=${`docker-card ${running ? "docker-card--running" : ""}`}>
                    <div class="docker-card__head">
                      <div>
                        <h4>${container.Names || container.ID}</h4>
                        <p class="docker-card__meta">${container.Image || "Unknown image"}</p>
                      </div>
                      <span class=${`docker-state docker-state--${running ? "running" : "stopped"}`}>${container.State || (running ? "running" : "stopped")}</span>
                    </div>
                    <div class="docker-card__meta">
                      <span>${container.Status || "Unknown status"}</span>
                      <span>${container.Ports || "No ports"}</span>
                    </div>
                    <div class="docker-card__actions" aria-label="Container actions">
                      <button type="button" class="button button--ghost" data-action="docker-shell" data-container-id=${container.ID} ?disabled=${!running}>Shell</button>
                      <button type="button" class="button button--ghost" data-action="docker-logs" data-container-id=${container.ID}>Logs</button>
                      <button type="button" class="button button--ghost" data-action="docker-start" data-container-id=${container.ID} ?disabled=${running}>Start</button>
                      <button type="button" class="button button--ghost" data-action="docker-stop" data-container-id=${container.ID} ?disabled=${!running}>Stop</button>
                      <button type="button" class="button button--ghost" data-action="docker-restart" data-container-id=${container.ID} ?disabled=${!running}>Restart</button>
                      <button type="button" class="button button--ghost danger" data-action="docker-remove" data-container-id=${container.ID}>Remove</button>
                    </div>
                  </article>
                </li>
              `;
            })
          : html`<li><div class="empty-card"><p>No containers found.</p><small>When Docker services appear, you can open logs or attach a shell here.</small></div></li>`}
      </ul>
    </section>
  `;
}

function renderPullRequestRow(item) {
  return `
    <div class="azure-pr-row">
      <div class="azure-pr-row__main">
        <div class="azure-pr-row__title">
          <span class="azure-pr-row__id">#${escapeHtml(String(item.pullRequest.id))}</span>
          <strong>${escapeHtml(item.pullRequest.title)}</strong>
          ${item.hasAttention ? `<span class="workspace-chip workspace-chip--alert">${escapeHtml(item.attentionReason || "attention")}</span>` : ""}
        </div>
        <div class="azure-pr-row__meta">
          <span>${escapeHtml(item.project.name)} / ${escapeHtml(item.repository.name)}</span>
          <span>\u00B7</span>
          <span>${escapeHtml(item.author.displayName)}</span>
          <span>\u00B7</span>
          <span>${escapeHtml(item.role)}</span>
        </div>
        <div class="azure-pr-row__branch">
          ${escapeHtml(item.pullRequest.sourceRefName.replace(/^refs\/heads\//, ""))} \u2192 ${escapeHtml(item.pullRequest.targetRefName.replace(/^refs\/heads\//, ""))}
        </div>
      </div>
      <div class="azure-pr-row__actions">
        <button class="button" data-action="open-azure-pull-request" data-pr-key="${escapeHtml(item.prKey)}" data-workspace-id="${escapeHtml(item.role === "author" && item.existingWorkspaceId && !item.reviewWorkspaceId ? item.existingWorkspaceId : "")}">
          ${item.role === "author" && item.existingWorkspaceId && !item.reviewWorkspaceId ? "Attach" : (item.reviewWorkspaceId ? "Open" : "Review")}
        </button>
        <button class="button button--ghost" data-action="open-azure-browser" data-url="${escapeHtml(item.pullRequest.webUrl || item.pullRequest.url)}">Browser</button>
        ${item.hasAttention ? `<button class="button button--ghost" data-action="mark-azure-pr-seen" data-pr-key="${escapeHtml(item.prKey)}">Seen</button>` : ""}
      </div>
    </div>`;
}

function renderPullRequestList(items = []) {
  if (!items.length) {
    return '<div class="azure-empty"><p>No pull requests in this view.</p></div>';
  }
  return items.map(renderPullRequestRow).join("");
}

export function renderAzureInboxMarkup(azure = {}, settings = {}) {
  const connections = azure.connections || [];
  const inbox = azure.inbox || {};
  if (!connections.length) {
    return `
      <div class="terminal-empty">
        <p>No Azure DevOps connections yet</p>
        <small>Add a connection with organization URL, login, PAT and review checkout path.</small>
        <div class="docker-card__actions" style="margin-top:12px;">
          <button class="button" data-action="open-azure-connection-dialog">Add Azure connection</button>
        </div>
      </div>
    `;
  }

  const needsReviewCount = inbox.needsMyReview?.length || 0;
  const myPrsCount = inbox.myPullRequests?.length || 0;
  const attentionCount = inbox.needsAttention?.length || 0;

  return `
    <div class="azure-inbox">
      <div class="azure-inbox__toolbar">
        <div class="azure-inbox__tabs">
          <button class="azure-tab azure-tab--active" data-action="azure-switch-tab" data-tab="needs-review">
            Needs review <span class="azure-tab__count">${escapeHtml(String(needsReviewCount))}</span>
          </button>
          <button class="azure-tab" data-action="azure-switch-tab" data-tab="my-prs">
            My PRs <span class="azure-tab__count">${escapeHtml(String(myPrsCount))}</span>
          </button>
          ${attentionCount ? `
            <button class="azure-tab azure-tab--alert" data-action="azure-switch-tab" data-tab="attention">
              Attention <span class="azure-tab__count">${escapeHtml(String(attentionCount))}</span>
            </button>
          ` : ""}
          <button class="azure-tab" data-action="azure-switch-tab" data-tab="connections">
            Connections <span class="azure-tab__count">${escapeHtml(String(connections.length))}</span>
          </button>
        </div>
        <div class="azure-inbox__actions">
          <button class="button button--ghost" data-action="refresh-azure">Refresh</button>
          <button class="button" data-action="open-azure-connection-dialog">Add connection</button>
        </div>
      </div>

      <div class="azure-inbox__content">
        <div class="azure-section azure-section--active" data-azure-section="needs-review">
          ${renderPullRequestList(inbox.needsMyReview)}
        </div>
        <div class="azure-section" data-azure-section="my-prs">
          ${renderPullRequestList(inbox.myPullRequests)}
        </div>
        ${attentionCount ? `
          <div class="azure-section" data-azure-section="attention">
            ${renderPullRequestList(inbox.needsAttention)}
          </div>
        ` : ""}
        <div class="azure-section" data-azure-section="connections">
          <div class="docker-list" style="padding:0 4px 4px;">
            ${connections.map((connection) => `
              <div class="docker-card">
                <div class="docker-card__head">
                  <div>
                    <h4>${escapeHtml(connection.label)}</h4>
                    <p class="docker-card__meta">${escapeHtml(connection.orgUrl)}</p>
                  </div>
                  <span class="docker-state docker-state--${connection.status === "ok" ? "running" : "stopped"}">${escapeHtml(connection.status || "idle")}</span>
                </div>
                <div class="docker-card__meta">
                  <span>${escapeHtml(connection.login)} ${escapeHtml(connection.projectFilters?.join(", ") || "all projects")}</span>
                </div>
                <div class="docker-card__actions">
                  <button class="button button--ghost" data-action="open-azure-connection-dialog" data-connection-id="${escapeHtml(connection.id)}">Edit</button>
                  <button class="button button--ghost danger" data-action="delete-azure-connection" data-connection-id="${escapeHtml(connection.id)}">Delete</button>
                </div>
              </div>
            `).join("")}
          </div>
          <p class="git-card__hint" style="padding:8px 4px;">Review root: ${escapeHtml(settings.reviewRoot || "")}</p>
        </div>
      </div>
    </div>
  `;
}

export function renderAzureReviewMarkup(detail = {}, workspaceId = "") {
  const threads = detail.threads || [];
  const changedFiles = detail.changedFiles || [];
  const localChangedFiles = detail.localChangedFiles || [];
  return `
    <div class="git-view">
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"><strong>PR #${escapeHtml(String(detail.pullRequest?.id || ""))}</strong></span>
          <span class="workspace-chip">${escapeHtml(detail.project?.name || "")} / ${escapeHtml(detail.repository?.name || "")}</span>
          <span class="workspace-chip">${escapeHtml(detail.role || "")}</span>
          ${detail.hasAttention ? `<span class="workspace-chip workspace-chip--alert">${escapeHtml(detail.attentionReason || "attention")}</span>` : ""}
        </div>
        <div class="git-view__actions" style="margin-left:auto;">
          <button class="button button--ghost" data-action="refresh-azure">Refresh</button>
          <button class="button button--ghost" data-action="mark-azure-pr-seen" data-pr-key="${escapeHtml(detail.prKey || "")}">Mark seen</button>
          <button class="button button--ghost" data-action="open-azure-browser" data-url="${escapeHtml(detail.pullRequest?.webUrl || detail.pullRequest?.url || "")}">Browser</button>
        </div>
      </div>
      <div class="git-grid">
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Overview</p>
              <h3>${escapeHtml(detail.pullRequest?.title || "Azure review")}</h3>
            </div>
          </div>
          <p class="git-card__hint">${escapeHtml(detail.pullRequest?.description || "No description.")}</p>
          <p class="git-card__hint">${escapeHtml((detail.pullRequest?.sourceRefName || "").replace(/^refs\/heads\//, ""))} → ${escapeHtml((detail.pullRequest?.targetRefName || "").replace(/^refs\/heads\//, ""))}</p>
          <div class="docker-card__actions">
            <button class="button button--ghost" data-action="azure-fetch-review-workspace" data-workspace-id="${escapeHtml(workspaceId)}">Fetch</button>
            <button class="button button--ghost" data-action="azure-rebase-review-workspace" data-workspace-id="${escapeHtml(workspaceId)}">Rebase on target</button>
            <button class="button button--ghost" data-action="azure-push-review-workspace" data-workspace-id="${escapeHtml(workspaceId)}">Push branch</button>
            <button class="button button--ghost" data-action="open-lazygit" data-workspace-id="${escapeHtml(workspaceId)}">Open Lazygit</button>
          </div>
          <div class="docker-card__actions">
            <button class="button button--ghost" data-action="azure-vote" data-pr-key="${escapeHtml(detail.prKey || "")}" data-vote="10">Approve</button>
            <button class="button button--ghost" data-action="azure-vote" data-pr-key="${escapeHtml(detail.prKey || "")}" data-vote="5">Approve with suggestions</button>
            <button class="button button--ghost" data-action="azure-vote" data-pr-key="${escapeHtml(detail.prKey || "")}" data-vote="-5">Wait</button>
            <button class="button button--ghost danger" data-action="azure-vote" data-pr-key="${escapeHtml(detail.prKey || "")}" data-vote="-10">Reject</button>
            <button class="button button--ghost" data-action="azure-vote" data-pr-key="${escapeHtml(detail.prKey || "")}" data-vote="0">Clear vote</button>
          </div>
          <div class="docker-card__actions">
            <button class="button" data-action="azure-comment" data-pr-key="${escapeHtml(detail.prKey || "")}">New comment</button>
          </div>
        </article>
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Reviewers</p>
              <h3>${escapeHtml(String(detail.reviewerSummary?.totalCount || 0))} reviewers</h3>
            </div>
          </div>
          <ul class="git-list">
            ${(detail.reviewerSummary?.reviewers || []).map((reviewer) => `
              <li><span class="git-status-code">${escapeHtml(String(reviewer.vote))}</span><span class="git-list__text">${escapeHtml(reviewer.displayName)}</span></li>
            `).join("") || '<li><span>No reviewers</span></li>'}
          </ul>
        </article>
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Changed Files</p>
              <h3>${escapeHtml(String(changedFiles.length || localChangedFiles.length))} files</h3>
            </div>
          </div>
          <ul class="git-list">
            ${(changedFiles.length ? changedFiles : localChangedFiles).map((file) => `
              <li><span class="git-status-code">${escapeHtml(String(file.changeType || "M"))}</span><span class="git-list__text git-list__text--path">${escapeHtml(file.path || "")}</span></li>
            `).join("") || '<li><span>No changed files found.</span></li>'}
          </ul>
        </article>
        <article class="git-card git-card--wide">
          <div class="section-head">
            <div>
              <p class="eyebrow">Conversation</p>
              <h3>${escapeHtml(String(threads.length))} threads</h3>
            </div>
          </div>
          <div class="docker-list">
            ${threads.map((thread) => `
              <div class="docker-card">
                <div class="docker-card__head">
                  <div>
                    <h4>Thread #${escapeHtml(String(thread.id))}</h4>
                    <p class="docker-card__meta">${escapeHtml(thread.status || "unknown")}</p>
                  </div>
                </div>
                ${(thread.comments || []).map((comment) => `
                  <div style="padding:8px 0;border-top:1px solid var(--border);">
                    <strong>${escapeHtml(comment.author?.displayName || "Unknown author")}</strong>
                    <p style="margin:6px 0 0;white-space:pre-wrap;">${escapeHtml(comment.content || "")}</p>
                  </div>
                `).join("")}
                <div class="docker-card__actions">
                  <button class="button button--ghost" data-action="azure-reply-thread" data-pr-key="${escapeHtml(detail.prKey || "")}" data-thread-id="${escapeHtml(String(thread.id))}" data-parent-comment-id="${escapeHtml(String((thread.comments || []).at(-1)?.id || 0))}">Reply</button>
                </div>
              </div>
            `).join("") || '<div class="empty-card"><p>No conversation yet.</p></div>'}
          </div>
        </article>
      </div>
    </div>
  `;
}
