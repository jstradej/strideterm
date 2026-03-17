import { html, nothing, svg } from "lit";

function renderLayoutThumb(layout) {
  switch (layout) {
    case "cols":
      return svg`
        <rect x="1" y="1" width="18" height="28" rx="1.5" fill="currentColor" opacity="0.5"></rect>
        <rect x="21" y="1" width="18" height="28" rx="1.5" fill="currentColor" opacity="0.3"></rect>
      `;
    case "rows":
      return svg`
        <rect x="1" y="1" width="38" height="13" rx="1.5" fill="currentColor" opacity="0.5"></rect>
        <rect x="1" y="16" width="38" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
      `;
    case "top-split":
      return svg`
        <rect x="1" y="1" width="38" height="13" rx="1.5" fill="currentColor" opacity="0.5"></rect>
        <rect x="1" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
        <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
      `;
    case "left-split":
      return svg`
        <rect x="1" y="1" width="18" height="28" rx="1.5" fill="currentColor" opacity="0.5"></rect>
        <rect x="21" y="1" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
        <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
      `;
    case "grid":
      return svg`
        <rect x="1" y="1" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.5"></rect>
        <rect x="21" y="1" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
        <rect x="1" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
        <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" opacity="0.3"></rect>
      `;
    default:
      return svg`<rect x="1" y="1" width="38" height="28" rx="1.5" fill="currentColor" opacity="0.5"></rect>`;
  }
}

export function renderTabContextMenu({
  viewId,
  isTerminal,
  hasRenameAction,
  inGroup,
  canAddToSplit,
}) {
  const hasItems = isTerminal || inGroup || canAddToSplit;
  if (!hasItems) {
    return nothing;
  }

  return html`
    ${isTerminal
      ? html`
          <button type="button" class="context-menu__item" data-action="restart-session" data-session-id=${viewId}>\u21BB Restart</button>
          ${hasRenameAction
            ? html`<button type="button" class="context-menu__item" data-action="rename-tab" data-view-id=${viewId}>\u270E Rename tab</button>`
            : nothing}
        `
      : nothing}
    ${inGroup
      ? html`
          ${isTerminal ? html`<div class="context-menu__divider"></div>` : nothing}
          <button type="button" class="context-menu__item" data-action="ctx-remove-from-group" data-view-id=${viewId}>\u2715 Remove from split</button>
          <button type="button" class="context-menu__item context-menu__item--danger" data-action="ctx-disband-group">\u2573 Disband split</button>
        `
      : canAddToSplit
        ? html`
            ${isTerminal ? html`<div class="context-menu__divider"></div>` : nothing}
            <button type="button" class="context-menu__item" data-action="ctx-add-to-group" data-view-id=${viewId}>+ Add to split</button>
          `
        : nothing}
  `;
}

export function renderLayoutPicker({ layouts, currentLayout }) {
  return html`
    <div class="layout-picker__grid">
      ${Object.entries(layouts)
        .filter(([key]) => key !== "solo")
        .map(([key, { label }]) => html`
          <button
            type="button"
            class=${`layout-picker__item ${currentLayout === key ? "layout-picker__item--active" : ""}`}
            data-action="pick-layout"
            data-layout=${key}
            title=${label}
          >
            <svg class="layout-thumb" viewBox="0 0 40 30">${renderLayoutThumb(key)}</svg>
            <span>${label}</span>
          </button>
        `)}
    </div>
  `;
}

export function renderBootstrapErrorCard({ isRemote, message, remoteToken = "" }) {
  return html`
    <section class="boot-card">
      <p class="eyebrow">${isRemote ? "Remote Access" : "Startup Error"}</p>
      <h1>strIDEterm could not load the workspace</h1>
      <p class="boot-copy">${message}</p>
      ${isRemote
        ? html`
            <form class="boot-form" data-role="remote-auth-form">
              <label>
                <span>Access token</span>
                <input name="token" .value=${remoteToken} placeholder="Paste the strIDEterm token" />
              </label>
              <button type="submit" class="button">Connect</button>
            </form>
          `
        : html`<button type="button" class="button" data-action="retry-bootstrap">Retry</button>`}
    </section>
  `;
}
