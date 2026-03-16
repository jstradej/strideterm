import { APP_CONFIG } from "../../config/app-config.js";
import { currentDockerContext, escapeHtml, isContainerRunning } from "./helpers.js";

export function renderGitMarkup(gitSnapshot, workspaceId) {
  if (!gitSnapshot?.available) {
    return `
      <div class="terminal-empty">
        <p>Git workspace is unavailable</p>
        <small>This workspace is not inside a Git repository.</small>
      </div>
    `;
  }

  return `
    <div class="git-view">
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"><strong>${escapeHtml(gitSnapshot.branch)}</strong> branch</span>
          <span class="workspace-chip"><strong>${escapeHtml(String(gitSnapshot.commitCount))}</strong> commits</span>
          <span class="workspace-chip"><strong>${gitSnapshot.dirty ? escapeHtml(String(gitSnapshot.dirtyCount)) : "0"}</strong> ${gitSnapshot.dirty ? "dirty" : "clean"}</span>
        </div>
        <div class="git-view__actions" style="margin-left:auto;">
          <button class="button button--ghost" data-action="refresh-git" data-workspace-id="${workspaceId}">Refresh</button>
          ${gitSnapshot.lazygit?.available
            ? `<button class="button" data-action="open-lazygit" data-workspace-id="${workspaceId}" style="white-space:nowrap;">Open Lazygit</button>`
            : `<button class="button button--ghost" disabled style="white-space:nowrap;border:1px dashed var(--accent);color:var(--accent);opacity:0.9;" title="Install lazygit to enable">Install Lazygit</button>`
          }
        </div>
      </div>
      <div class="git-grid">
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Repository</p>
              <h3>${escapeHtml(gitSnapshot.repository || gitSnapshot.root)}</h3>
            </div>
          </div>
          <p class="git-card__path">${escapeHtml(gitSnapshot.root)}</p>
          <p class="git-card__hint">${escapeHtml(gitSnapshot.lazygit?.available ? `Lazygit available via ${gitSnapshot.lazygit.backend}.` : (gitSnapshot.lazygit?.error || "Structured Git data is available even without lazygit."))}</p>
        </article>
        <article class="git-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Working Tree</p>
              <h3>${gitSnapshot.dirty ? "Pending changes" : "Clean state"}</h3>
            </div>
          </div>
          ${
            gitSnapshot.status.length
              ? `
                <ul class="git-list">
                  ${gitSnapshot.status
                    .slice(0, APP_CONFIG.ui.recentGitEntriesVisible)
                    .map((entry) => `<li><span class="git-status-code">${escapeHtml(entry.code)}</span><span>${escapeHtml(entry.path)}</span></li>`)
                    .join("")}
                </ul>
              `
              : '<p class="git-card__hint">No uncommitted changes.</p>'
          }
        </article>
        <article class="git-card git-card--wide">
          <div class="section-head">
            <div>
              <p class="eyebrow">Recent Log</p>
              <h3>Latest commits</h3>
            </div>
          </div>
          ${
            gitSnapshot.log.length
              ? `
                <ul class="git-log">
                  ${gitSnapshot.log
                    .map((entry) => `
                      <li>
                        <div class="git-log__meta">
                          <strong>${escapeHtml(entry.shortHash)}</strong>
                          <span>${escapeHtml(entry.relativeDate)}</span>
                          <span>${escapeHtml(entry.author)}</span>
                        </div>
                        <p>${escapeHtml(entry.subject)}</p>
                        ${entry.refs ? `<small>${escapeHtml(entry.refs)}</small>` : ""}
                      </li>
                    `)
                    .join("")}
                </ul>
              `
              : '<p class="git-card__hint">No commit history available yet.</p>'
          }
        </article>
      </div>
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
