import { html, render } from "lit";

function appShellTemplate({ isRemote = false, sidebarCollapsed = false } = {}) {
  const sidebarLabel = sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";

  return html`
    <div class=${`frame ${isRemote ? "frame--remote" : ""} ${sidebarCollapsed ? "frame--sidebar-collapsed" : ""}`}>
      <div class="sidebar-backdrop" data-role="sidebar-backdrop"></div>
      <aside class="sidebar">
        <div class="sidebar__head">
          <h1 class="brand">str<em>IDE</em>term</h1>
          <div class="sidebar__tools">
            <button type="button" class="sidebar__icon-btn" data-action="new-workspace" title="Add workspace">+</button>
            <button
              type="button"
              class="sidebar__icon-btn sidebar__collapse-btn"
              data-action="toggle-sidebar-collapse"
              data-role="sidebar-collapse"
              title=${sidebarLabel}
              aria-label=${sidebarLabel}
            >${sidebarCollapsed ? "\u25B6" : "\u25C0"}</button>
            <button type="button" class="sidebar__icon-btn" data-action="open-profiles" title="Profiles">\u2630</button>
            <button type="button" class="sidebar__icon-btn" data-action="open-settings" title="Settings">\u2699</button>
            <button type="button" class="sidebar__icon-btn" data-action="open-help" title="Help">?</button>
          </div>
        </div>
        <button type="button" class="profile-bar" data-role="profile-bar" data-action="open-profiles"></button>
        <div class="workspace-list" data-role="workspace-list"></div>
        <section class="remote-access" data-role="remote-access"></section>
        <footer class="sidebar-footer" data-role="sidebar-footer"></footer>
        <div class="sidebar-resize-handle" data-role="sidebar-resize-handle"></div>
      </aside>
      <main class="workspace">
        <section class="workspace-main">
          <section data-role="workspace-hero"></section>
          <div class="terminal-toolbar">
            <button type="button" class="mobile-hamburger" data-action="toggle-sidebar" title="Menu">
              \u2630
              <span class="mobile-hamburger__badge" data-role="hamburger-badge"></span>
            </button>
            <div class="tab-strip" data-role="tab-strip"></div>
            <div class="terminal-toolbar__actions" data-role="tab-actions"></div>
          </div>
          <div class="terminal-stage" data-role="terminal-stage"></div>
        </section>
      </main>
    </div>
  `;
}

export function renderAppShell(container, options = {}) {
  render(appShellTemplate(options), container);
}
