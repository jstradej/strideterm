import { APP_CONFIG } from "../../config/app-config.js";
import { currentDockerContext, escapeHtml, isContainerRunning } from "./helpers.js";

function colorizeDiff(rawDiff) {
  if (!rawDiff) {
    return "";
  }

  return rawDiff
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line);
      if (line.startsWith("+++") || line.startsWith("---")) {
        return `<span class="diff-meta">${escaped}</span>`;
      }
      if (line.startsWith("@@")) {
        return `<span class="diff-hunk">${escaped}</span>`;
      }
      if (line.startsWith("+")) {
        return `<span class="diff-add">${escaped}</span>`;
      }
      if (line.startsWith("-")) {
        return `<span class="diff-del">${escaped}</span>`;
      }
      if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new ") || line.startsWith("deleted ") || line.startsWith("similarity ") || line.startsWith("rename ")) {
        return `<span class="diff-meta">${escaped}</span>`;
      }
      return escaped;
    })
    .join("\n");
}

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
  return `
    <div class="git-stat-row">
      <span class="workspace-chip"><strong>${escapeHtml(String(diffStat.files || 0))}</strong> files</span>
      <span class="workspace-chip"><strong>${escapeHtml(String(diffStat.insertions || 0))}</strong> +</span>
      <span class="workspace-chip"><strong>${escapeHtml(String(diffStat.deletions || 0))}</strong> -</span>
      ${(diffStat.renames || 0) ? `<span class="workspace-chip"><strong>${escapeHtml(String(diffStat.renames || 0))}</strong> renames</span>` : ""}
      ${(diffStat.deletes || 0) ? `<span class="workspace-chip"><strong>${escapeHtml(String(diffStat.deletes || 0))}</strong> deletes</span>` : ""}
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

function renderChangeList({ title, scope, files = [], selectedDiff = null, workspaceId }) {
  return `
    <section class="git-change-section">
      <p class="eyebrow">${escapeHtml(title)} <strong>${escapeHtml(String(files.length))}</strong></p>
      ${
        files.length
          ? `
            <ul class="git-file-list">
              ${files.slice(0, APP_CONFIG.ui.recentGitEntriesVisible).map((entry) => {
                const code = entry.code || entry.stagedStatus || entry.unstagedStatus || "??";
                const isSelected = selectedDiff?.path === entry.path && selectedDiff?.scope === scope;
                const fileName = entry.path.split("/").pop();
                const dirPath = entry.path.slice(0, -(fileName?.length || 0));
                return `
                  <li>
                    <button
                      class="git-file ${isSelected ? "git-file--active" : ""}"
                      data-action="git-select-diff"
                      data-workspace-id="${workspaceId}"
                      data-path="${escapeHtml(entry.path)}"
                      data-scope="${scope}"
                      title="${escapeHtml(statusTooltip(code))}: ${escapeHtml(entry.path)}"
                    >
                      <span class="git-status-code" title="${escapeHtml(statusTooltip(code))}">${escapeHtml(code || "??")}</span>
                      <span class="git-file__name">${dirPath ? `<span class="git-file__dir">${escapeHtml(dirPath)}</span>` : ""}${escapeHtml(fileName)}</span>
                    </button>
                  </li>
                `;
              }).join("")}
            </ul>
          `
          : '<p class="git-card__hint">No files.</p>'
      }
    </section>
  `;
}

function renderWorktreeList(snapshot, workspaces = []) {
  const workspaceIdsByPath = new Map(workspaces.map((workspace) => [String(workspace.cwd || "").toLowerCase(), workspace.id]));
  const siblings = snapshot.siblingWorktrees || [];

  return siblings.length
    ? `
      <ul class="git-sibling-list">
        ${siblings.map((entry) => {
          const targetWorkspaceId = workspaceIdsByPath.get(String(entry.path || "").toLowerCase()) || "";
          const action = targetWorkspaceId && !entry.isCurrent
            ? `<button class="button button--ghost" data-action="activate-workspace" data-workspace-id="${targetWorkspaceId}">Open</button>`
            : "";
          return `
            <li class="${entry.isCurrent ? "git-sibling--current" : ""}">
              <div class="git-sibling__meta">
                <strong>${escapeHtml(entry.branch || "detached")}</strong>
                <small>${escapeHtml(entry.path)}</small>
              </div>
              <div class="git-sibling__badges">
                <span class="workspace-chip"><strong>${entry.isMainWorktree ? "main" : "linked"}</strong> worktree</span>
                <span class="workspace-chip"><strong>${entry.dirty ? escapeHtml(String(entry.dirtyCount || 0)) : "0"}</strong> ${entry.dirty ? "dirty" : "clean"}</span>
                ${entry.isCurrent ? '<span class="workspace-chip workspace-chip--alert"><strong>active</strong></span>' : action}
              </div>
            </li>
          `;
        }).join("")}
      </ul>
    `
    : '<p class="git-card__hint">No sibling worktrees detected.</p>';
}

function renderPendingActionBanner(workspaceId, gitUi = {}) {
  const pending = gitUi.pendingAction;
  if (!pending) {
    return "";
  }

  return `
    <div class="git-operation-banner git-operation-banner--confirm">
      <strong>${escapeHtml(pending.message.split("\n")[0])}</strong>
      ${pending.message.split("\n").slice(1).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      <div class="git-operation-actions">
        <button class="button" data-action="git-confirm-action" data-workspace-id="${workspaceId}">Confirm</button>
        <button class="button button--ghost" data-action="git-cancel-action" data-workspace-id="${workspaceId}">Cancel</button>
      </div>
    </div>
  `;
}

function renderOperationCard(snapshot, workspaceId, gitUi = {}) {
  const operation = snapshot.operationState || {};
  const result = gitUi.lastResult || null;
  const pendingBanner = renderPendingActionBanner(workspaceId, gitUi);

  if (!operation.inProgress && !result && !pendingBanner) {
    return `
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
    ? `
      <div class="git-operation-banner git-operation-banner--warning">
        <strong>${escapeHtml(operation.label || "Git operation in progress")}</strong>
        ${operation.details ? `<p>${escapeHtml(operation.details)}</p>` : ""}
        ${operation.conflicts?.length
          ? `<small>${escapeHtml(operation.conflicts.join(", "))}</small>`
          : ""}
        <div class="git-operation-actions">
          ${operation.canContinue ? `<button class="button" data-action="git-continue" data-workspace-id="${workspaceId}">Continue</button>` : ""}
          ${operation.canAbort ? `<button class="button button--ghost danger" data-action="git-abort" data-workspace-id="${workspaceId}">Abort</button>` : ""}
          <button class="button button--ghost" data-action="open-lazygit" data-workspace-id="${workspaceId}">Open Lazygit</button>
        </div>
      </div>
    `
    : "";

  const resultTone = result?.ok ? "ok" : "error";
  const resultBlock = result
    ? `
      <div class="git-operation-banner git-operation-banner--${resultTone}">
        <div class="section-head">
          <strong>${escapeHtml(result.summary || (result.ok ? "Git action completed." : "Git action failed."))}</strong>
          <button class="button button--ghost" data-action="git-clear-result" data-workspace-id="${workspaceId}">Clear</button>
        </div>
        ${result.warnings?.length
          ? `<ul class="git-inline-list">${result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
          : ""}
        ${result.conflicts?.length
          ? `<p class="git-card__hint">Conflicts: ${escapeHtml(result.conflicts.join(", "))}</p>`
          : ""}
        ${result.rawOutput
          ? `<pre class="git-output">${escapeHtml(result.rawOutput)}</pre>`
          : ""}
      </div>
    `
    : "";

  const heading = pendingBanner
    ? "Confirm action"
    : operation.inProgress ? operation.label : "Last result";

  return `
    <article class="git-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Operation Status</p>
          <h3>${escapeHtml(heading)}</h3>
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

  return `
    <nav class="git-tabs">
      ${tabs.map((tab) => `
        <button
          class="git-tabs__item ${tab.id === activeTab ? "git-tabs__item--active" : ""}"
          data-action="git-switch-tab"
          data-workspace-id="${workspaceId}"
          data-tab="${tab.id}"
        >${escapeHtml(tab.label)}${tab.badge ? ` <span class="git-tabs__badge">${escapeHtml(tab.badge)}</span>` : ""}</button>
      `).join("")}
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
    return `
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Merge Back</p>
            <h3>${escapeHtml(gitSnapshot.branch)} &rarr; ?</h3>
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
    const commitBlock = gitSnapshot.dirty
      ? `
        <p class="git-card__hint">No commits ahead of ${escapeHtml(baseBranch)} yet. Commit your changes first.</p>
        <div class="git-commit-form">
          <input name="commit-message" type="text" value="${escapeHtml(gitSnapshot.branch.replace(/-/g, " "))}" placeholder="Commit message" />
          <button class="button" data-action="git-commit-all" data-workspace-id="${workspaceId}" ${busyAction ? "disabled" : ""}>${busyAction === "commit" ? "Committing..." : "Commit all changes"}</button>
        </div>
        ${dirtyConflicts.length > 0
          ? `<p class="git-card__hint git-card__hint--warning">Warning: ${escapeHtml(String(dirtyConflicts.length))} of your dirty files were also changed on ${escapeHtml(baseBranch)}: ${escapeHtml(dirtyConflicts.slice(0, 5).join(", "))}${dirtyConflicts.length > 5 ? "..." : ""}. Conflicts are likely when merging.</p>`
          : ""
        }
      `
      : `<p class="git-card__hint">Branch is clean and up to date with ${escapeHtml(baseBranch)}. Nothing to merge back.</p>`;

    return `
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Merge Back</p>
            <h3>${escapeHtml(gitSnapshot.branch)} &rarr; ${escapeHtml(baseBranch)}</h3>
          </div>
        </div>
        ${commitBlock}
      </article>
    `;
  }

  const potentialConflicts = compare.potentialConflicts || [];

  return `
    <article class="git-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Merge Back</p>
          <h3>${escapeHtml(gitSnapshot.branch)} &rarr; ${escapeHtml(baseBranch)}</h3>
        </div>
      </div>
      <div class="git-stat-row">
        <span class="workspace-chip"><strong>${escapeHtml(String(compare.aheadCount || 0))}</strong> commits to merge</span>
        <span class="workspace-chip"><strong>${escapeHtml(String(files.length))}</strong> files changed</span>
        ${compare.behindCount > 0 ? `<span class="workspace-chip workspace-chip--alert"><strong>${escapeHtml(String(compare.behindCount))}</strong> behind base</span>` : ""}
      </div>
      ${compare.behindCount > 0
        ? `<p class="git-card__hint git-card__hint--warning">This branch is ${escapeHtml(String(compare.behindCount))} commit(s) behind ${escapeHtml(baseBranch)}. Rebase or merge base first to reduce conflict risk.</p>`
        : ""
      }
      ${files.length
        ? `
          <details class="git-details">
            <summary>Changed files (${escapeHtml(String(files.length))})</summary>
            <ul class="git-file-list">
              ${files.slice(0, 30).map((entry) => {
                const fileName = entry.path.split("/").pop();
                const dirPath = entry.path.slice(0, -(fileName?.length || 0));
                return `
                  <li>
                    <span class="git-file" title="${escapeHtml(entry.code || "M")}: ${escapeHtml(entry.path)}">
                      <span class="git-status-code">${escapeHtml(entry.code || "M")}</span>
                      <span class="git-file__name">${dirPath ? `<span class="git-file__dir">${escapeHtml(dirPath)}</span>` : ""}${escapeHtml(fileName)}</span>
                    </span>
                  </li>
                `;
              }).join("")}
              ${files.length > 30 ? `<li><p class="git-card__hint">... and ${files.length - 30} more files.</p></li>` : ""}
            </ul>
          </details>
        `
        : ""
      }
      ${potentialConflicts.length > 0
        ? `
          <details class="git-details">
            <summary class="git-card__hint--warning">Potential conflicts (${escapeHtml(String(potentialConflicts.length))})</summary>
            <p class="git-card__hint git-card__hint--warning">These files were modified on both your branch and ${escapeHtml(baseBranch)}. Merging may require manual conflict resolution.</p>
            <ul class="git-file-list">
              ${potentialConflicts.slice(0, 30).map((filePath) => {
                const fileName = filePath.split("/").pop();
                const dirPath = filePath.slice(0, -(fileName?.length || 0));
                return `
                  <li>
                    <span class="git-file" title="Potential conflict: ${escapeHtml(filePath)}">
                      <span class="git-status-code">!</span>
                      <span class="git-file__name">${dirPath ? `<span class="git-file__dir">${escapeHtml(dirPath)}</span>` : ""}${escapeHtml(fileName)}</span>
                    </span>
                  </li>
                `;
              }).join("")}
              ${potentialConflicts.length > 30 ? `<li><p class="git-card__hint">... and ${potentialConflicts.length - 30} more files.</p></li>` : ""}
            </ul>
          </details>
        `
        : ""
      }
      <div class="git-operation-actions">
        <button
          class="button"
          data-action="git-merge-into-base"
          data-workspace-id="${workspaceId}"
          data-base-branch="${escapeHtml(baseBranch)}"
          title="Runs: git merge ${escapeHtml(gitSnapshot.branch)} in the ${escapeHtml(baseBranch)} worktree."
        >Merge ${escapeHtml(gitSnapshot.branch)} &rarr; ${escapeHtml(baseBranch)}</button>
        ${mainWorktreeWorkspaceId
          ? `<button class="button button--ghost" data-action="activate-workspace" data-workspace-id="${mainWorktreeWorkspaceId}" title="Switch to ${escapeHtml(baseBranch)} worktree.">Open ${escapeHtml(baseBranch)} worktree</button>`
          : ""
        }
      </div>
      ${gitSnapshot.worktreePath && !gitSnapshot.isMainWorktree
        ? `
          <details class="git-details">
            <summary>After merge: clean up worktree</summary>
            <p class="git-card__hint">Once merged, you can remove this worktree and delete the branch.</p>
            <div class="git-operation-actions">
              <button class="button button--ghost danger" data-action="git-remove-worktree" data-workspace-id="${workspaceId}" data-worktree-path="${escapeHtml(gitSnapshot.worktreePath)}" data-delete-branch="true" title="Removes this worktree directory and deletes the branch.">Remove worktree + delete branch</button>
              <button class="button button--ghost" data-action="git-remove-worktree" data-workspace-id="${workspaceId}" data-worktree-path="${escapeHtml(gitSnapshot.worktreePath)}" data-delete-branch="false" title="Removes the worktree but keeps the branch.">Remove worktree only</button>
            </div>
          </details>
        `
        : ""
      }
    </article>
  `;
}

