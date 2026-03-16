import { html, nothing, render } from "lit";

function paneHeaderTemplate({
  title,
  status,
  metaClass = "workspace-pane__meta",
  actions = [],
}) {
  return html`
    <header class="workspace-pane__header">
      <div class=${metaClass}>
        <strong>${title}</strong>
        <small>${status}</small>
      </div>
      <div class="workspace-pane__actions">
        ${actions.map((action) => html`
          <button
            class=${action.className}
            data-action=${action.action}
            ?disabled=${!!action.disabled}
            title=${action.title}
            data-view-id=${action.viewId || nothing}
            data-session-id=${action.sessionId || nothing}
          >${action.label}</button>
        `)}
      </div>
    </header>
  `;
}

export function renderPaneShell(container, {
  showHeader,
  title,
  status,
  bodyClass = "workspace-pane__body",
  actions = [],
}) {
  render(html`
    ${showHeader
      ? paneHeaderTemplate({ title, status, actions })
      : nothing}
    <div class=${bodyClass}></div>
  `, container);
}
