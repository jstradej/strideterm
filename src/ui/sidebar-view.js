import { html, render } from "lit";
import { repeat } from "lit/directives/repeat.js";

const SIDEBAR_ICONS = {
  attention: "\u{1F514}",
  createWorktree: "\u{1F33F}",
  edit: "\u270E",
  delete: "\u2715",
};

function workspaceCardTemplate(workspace) {
  return html`
    <div
      class=${`workspace-card ${workspace.active ? "workspace-card--active" : ""} ${workspace.attentionCount ? "workspace-card--attention" : ""} ${workspace.attentionFresh ? "workspace-card--attention-fresh" : ""} ${workspace.isWorktree ? "workspace-card--worktree" : ""}`}
      data-action="activate-workspace"
      data-workspace-id=${workspace.id}
      draggable="true"
      style=${`--accent:${workspace.color}`}
      title=${workspace.title}
    >
      <span class="workspace-card__badge"><span class="workspace-card__index">${workspace.index}</span>${workspace.icon}</span>
      <span class="workspace-card__meta">
        <span class="workspace-card__title-row">
          <strong>${workspace.name}</strong>
          ${workspace.attentionCount
            ? html`<span class="workspace-card__attention" title=${workspace.attentionTooltip}>${SIDEBAR_ICONS.attention}<span class="workspace-card__attention-count">${workspace.attentionCount}</span></span>`
            : null}
        </span>
        <small>${workspace.summary}</small>
      </span>
      ${workspace.active ? html`
        <span class="workspace-card__actions">
          ${workspace.gitAvailable ? html`<button class="workspace-card__action" data-action="create-worktree" data-workspace-id=${workspace.id} title="New worktree">${SIDEBAR_ICONS.createWorktree}</button>` : null}
          <button class="workspace-card__action" data-action="edit-workspace" data-workspace-id=${workspace.id} title="Edit">${SIDEBAR_ICONS.edit}</button>
          <button class="workspace-card__action workspace-card__action--danger" data-action="delete-workspace" data-workspace-id=${workspace.id} title="Delete">${SIDEBAR_ICONS.delete}</button>
        </span>
      ` : null}
    </div>
  `;
}

function pluginSuggestionTemplate(plugin) {
  return html`
    <button
      class="workspace-suggestion"
      data-action="add-plugin-workspace"
      data-plugin-id=${plugin.id}
      style=${`--accent:${plugin.color}`}
      title=${`Add ${plugin.name}`}
    >
      <span class="workspace-card__badge" style=${`background:color-mix(in srgb, ${plugin.color}, transparent 76%);`}>${plugin.icon}</span>
      <span class="workspace-suggestion__meta">
        <strong>${plugin.name}</strong>
        <small>Click to add</small>
      </span>
    </button>
  `;
}

export function renderSidebarList(container, { workspaces, suggestions }) {
  render(html`
    ${repeat(workspaces, (workspace) => workspace.id, workspaceCardTemplate)}
    ${suggestions.length ? html`
      <div class="workspace-suggestions">
        <p class="eyebrow workspace-suggestions__title">Available plugins</p>
        ${repeat(suggestions, (plugin) => plugin.id, pluginSuggestionTemplate)}
      </div>
    ` : null}
  `, container);
}

export function renderSidebarFooter(container, { appVersion = "", repositoryUrl = "" } = {}) {
  const versionLabel = appVersion ? `v${appVersion}` : "Version unavailable";
  const hasRepositoryLink = typeof repositoryUrl === "string" && repositoryUrl.length > 0;

  render(html`
    <div class="sidebar-footer__card">
      <div class="sidebar-footer__meta">
        <span class="eyebrow">App</span>
        <strong class="sidebar-footer__version">${versionLabel}</strong>
      </div>
      ${hasRepositoryLink ? html`
        <button
          class="sidebar-footer__repo"
          type="button"
          data-action="open-repository-link"
          data-url=${repositoryUrl}
          title=${repositoryUrl}
        >
          GitHub repo
        </button>
      ` : null}
    </div>
  `, container);
}