function renderStatusSection(gitSnapshot, workspaceId, gitUi, workspaces) {
  const baseBranch = gitSnapshot.baseBranch || gitSnapshot.compareWithBase?.baseBranch || "";
  const busyAction = gitUi.busyAction || "";
  const operation = gitSnapshot.operationState || {};
  const canIntegrateWithBase = Boolean(baseBranch);

  return `
    <div class="git-section">
      ${renderOperationCard(gitSnapshot, workspaceId, gitUi)}
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Update Current Branch</p>
            <h3>${escapeHtml(baseBranch || "?")} &rarr; ${escapeHtml(gitSnapshot.branch)}</h3>
          </div>
        </div>
        <div class="git-detail-list">
          <span><strong>Current branch:</strong> ${escapeHtml(gitSnapshot.branch)}</span>
          <span><strong>Base branch (local):</strong> ${escapeHtml(baseBranch || "not detected")}</span>
          <span><strong>Upstream:</strong> ${escapeHtml(gitSnapshot.upstream || "none")}</span>
          <span><strong>Ahead/behind upstream:</strong> ${escapeHtml(String(gitSnapshot.aheadCount || 0))} / ${escapeHtml(String(gitSnapshot.behindCount || 0))}</span>
          <span><strong>Last fetch:</strong> ${escapeHtml(formatDateLabel(gitSnapshot.lastFetchAt))}</span>
        </div>
        ${canIntegrateWithBase
          ? `
            <div class="git-operation-actions">
              <button
                class="button"
                data-action="git-rebase-base"
                data-workspace-id="${workspaceId}"
                data-base-branch="${escapeHtml(baseBranch)}"
                ${busyAction || operation.inProgress ? "disabled" : ""}
                title="Runs: git rebase ${escapeHtml(baseBranch)} (local). Replays your commits on top of the local ${escapeHtml(baseBranch)} branch."
              >${busyAction === "rebase" ? "Rebasing..." : `Rebase onto ${escapeHtml(baseBranch)}`}</button>
              <button
                class="button button--ghost"
                data-action="git-merge-base"
                data-workspace-id="${workspaceId}"
                data-base-branch="${escapeHtml(baseBranch)}"
                ${busyAction || operation.inProgress ? "disabled" : ""}
                title="Runs: git merge ${escapeHtml(baseBranch)} (local). Brings commits from the local ${escapeHtml(baseBranch)} branch into ${escapeHtml(gitSnapshot.branch)}."
              >${busyAction === "merge" ? "Merging..." : `Merge ${escapeHtml(baseBranch)} in`}</button>
            </div>
            <p class="git-card__hint">Operations use the local ${escapeHtml(baseBranch)} branch. Fetch first to sync with remote.</p>
          `
          : '<p class="git-card__hint">Base branch could not be detected automatically for this repository.</p>'
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

  return `
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
              <h3>${escapeHtml(diffPreview?.path || "Select a file")}</h3>
            </div>
          </div>
          ${diffPreview
            ? `
              ${diffPreview.summary ? `<p class="git-card__hint">${escapeHtml(diffPreview.summary)}</p>` : ""}
              <pre class="git-output git-output--preview">${colorizeDiff(diffPreview.diff || "")}</pre>
            `
            : '<p class="git-card__hint">Click a file to load a diff preview.</p>'
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

  return `
    <div class="git-section git-section--history">
      <div class="git-history__header">
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Compare With Base</p>
              <h3>${escapeHtml(baseBranch || "No base branch")}</h3>
            </div>
          </div>
          ${renderDiffStat(compare.diffStat)}
          <div class="git-detail-list">
            <span><strong>Branch commits:</strong> ${escapeHtml(String(compare.aheadCount || 0))}</span>
            <span><strong>Missing from base:</strong> ${escapeHtml(String(compare.behindCount || 0))}</span>
          </div>
        </article>
      </div>
      <div class="git-history__panels">
        <div class="git-history__log">
          ${allCommits.length
            ? `
              <table class="git-log-table">
                <thead>
                  <tr><th>Hash</th><th>Message</th><th>Date</th><th>Author</th></tr>
                </thead>
                <tbody>
                  ${allCommits.map((entry) => `
                    <tr
                      class="${selectedCommit === entry.shortHash ? "git-log-table--active" : ""}"
                      data-action="git-select-commit"
                      data-workspace-id="${workspaceId}"
                      data-hash="${escapeHtml(entry.shortHash)}"
                      title="${escapeHtml(entry.subject)}"
                    >
                      <td class="git-log-table__hash">${escapeHtml(entry.shortHash)}</td>
                      <td class="git-log-table__msg">${escapeHtml(entry.subject)}</td>
                      <td class="git-log-table__date">${escapeHtml(entry.relativeDate)}</td>
                      <td class="git-log-table__author">${escapeHtml(entry.author || "")}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            `
            : '<p class="git-card__hint">No commit history available yet.</p>'
          }
        </div>
        <div class="git-history__detail">
          ${commitDiffPreview
            ? `
              ${commitDiffPreview.summary ? `<p class="git-card__hint">${escapeHtml(commitDiffPreview.summary)}</p>` : ""}
              <pre class="git-output git-output--preview">${colorizeDiff(commitDiffPreview.diff || "")}</pre>
            `
            : '<p class="git-card__hint">Select a commit to view its diff.</p>'
          }
        </div>
      </div>
    </div>
  `;
}

function renderWorktreesSection(gitSnapshot, workspaceId, workspaces) {
  return `
    <div class="git-section">
      <article class="git-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Worktree Context</p>
            <h3>${escapeHtml(gitSnapshot.repository || gitSnapshot.root)}</h3>
          </div>
        </div>
        <p class="git-card__path">${escapeHtml(gitSnapshot.root)}</p>
        <div class="git-detail-list">
          <span><strong>Current branch:</strong> ${escapeHtml(gitSnapshot.branch)}</span>
          <span><strong>Main worktree:</strong> ${escapeHtml(gitSnapshot.mainWorktreePath || gitSnapshot.root)}</span>
          <span><strong>Current path:</strong> ${escapeHtml(gitSnapshot.worktreePath || gitSnapshot.root)}</span>
        </div>
        ${renderWorktreeList(gitSnapshot, workspaces)}
      </article>
    </div>
  `;
}

export function renderGitMarkup(gitSnapshot, workspaceId, gitUi = {}, workspaces = []) {
  if (!gitSnapshot?.available) {
    return `
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

  return `
    <div class="git-view">
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"><strong>${escapeHtml(gitSnapshot.branch)}</strong> branch</span>
          <span class="workspace-chip"><strong>${gitSnapshot.isMainWorktree ? "main" : "linked"}</strong> worktree</span>
          <span class="workspace-chip"><strong>${escapeHtml(String(gitSnapshot.aheadCount || 0))}</strong> ahead</span>
          <span class="workspace-chip"><strong>${escapeHtml(String(gitSnapshot.behindCount || 0))}</strong> behind</span>
          <span class="workspace-chip"><strong>${gitSnapshot.dirty ? escapeHtml(String(gitSnapshot.dirtyCount)) : "0"}</strong> ${gitSnapshot.dirty ? "dirty" : "clean"}</span>
          ${operation.inProgress ? `<span class="workspace-chip workspace-chip--alert"><strong>${escapeHtml(operation.kind)}</strong> in progress</span>` : ""}
        </div>
        <div class="git-view__actions">
          <button class="button button--ghost" data-action="refresh-git" data-workspace-id="${workspaceId}">Refresh</button>
          <button class="button button--ghost" data-action="git-fetch" data-workspace-id="${workspaceId}" ${busyAction ? "disabled" : ""}>${busyAction === "fetch" ? "Fetching..." : "Fetch"}</button>
          <button class="button button--ghost" data-action="create-worktree" data-workspace-id="${workspaceId}">New worktree</button>
          ${gitSnapshot.lazygit?.available
            ? `<button class="button" data-action="open-lazygit" data-workspace-id="${workspaceId}" style="white-space:nowrap;">Open Lazygit</button>`
            : `<button class="button button--ghost" disabled style="white-space:nowrap;border:1px dashed var(--accent);color:var(--accent);opacity:0.9;" title="Install lazygit to enable">Install Lazygit</button>`
          }
        </div>
      </div>
      ${renderTabNav(activeTab, workspaceId, { operation, dirtyCount: gitSnapshot.dirtyCount || 0 })}
      ${sectionContent}
    </div>
  `;
}

export function renderDockerMarkup(dockerState = {}) {
  const containers = dockerState.containers || [];
  const runningCount = containers.filter(isContainerRunning).length;
  const activeContext = currentDockerContext(dockerState.contexts);

  if (!dockerState.available) {
    return `<div class="empty-card"><p>Docker runtime is unavailable.</p><small>${escapeHtml(dockerState.error || "Install Docker CLI on Windows or expose it via WSL.")}</small></div>`;
  }

  const lazydockerInfo = dockerState.lazydocker || {};
  const lazydockerAvailable = lazydockerInfo.available || false;

  return `
    <div class="docker-manager">
      <div class="docker-manager__header">
        <div class="docker-manager__summary">
          <article class="docker-stat">
            <span class="eyebrow">Context</span>
            <strong>${escapeHtml(activeContext?.Name || "n/a")}</strong>
            <small>${escapeHtml(activeContext?.DockerEndpoint || "No context")}</small>
          </article>
          <article class="docker-stat">
            <span class="eyebrow">Containers</span>
            <strong>${containers.length}</strong>
            <small>${runningCount} running</small>
          </article>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${lazydockerAvailable
            ? '<button class="button" data-action="open-lazydocker" style="white-space:nowrap;">Open Lazydocker</button>'
            : '<button class="button button--ghost" disabled style="white-space:nowrap;border:1px dashed var(--accent);color:var(--accent);opacity:0.9;" title="Install lazydocker: winget install JesseDuffield.lazygit or brew install lazydocker">Install Lazydocker</button>'
          }
        </div>
      </div>
      <div class="docker-list">
        ${
          containers.length
            ? containers
                .map((container) => {
                  const running = isContainerRunning(container);
                  return `
                    <article class="docker-card ${running ? "docker-card--running" : ""}">
                      <div class="docker-card__head">
                        <div>
                          <h4>${escapeHtml(container.Names || container.ID)}</h4>
                          <p class="docker-card__meta">${escapeHtml(container.Image || "Unknown image")}</p>
                        </div>
                        <span class="docker-state docker-state--${running ? "running" : "stopped"}">${escapeHtml(container.State || (running ? "running" : "stopped"))}</span>
                      </div>
                      <div class="docker-card__meta">
                        <span>${escapeHtml(container.Status || "Unknown status")}</span>
                        <span>${escapeHtml(container.Ports || "No ports")}</span>
                      </div>
                      <div class="docker-card__actions">
                        <button class="button button--ghost" data-action="docker-shell" data-container-id="${container.ID}" ${running ? "" : "disabled"}>Shell</button>
                        <button class="button button--ghost" data-action="docker-logs" data-container-id="${container.ID}">Logs</button>
                        <button class="button button--ghost" data-action="docker-start" data-container-id="${container.ID}" ${running ? "disabled" : ""}>Start</button>
                        <button class="button button--ghost" data-action="docker-stop" data-container-id="${container.ID}" ${running ? "" : "disabled"}>Stop</button>
                        <button class="button button--ghost" data-action="docker-restart" data-container-id="${container.ID}" ${running ? "" : "disabled"}>Restart</button>
                        <button class="button button--ghost danger" data-action="docker-remove" data-container-id="${container.ID}">Remove</button>
                      </div>
                    </article>
                  `;
                })
                .join("")
            : '<div class="empty-card"><p>No containers found.</p><small>When Docker services appear, you can open logs or attach a shell here.</small></div>'
        }
      </div>
    </div>
  `;
}
