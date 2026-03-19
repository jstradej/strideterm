import { html, nothing, render } from "lit";
import { APP_CONFIG } from "../../config/app-config.js";
import { cloneWorkspace, createEmptyWorkspace } from "../workspace-state.js";
import { escapeHtml, safeColor } from "./helpers.js";

const BADGE_ICONS = [
  // Dev
  "\u{1F4BB}", "\u{2328}", "\u{1F527}", "\u2699", "\u{1F6E0}", "\u{1F4E6}", "\u{1F528}",
  // Code
  "\u{1F5A5}", "\u{1F4C4}", "\u{1F4DD}", "\u{270F}", "\u{2702}",
  // Git/VCS
  "\u{1F33F}", "\u{1F500}", "\u{1F4CB}",
  // Docker/Infra
  "\u{1F433}", "\u{1F3D7}", "\u{2601}",
  // Web/API
  "\u{1F310}", "\u{1F50C}", "\u{1F4E1}", "\u{1F680}",
  // Data
  "\u{1F5C4}", "\u{1F4BE}", "\u{1F4CA}", "\u{1F4C8}",
  // Testing
  "\u{1F9EA}", "\u2705", "\u{1F50D}", "\u{1F41B}",
  // AI
  "\u{1F916}", "\u{1F9E0}", "\u2728",
  // General
  "\u26A1", "\u{1F3AF}", "\u{1F512}", "\u{1F511}", "\u{1F4C1}", "\u{1F4A1}", "\u2B50", "\u{1F3A8}", "\u{1F525}", "\u{1F48E}",
  "\u{2764}", "\u{1F4AC}", "\u{1F514}", "\u{1F6A9}", "\u{1F5D1}",
];

const DEFAULT_TAB_TEMPLATES = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
  { title: "Claude Code", command: "claude", icon: "\u{1F916}" },
  { title: "Browser", command: "https://", icon: "\u{1F310}" },
];

function renderInto(container, template) {
  render(template, container);
}

function panelIconValue(title) {
  const match = title.match(/^([\p{Emoji}\p{S}])\s*/u);
  return match ? match[1] : "";
}

function panelCardTemplate({ panel, index, isDockerWorkspace }) {
  const currentIcon = panelIconValue(panel.title);
  return html`
    <article class="panel-card" data-panel-id=${panel.id}>
      <div class="panel-card__header">
        <strong>Tab ${index + 1}</strong>
        ${isDockerWorkspace
          ? html`<span class="panel-card__meta">${panel.startup || APP_CONFIG.ui.manualPanelStartup}</span>`
          : html`<button type="button" class="button button--ghost" data-action="remove-panel" data-panel-id=${panel.id}>Remove</button>`}
      </div>
      <label>
        <span>Title</span>
        <div style="display:flex;gap:4px;align-items:stretch;">
          ${isDockerWorkspace ? nothing : html`
            <button type="button" data-action="toggle-panel-icon-picker" data-panel-id=${panel.id}
              style="width:36px;flex-shrink:0;display:grid;place-items:center;border:1px solid var(--border);border-radius:3px;background:rgba(255,255,255,0.04);cursor:pointer;font-size:16px;padding:0;"
              title="Pick icon">${currentIcon || "\u{1F4BB}"}</button>
          `}
          <input name="panel-title" data-panel-id=${panel.id} .value=${panel.title} ?readonly=${isDockerWorkspace} maxlength="60" style="flex:1;min-width:0;" />
        </div>
      </label>
      <div class="panel-icon-dropdown" data-role="panel-icon-dropdown-${panel.id}" style="display:none;flex-wrap:wrap;gap:3px;padding:6px;margin:-4px 0 4px;border:1px solid var(--border);border-radius:4px;background:var(--panel);">
        ${BADGE_ICONS.map((icon) => html`
          <button type="button" style="width:28px;height:28px;display:grid;place-items:center;border:1px solid var(--border);border-radius:3px;background:rgba(255,255,255,0.04);cursor:pointer;font-size:14px;padding:0;" data-action="pick-panel-icon" data-panel-id=${panel.id} data-icon=${icon}>${icon}</button>
        `)}
      </div>
      <label>
        <span>Command</span>
        <input name="panel-command" data-panel-id=${panel.id} .value=${panel.command} placeholder="optional boot command" ?readonly=${isDockerWorkspace} maxlength="500" />
      </label>
    </article>
  `;
}

export function createWorkspaceDialog({ workspace = null, api = null, tabTemplates = null, onCancel, onSubmit }) {
  const resolvedTemplates = Array.isArray(tabTemplates) && tabTemplates.length ? tabTemplates : DEFAULT_TAB_TEMPLATES;
  const draft = workspace ? cloneWorkspace(workspace) : createEmptyWorkspace();
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  function isDockerWorkspace() {
    return draft.kind === "docker";
  }

  function isAzureWorkspace() {
    return draft.kind === "azure";
  }

  function renderPanels() {
    const panelList = overlay.querySelector(".panel-list");
    if (!panelList) {
      return;
    }
    renderInto(panelList, html`${draft.panels.map((panel, index) => panelCardTemplate({ panel, index, isDockerWorkspace: isDockerWorkspace() }))}`);
  }

  function renderContent() {
    renderInto(overlay, html`
      <div class="dialog">
        <div class="dialog__header">
          <div>
            <p class="eyebrow">Workspace</p>
            <h2>${workspace ? "Edit workspace" : "Add workspace"}</h2>
          </div>
          <button type="button" class="button button--ghost" data-action="cancel">Close</button>
        </div>
        <form class="form">
          <label>
            <span>${isAzureWorkspace() ? "Review checkout root" : "Working directory"}</span>
            <div class="input-with-action">
              <input name="cwd" .value=${draft.cwd} placeholder=${APP_CONFIG.ui.defaultProjectCwdPlaceholder} maxlength="500" />
              ${api?.browseDirectory
                ? html`<button type="button" class="button button--ghost input-with-action__btn" data-action="browse-cwd">Browse</button>`
                : nothing}
            </div>
          </label>
          <label>
            <span>Name</span>
            <input name="name" .value=${draft.name} required maxlength="60" />
          </label>
          <div class="grid">
            <label>
              <span>Badge</span>
              <input name="icon" .value=${draft.icon} maxlength="4" />
              <div class="icon-picker" style="display:grid;grid-template-columns:repeat(auto-fill,32px);gap:4px;max-height:120px;overflow-y:auto;margin-top:6px;padding:4px;border:1px solid var(--border);border-radius:4px;background:rgba(255,255,255,0.02);">
                ${BADGE_ICONS.map((icon) => html`<button type="button" class="button button--ghost" data-action="pick-badge-icon" data-icon=${icon} style="padding:0;width:32px;height:32px;font-size:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:3px;">${icon}</button>`)}
              </div>
            </label>
            <label>
              <span>Accent</span>
              <div style="display:flex;gap:6px;align-items:center;">
                <input name="color" type="color" .value=${safeColor(draft.color)} style="width:48px;height:36px;padding:2px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:transparent;" />
                <span data-role="color-preview" style=${`flex:1;height:36px;border-radius:3px;border:1px solid var(--border);background:${safeColor(draft.color)};`}></span>
              </div>
            </label>
          </div>
          <label>
            <span>Notes</span>
            <textarea name="notes" rows="3" placeholder="What belongs in this workspace?" maxlength="500">${draft.notes}</textarea>
          </label>
          ${isDockerWorkspace()
            ? html`<p style="color:var(--muted);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:10px;">Docker tabs (shells, logs) are created from the Docker manager inside the workspace. No manual tab setup needed.</p>`
            : html`
                ${isAzureWorkspace()
                  ? html`<p style="color:var(--muted);font-size:13px;border:1px solid var(--border);border-radius:4px;padding:10px;">This workspace is the Azure DevOps parent. Its checkout root is used for managed review checkouts, and these tabs are copied into each new review subworkspace.</p>`
                  : nothing}
                <section class="panel-editor">
                  <div class="section-head">
                    <div>
                      <p class="eyebrow">Panels</p>
                      <h3>${isAzureWorkspace() ? "Review workspace tabs" : "Terminal tabs"}</h3>
                    </div>
                  </div>
                  <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">
                    ${resolvedTemplates.map((tmpl) => html`<button type="button" class="button button--ghost" data-action="add-panel-template" data-tmpl-title=${tmpl.title} data-tmpl-command=${tmpl.command} data-tmpl-icon=${tmpl.icon} style="font-size:12px;padding:4px 8px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;">${tmpl.icon} ${tmpl.title}</button>`)}
                    <button type="button" class="button button--ghost" data-action="add-panel" style="font-size:12px;padding:4px 8px;cursor:pointer;">+ Custom</button>
                  </div>
                  <div class="panel-list"></div>
                </section>
              `}
          <footer class="dialog__footer">
            <button type="button" class="button button--ghost" data-action="cancel">Cancel</button>
            <button type="submit" class="button">Save workspace</button>
          </footer>
        </form>
      </div>
    `);

    const colorInput = overlay.querySelector('[name="color"]');
    const colorPreview = overlay.querySelector('[data-role="color-preview"]');
    if (colorInput && colorPreview) {
      colorInput.addEventListener("input", () => {
        colorPreview.style.background = colorInput.value;
      }, { once: true });
    }
    renderPanels();
  }

  function readDraft() {
    const form = overlay.querySelector("form");
    draft.name = form.elements.name.value.trim();
    draft.icon = form.elements.icon.value.trim() || APP_CONFIG.ui.defaultProjectIcon;
    draft.color = form.elements.color.value;
    draft.cwd = form.elements.cwd.value.trim();
    draft.notes = form.elements.notes.value.trim();
    if (!isDockerWorkspace()) {
      draft.panels = draft.panels.map((panel) => ({
        ...panel,
        title: form.querySelector(`[name="panel-title"][data-panel-id="${panel.id}"]`)?.value?.trim() || APP_CONFIG.ui.defaultPanelTitle,
        command: form.querySelector(`[name="panel-command"][data-panel-id="${panel.id}"]`)?.value?.trim() || "",
        startup: panel.startup || APP_CONFIG.ui.manualPanelStartup,
      }));
      if (draft.panels.length === 0) {
        const panelId = `panel-${crypto.randomUUID()}`;
        draft.panels.push({ id: panelId, title: APP_CONFIG.ui.defaultPanelTitle, command: "", shell: true, startup: APP_CONFIG.ui.defaultPanelStartup });
      }
      draft.panels = draft.panels.map((panel) => ({
        ...panel,
        startup: APP_CONFIG.ui.defaultPanelStartup,
      }));
    }
    if (!draft.panels.some((panel) => panel.id === draft.activePanelId)) {
      draft.activePanelId = draft.panels[0]?.id || null;
    }
    return draft;
  }

  overlay.addEventListener("click", (event) => {
    // Only close on click directly on the backdrop, not bubbled from inside dialog
    if (event.target === overlay) {
      onCancel();
      return;
    }
    const actionElement = event.target.closest("[data-action]");
    const action = actionElement?.dataset.action;
    if (!action) {
      return;
    }
    if (action === "cancel") {
      onCancel();
      return;
    }
    if (action === "browse-cwd" && api?.browseDirectory) {
      const cwdInput = overlay.querySelector('[name="cwd"]');
      api.browseDirectory(cwdInput?.value || "").then((selected) => {
        if (selected && cwdInput) {
          cwdInput.value = selected;
          // Auto-fill name from directory if name is empty or default
          const nameInput = overlay.querySelector('[name="name"]');
          if (nameInput && (!nameInput.value.trim() || nameInput.value === APP_CONFIG.ui.defaultPanelTitle)) {
            const dirName = selected.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
            if (dirName) nameInput.value = dirName;
          }
        }
      });
      return;
    }
    if (action === "pick-badge-icon") {
      const iconInput = overlay.querySelector('[name="icon"]');
      if (iconInput) {
        iconInput.value = actionElement.dataset.icon;
      }
      return;
    }
    if (action === "toggle-panel-icon-picker") {
      const panelId = actionElement.dataset.panelId;
      const dropdown = overlay.querySelector(`[data-role="panel-icon-dropdown-${panelId}"]`);
      if (dropdown) {
        dropdown.style.display = dropdown.style.display === "none" ? "flex" : "none";
      }
      return;
    }
    if (action === "pick-panel-icon") {
      const panelId = actionElement.dataset.panelId;
      const titleInput = overlay.querySelector(`[name="panel-title"][data-panel-id="${panelId}"]`);
      if (titleInput) {
        titleInput.value = actionElement.dataset.icon + " " + titleInput.value.replace(/^[\p{Emoji}\p{S}]\s*/u, "");
      }
      const dropdown = overlay.querySelector(`[data-role="panel-icon-dropdown-${panelId}"]`);
      if (dropdown) {
        dropdown.style.display = "none";
      }
      const toggleBtn = overlay.querySelector(`[data-action="toggle-panel-icon-picker"][data-panel-id="${panelId}"]`);
      if (toggleBtn) {
        toggleBtn.textContent = actionElement.dataset.icon;
      }
      return;
    }
    if (action === "add-panel-template") {
      if (isDockerWorkspace()) {
        return;
      }
      readDraft();
      const tmplIcon = actionElement.dataset.tmplIcon || "";
      const tmplTitle = actionElement.dataset.tmplTitle || APP_CONFIG.ui.newPanelTitle;
      draft.panels.push({
        id: `panel-${crypto.randomUUID()}`,
        title: tmplIcon ? `${tmplIcon} ${tmplTitle}` : tmplTitle,
        command: actionElement.dataset.tmplCommand || "",
        shell: true,
        startup: APP_CONFIG.ui.manualPanelStartup,
      });
      renderPanels();
      return;
    }
    if (action === "add-panel") {
      if (isDockerWorkspace()) {
        return;
      }
      readDraft();
      draft.panels.push({ id: `panel-${crypto.randomUUID()}`, title: APP_CONFIG.ui.newPanelTitle, command: "", shell: true, startup: APP_CONFIG.ui.manualPanelStartup });
      renderPanels();
      return;
    }
    if (action === "remove-panel") {
      if (isDockerWorkspace()) {
        return;
      }
      readDraft();
      draft.panels = draft.panels.filter((panel) => panel.id !== actionElement.dataset.panelId);
      if (!draft.panels.some((panel) => panel.id === draft.activePanelId)) {
        draft.activePanelId = draft.panels[0]?.id || null;
      }
      renderPanels();
    }
  });

  overlay.addEventListener("input", (event) => {
    if (event.target.matches('[name="color"]')) {
      const colorPreview = overlay.querySelector('[data-role="color-preview"]');
      if (colorPreview) {
        colorPreview.style.background = event.target.value;
      }
    }
  });

  overlay.addEventListener("change", (event) => {
    if (event.target.matches('[name="cwd"]')) {
      const nameInput = overlay.querySelector('[name="name"]');
      const value = event.target.value.trim();
      if (nameInput && !nameInput.value.trim() && value) {
        const dirName = value.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
        if (dirName) nameInput.value = dirName;
      }
    }
  });

  overlay.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit(readDraft());
  });

  renderContent();
  return overlay;
}

export function createSettingsDialog({ settings, tabTemplates = [], appVersion = "", repositoryUrl = "", api = null, onCancel, onSave }) {
  let selectedTheme = settings.theme || "dark";
  let cloudflaredPath = settings.remoteAccess?.cloudflaredPath || "";
  let activeTab = "general";
  let templates = (Array.isArray(tabTemplates) ? tabTemplates : []).map((t) => ({ ...t }));
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  const inputStyle = "width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:3px;background:rgba(255,255,255,0.04);color:inherit;font:inherit;font-size:13px;box-sizing:border-box;";

  function readTemplatesFromDom() {
    templates = templates.map((tmpl, i) => {
      const titleInput = overlay.querySelector(`[name="tmpl-title-${i}"]`);
      const commandInput = overlay.querySelector(`[name="tmpl-command-${i}"]`);
      return {
        ...tmpl,
        title: titleInput ? titleInput.value.trim() : tmpl.title,
        command: commandInput ? commandInput.value.trim() : tmpl.command,
      };
    });
  }

  function renderContent() {
    const themeOptions = ["dark", "light", "system"];
    renderInto(overlay, html`
      <div class="dialog" style="width:min(540px,100%);height:min(600px,80vh);display:flex;flex-direction:column;">
        <div class="dialog__header">
          <div>
            <p class="eyebrow">Application</p>
            <h2>Settings</h2>
          </div>
          <button type="button" class="button button--ghost" data-action="cancel">Close</button>
        </div>
        <div style="display:flex;gap:2px;margin:12px 0 16px;padding:3px;border-radius:6px;background:rgba(255,255,255,0.04);">
          ${["general", "templates", "about"].map((tab) => {
            const label = tab === "general" ? "General" : tab === "templates" ? "Tab Templates" : "About";
            const isActive = activeTab === tab;
            return html`<button data-action="settings-tab" data-tab=${tab} style=${`flex:1;padding:7px 12px;border:none;border-radius:4px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:background 0.12s,color 0.12s;${isActive ? "background:var(--accent);color:#000;" : "background:transparent;color:var(--muted);"}`}>${label}</button>`;
          })}
        </div>
        ${activeTab === "general" ? html`
          <div style="flex:1;overflow-y:auto;display:grid;gap:16px;align-content:start;">
            <div>
              <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);display:block;margin-bottom:6px;">Theme</span>
              <div style="display:flex;gap:4px;">
                ${themeOptions.map((theme) => html`
                  <button type="button" class=${`button ${selectedTheme === theme ? "button--active" : "button--ghost"}`} data-action="pick-theme" data-theme=${theme} style="flex:1;text-transform:capitalize;">${theme}</button>
                `)}
              </div>
            </div>
            <div>
              <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);display:block;margin-bottom:6px;">Cloudflared binary</span>
              <div class="input-with-action">
                <input name="cloudflared-path" .value=${cloudflaredPath} placeholder="Leave empty to use PATH" style="padding:6px 10px;" />
                ${api?.browseFile ? html`<button type="button" class="button button--ghost input-with-action__btn" data-action="browse-cloudflared">Browse</button>` : nothing}
              </div>
              <small style="color:var(--muted);font-size:12px;margin-top:4px;display:block;">Used for Cloudflare Quick Tunnel detection and launch.</small>
            </div>
          </div>
        ` : nothing}
        ${activeTab === "templates" ? html`
          <div class="form" style="flex:1;overflow-y:auto;">
            <p style="color:var(--muted);font-size:13px;margin-bottom:8px;">These templates appear when adding tabs to workspaces and in the quick-add (+) dropdown.</p>
            <div style="display:grid;gap:8px;">
              ${templates.map((tmpl, i) => html`
                <div style="display:grid;grid-template-columns:40px 1fr 1fr auto;gap:6px;align-items:center;padding:6px;border:1px solid var(--border);border-radius:4px;">
                  <span style="font-size:20px;text-align:center;">${tmpl.icon}</span>
                  <input name="tmpl-title-${i}" .value=${tmpl.title} placeholder="Title" maxlength="40" style=${inputStyle} />
                  <input name="tmpl-command-${i}" .value=${tmpl.command} placeholder="Command" maxlength="500" style=${inputStyle} />
                  <button data-action="remove-template" data-index=${i} style="color:var(--danger);background:none;border:1px solid var(--border);border-radius:3px;width:28px;height:28px;cursor:pointer;font-size:16px;display:grid;place-items:center;">&times;</button>
                </div>
              `)}
              <button data-action="add-template" class="button button--ghost" style="justify-self:start;">+ Add template</button>
            </div>
          </div>
        ` : nothing}
        ${activeTab === "about" ? html`
          <div style="flex:1;overflow-y:auto;text-align:center;padding:24px 0;">
            <h1 style="font-size:28px;">str<em style="color:var(--accent);font-style:normal;">IDE</em>term</h1>
            <p style="color:var(--muted);margin:8px 0;">Multi-workspace terminal hub for developers</p>
            <p style="font-size:13px;color:var(--muted);">Version ${appVersion}</p>
            <p style="margin-top:16px;">
              ${repositoryUrl ? html`<a href="#" data-action="open-about-link" data-url=${repositoryUrl} style="color:var(--accent);">GitHub Repository</a>` : nothing}
            </p>
          </div>
        ` : nothing}
        <footer class="dialog__footer" style="flex-shrink:0;padding-top:12px;border-top:1px solid var(--border);margin-top:auto;">
          <button type="button" class="button button--ghost" data-action="cancel">Cancel</button>
          <button type="button" class="button" data-action="save-settings">Save</button>
        </footer>
      </div>
    `);
  }

  overlay.addEventListener("click", (event) => {
    const element = event.target.closest("[data-action]");
    const action = element?.dataset.action;
    if (!action) {
      if (event.target === overlay) {
        onCancel();
      }
      return;
    }
    if (action === "cancel") {
      onCancel();
      return;
    }
    if (action === "settings-tab") {
      if (activeTab === "templates") {
        readTemplatesFromDom();
      }
      if (activeTab === "general") {
        cloudflaredPath = overlay.querySelector('[name="cloudflared-path"]')?.value?.trim() || cloudflaredPath;
      }
      activeTab = element.dataset.tab;
      renderContent();
      return;
    }
    if (action === "pick-theme") {
      selectedTheme = element.dataset.theme;
      renderContent();
      return;
    }
    if (action === "browse-cloudflared" && api?.browseFile) {
      api.browseFile({ defaultPath: cloudflaredPath }).then((selected) => {
        if (selected) {
          cloudflaredPath = selected;
          const input = overlay.querySelector('[name="cloudflared-path"]');
          if (input) input.value = selected;
        }
      });
      return;
    }
    if (action === "remove-template") {
      readTemplatesFromDom();
      const index = parseInt(element.dataset.index, 10);
      templates.splice(index, 1);
      renderContent();
      return;
    }
    if (action === "add-template") {
      readTemplatesFromDom();
      templates.push({ id: `tmpl-${Date.now()}`, title: "", command: "", icon: "\u{1F4BB}" });
      renderContent();
      return;
    }
    if (action === "open-about-link") {
      const url = String(element.dataset.url || "").trim();
      if (url) {
        window.open(url, "_blank");
      }
      return;
    }
    if (action === "save-settings") {
      if (activeTab === "general") {
        cloudflaredPath = overlay.querySelector('[name="cloudflared-path"]')?.value?.trim() || "";
      }
      if (activeTab === "templates") {
        readTemplatesFromDom();
      }
      onSave({
        theme: selectedTheme,
        remoteAccess: {
          cloudflaredPath,
        },
        tabTemplates: templates.filter((t) => t.title || t.command),
      });
    }
  });

  renderContent();
  return overlay;
}

export function createAzureConnectionDialog({
  connection = null,
  defaultReviewRoot = "",
  api = null,
  onCancel,
  onSave,
}) {
  const draft = {
    id: connection?.id || "",
    label: connection?.label || "",
    orgUrl: connection?.orgUrl || "",
    login: connection?.login || "",
    pat: "",
    reviewRoot: connection?.reviewRoot || defaultReviewRoot || "",
    projectFilters: (connection?.projectFilters || []).join(", "),
    repositoryFilters: (connection?.repositoryFilters || []).join(", "),
    pollSeconds: connection?.pollSeconds || 120,
    enabled: connection?.enabled !== false,
  };
  let verification = null;
  let errorMessage = "";
  let busy = false;
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  function renderContent() {
    renderInto(overlay, html`
      <div class="dialog" style="width:min(680px,100%);">
        <div class="dialog__header">
          <div>
            <p class="eyebrow">Azure DevOps</p>
            <h2>${connection ? "Edit connection" : "Add connection"}</h2>
          </div>
          <button type="button" class="button button--ghost" data-action="cancel">Close</button>
        </div>
        <form class="form">
          <div class="grid">
            <label>
              <span>Label</span>
              <input name="label" .value=${draft.label} required maxlength="60" />
            </label>
            <label>
              <span>Poll seconds</span>
              <input name="poll-seconds" type="number" min="15" max="3600" .value=${String(draft.pollSeconds || 120)} />
            </label>
          </div>
          <label>
            <span>Organization URL</span>
            <input name="org-url" .value=${draft.orgUrl} placeholder="https://dev.azure.com/your-org" required maxlength="300" />
            <small style="color:var(--muted);font-size:12px;">A project or repository page URL also works. The app will normalize it.</small>
          </label>
          <div class="grid">
            <label>
              <span>Login / UPN</span>
              <input name="login" .value=${draft.login} placeholder="me@company.com" required maxlength="200" />
            </label>
            <label>
              <span>PAT ${connection ? "(leave empty to keep current token)" : ""}</span>
              <input name="pat" type="password" .value=${draft.pat} placeholder="Personal Access Token" maxlength="300" />
            </label>
          </div>
          <label>
            <span>Review checkout root</span>
            <div class="input-with-action">
              <input name="review-root" .value=${draft.reviewRoot} placeholder="C:/Users/me/.strideterm/azure-pr" maxlength="500" />
              ${api?.browseDirectory
                ? html`<button type="button" class="button button--ghost input-with-action__btn" data-action="browse-review-root">Browse</button>`
                : nothing}
            </div>
          </label>
          <div class="grid">
            <label>
              <span>Project filters</span>
              <input name="project-filters" .value=${draft.projectFilters} placeholder="Platform, Mobile" maxlength="500" />
              <small style="color:var(--muted);font-size:12px;">Comma-separated project ids or names.</small>
            </label>
            <label>
              <span>Repository filters</span>
              <input name="repository-filters" .value=${draft.repositoryFilters} placeholder="web-app, api" maxlength="500" />
              <small style="color:var(--muted);font-size:12px;">Optional repo ids or names.</small>
            </label>
          </div>
          <label style="display:flex;align-items:center;gap:8px;">
            <input name="enabled" type="checkbox" ?checked=${draft.enabled} />
            <span>Enable polling for this connection</span>
          </label>
          ${errorMessage ? html`<p style="margin:0;color:var(--danger);">${errorMessage}</p>` : nothing}
          ${verification ? html`
            <div style="border:1px solid var(--border);border-radius:6px;padding:12px;background:rgba(255,255,255,0.03);display:grid;gap:6px;">
              <strong>Connection verified</strong>
              <small style="color:var(--muted);">${verification.projectCount} projects available.</small>
              <div style="display:flex;flex-wrap:wrap;gap:6px;">
                ${verification.projects.slice(0, 8).map((project) => html`<span class="workspace-chip">${project.name}</span>`)}
              </div>
            </div>
          ` : nothing}
          <footer class="dialog__footer">
            <button type="button" class="button button--ghost" data-action="cancel">Cancel</button>
            <button type="button" class="button button--ghost" data-action="test-connection" ?disabled=${busy}>Test connection</button>
            <button type="submit" class="button" ?disabled=${busy}>Save connection</button>
          </footer>
        </form>
      </div>
    `);
  }

  function readDraft() {
    const form = overlay.querySelector("form");
    draft.label = form.elements.label.value.trim();
    draft.orgUrl = form.elements["org-url"].value.trim();
    draft.login = form.elements.login.value.trim();
    draft.pat = form.elements.pat.value.trim();
    draft.reviewRoot = form.elements["review-root"].value.trim();
    draft.projectFilters = form.elements["project-filters"].value.trim();
    draft.repositoryFilters = form.elements["repository-filters"].value.trim();
    draft.pollSeconds = Number.parseInt(form.elements["poll-seconds"].value, 10) || 120;
    draft.enabled = form.elements.enabled.checked;
    return {
      id: draft.id,
      label: draft.label,
      orgUrl: draft.orgUrl,
      login: draft.login,
      pat: draft.pat,
      reviewRoot: draft.reviewRoot,
      enabled: draft.enabled,
      pollSeconds: draft.pollSeconds,
      projectFilters: draft.projectFilters.split(",").map((value) => value.trim()).filter(Boolean),
      repositoryFilters: draft.repositoryFilters.split(",").map((value) => value.trim()).filter(Boolean),
    };
  }

  overlay.addEventListener("click", async (event) => {
    const element = event.target.closest("[data-action]");
    const action = element?.dataset.action;
    if (!action) {
      if (event.target === overlay) {
        onCancel();
      }
      return;
    }
    if (action === "cancel") {
      onCancel();
      return;
    }
    if (action === "browse-review-root" && api?.browseDirectory) {
      const selected = await api.browseDirectory(draft.reviewRoot || defaultReviewRoot || "");
      if (selected) {
        draft.reviewRoot = selected;
        overlay.querySelector('[name="review-root"]').value = selected;
      }
      return;
    }
    if (action === "test-connection") {
      busy = true;
      errorMessage = "";
      verification = null;
      renderContent();
      try {
        verification = await api.verifyAzureConnection(readDraft());
      } catch (error) {
        errorMessage = error?.message || "Azure DevOps connection test failed.";
      } finally {
        busy = false;
        renderContent();
      }
    }
  });

  overlay.addEventListener("submit", async (event) => {
    event.preventDefault();
    busy = true;
    errorMessage = "";
    renderContent();
    try {
      await onSave(readDraft());
    } catch (error) {
      errorMessage = error?.message || "Saving Azure DevOps connection failed.";
      busy = false;
      renderContent();
    }
  });

  renderContent();
  return overlay;
}

export function createTextAreaDialog({
  eyebrow = "Workspace",
  title,
  label,
  value = "",
  placeholder = "",
  submitLabel = "Save",
  secondarySubmitLabel = "",
  onCancel,
  onSubmit,
  onSecondarySubmit,
}) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  renderInto(overlay, html`
    <div class="dialog" style="width:min(560px,100%);">
      <div class="dialog__header">
        <div>
          <p class="eyebrow">${eyebrow}</p>
          <h2>${title}</h2>
        </div>
        <button type="button" class="button button--ghost" data-action="cancel">Close</button>
      </div>
      <form class="form">
        <label>
          <span>${label}</span>
          <textarea name="value" rows="8" placeholder=${placeholder}>${value}</textarea>
        </label>
        <footer class="dialog__footer">
          <button type="button" class="button button--ghost" data-action="cancel">Cancel</button>
          ${secondarySubmitLabel && onSecondarySubmit
            ? html`<button type="button" class="button button--ghost" data-action="secondary-submit">${secondarySubmitLabel}</button>`
            : nothing}
          <button type="submit" class="button">${submitLabel}</button>
        </footer>
      </form>
    </div>
  `);

  overlay.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "cancel" || event.target === overlay) {
      onCancel();
    }
    if (action === "secondary-submit" && onSecondarySubmit) {
      const nextValue = overlay.querySelector('[name="value"]')?.value?.trim() || "";
      if (nextValue) {
        onSecondarySubmit(nextValue);
      }
    }
  });

  overlay.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextValue = overlay.querySelector('[name="value"]')?.value?.trim() || "";
    if (!nextValue) {
      return;
    }
    onSubmit(nextValue);
  });

  return overlay;
}

export function createTextInputDialog({
  eyebrow = "Workspace",
  title,
  label,
  value = "",
  placeholder = "",
  submitLabel = "Save",
  onCancel,
  onSubmit,
}) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  renderInto(overlay, html`
    <div class="dialog" style="width:min(420px,100%);">
      <div class="dialog__header">
        <div>
          <p class="eyebrow">${eyebrow}</p>
          <h2>${title}</h2>
        </div>
        <button type="button" class="button button--ghost" data-action="cancel">Close</button>
      </div>
      <form class="form">
        <label>
          <span>${label}</span>
          <input name="value" .value=${value} placeholder=${placeholder} required />
        </label>
        <footer class="dialog__footer">
          <button type="button" class="button button--ghost" data-action="cancel">Cancel</button>
          <button type="submit" class="button">${submitLabel}</button>
        </footer>
      </form>
    </div>
  `);

  overlay.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "cancel" || event.target === overlay) {
      onCancel();
    }
  });

  overlay.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextValue = overlay.querySelector('[name="value"]')?.value?.trim() || "";
    if (!nextValue) {
      return;
    }
    onSubmit(nextValue);
  });

  return overlay;
}

export function createHelpDialog({ onClose }) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  renderInto(overlay, html`
    <div class="dialog">
      <div class="dialog__header">
        <div>
          <p class="eyebrow">strIDEterm</p>
          <h2>Help &amp; Keyboard Shortcuts</h2>
        </div>
        <button type="button" class="button button--ghost" data-action="close">Close</button>
      </div>
      <div class="form" style="margin-top:14px;">
        <article style="border:1px solid var(--border);border-radius:4px;padding:12px;background:rgba(255,255,255,0.03);">
          <h3 style="margin-bottom:8px;">Getting Started</h3>
          <p style="color:var(--muted);font-size:13px;line-height:1.6;">
            <strong>strIDEterm</strong> is a multi-workspace terminal hub. Add workspaces via the <strong>+</strong> button in the sidebar,
            organize them with <strong>Profiles</strong>, and use split layouts to view multiple terminals side by side.
          </p>
        </article>
        <article style="border:1px solid var(--border);border-radius:4px;padding:12px;background:rgba(255,255,255,0.03);">
          <h3 style="margin-bottom:8px;">Keyboard Shortcuts</h3>
          <dl style="display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;">
            <dt style="color:var(--accent);font-weight:700;">Ctrl/Cmd + N</dt><dd style="color:var(--muted);">New workspace</dd>
            <dt style="color:var(--accent);font-weight:700;">Ctrl/Cmd + R</dt><dd style="color:var(--muted);">Restart active terminal</dd>
            <dt style="color:var(--accent);font-weight:700;">Ctrl + 1-9</dt><dd style="color:var(--muted);">Switch to workspace 1-9</dd>
            <dt style="color:var(--accent);font-weight:700;">Ctrl + PageDown/PageUp</dt><dd style="color:var(--muted);">Next / previous tab</dd>
          </dl>
        </article>
        <article style="border:1px solid var(--border);border-radius:4px;padding:12px;background:rgba(255,255,255,0.03);">
          <h3 style="margin-bottom:8px;">Features</h3>
          <ul style="color:var(--muted);font-size:13px;line-height:1.8;padding-left:18px;margin:0;">
            <li><strong>Workspaces</strong> &mdash; Each workspace has its own terminal tabs, working directory, and Git/Docker integration.</li>
            <li><strong>Profiles</strong> &mdash; Group workspaces into profiles to quickly switch between different setups.</li>
            <li><strong>Split Layouts</strong> &mdash; View multiple terminals side by side (right-click tab or use Split button).</li>
            <li><strong>Docker Manager</strong> &mdash; Manage containers, attach shells, stream logs from Docker workspaces.</li>
            <li><strong>Git Integration</strong> &mdash; Branch info, dirty count, commit log, and Lazygit support.</li>
            <li><strong>Remote Access</strong> &mdash; Access your workspace from any device on the LAN or via Cloudflare tunnel.</li>
            <li><strong>Plugins</strong> &mdash; Extend functionality with plugins in the <code>plugins/</code> directory.</li>
            <li><strong>Drag &amp; Drop</strong> &mdash; Reorder tabs by dragging, move workspaces up/down with arrow buttons.</li>
          </ul>
        </article>
        <article style="border:1px solid var(--border);border-radius:4px;padding:12px;background:rgba(255,255,255,0.03);">
          <h3 style="margin-bottom:8px;">Configuration</h3>
          <p style="color:var(--muted);font-size:13px;line-height:1.6;">
            All configuration is stored in <code>~/.strideterm/</code>. The main state file is <code>strideterm-state.json</code>.
            Plugins are loaded from the <code>plugins/</code> subdirectory within your config folder.
          </p>
        </article>
      </div>
    </div>
  `);

  overlay.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "close" || event.target === overlay) {
      onClose();
    }
  });

  return overlay;
}

export function createProfilesDialog({ profiles, activeProfileId, workspaces, onCancel, onSave, onActivate, onDelete }) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";

  function renderContent() {
    renderInto(overlay, html`
      <div class="dialog">
        <div class="dialog__header">
          <div>
            <p class="eyebrow">Workspace</p>
            <h2>Profiles</h2>
          </div>
          <button type="button" class="button button--ghost" data-action="cancel">Close</button>
        </div>
        <div class="form" style="margin-top:14px;">
          <p style="color:var(--muted);font-size:13px;">
            Each profile has its own set of workspaces. Switch profiles to work on different projects.
          </p>
          <div style="display:grid;gap:8px;">
            ${profiles.map((profile) => {
              const isActive = profile.id === activeProfileId;
              const profileWorkspaceCount = workspaces.filter((ws) => (ws.profileId || "default") === profile.id).length;
              return html`
                <article style=${`border:1px solid ${isActive ? "var(--accent)" : "var(--border)"};border-radius:4px;padding:10px;background:rgba(255,255,255,0.03);display:grid;gap:8px;`}>
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <input data-action="rename-profile" data-profile-id=${profile.id} .value=${profile.name} maxlength="40" @click=${(e) => e.stopPropagation()} style="flex:1;min-width:0;background:transparent;border:1px solid transparent;border-radius:3px;padding:2px 6px;font:inherit;font-weight:700;color:var(--text);font-size:14px;" @focus=${(e) => { e.target.style.borderColor = "var(--border)"; e.target.style.background = "rgba(255,255,255,0.04)"; }} @blur=${(e) => { e.target.style.borderColor = "transparent"; e.target.style.background = "transparent"; }} />
                    ${isActive ? html`<span style="color:var(--accent);font-size:11px;flex-shrink:0;">(active)</span>` : nothing}
                    <div style="display:flex;gap:4px;">
                      ${!isActive ? html`<button class="button button--ghost" data-action="activate-profile" data-profile-id=${profile.id}>Activate</button>` : nothing}
                      ${profiles.length > 1 ? html`<button class="button button--ghost" data-action="delete-profile" data-profile-id=${profile.id} style="color:var(--danger);">Delete</button>` : nothing}
                    </div>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <small style="color:var(--muted);">${profileWorkspaceCount} workspace${profileWorkspaceCount !== 1 ? "s" : ""}</small>
                    ${isActive ? html`
                      <input type="color" data-action="pick-profile-color" data-profile-id=${profile.id} .value=${profile.color || "#ffa424"} style="width:28px;height:22px;padding:1px;cursor:pointer;border:1px solid var(--border);border-radius:3px;background:transparent;" title="Profile color" />
                    ` : nothing}
                  </div>
                </article>
              `;
            })}
          </div>
          <div style="display:flex;gap:6px;align-items:stretch;">
            <input data-role="new-profile-name" placeholder="New profile name..." maxlength="40" @click=${(e) => e.stopPropagation()} style="flex:1;min-width:0;padding:6px 10px;border:1px solid var(--border);border-radius:3px;background:rgba(255,255,255,0.04);color:inherit;font:inherit;font-size:13px;" />
            <button class="button button--ghost" data-action="add-profile">+ Add</button>
          </div>
        </div>
      </div>
    `);
  }

  overlay.addEventListener("click", async (event) => {
    const element = event.target.closest("[data-action]");
    const action = element?.dataset.action;
    if (!action) {
      if (event.target === overlay) {
        onCancel();
      }
      return;
    }
    if (action === "cancel") {
      onCancel();
      return;
    }
    if (action === "activate-profile") {
      await onActivate(element.dataset.profileId);
      onCancel();
      return;
    }
    if (action === "delete-profile") {
      await onDelete(element.dataset.profileId);
      profiles = profiles.filter((profile) => profile.id !== element.dataset.profileId);
      renderContent();
      return;
    }
    if (action === "add-profile") {
      const input = overlay.querySelector('[data-role="new-profile-name"]');
      const name = input?.value?.trim().substring(0, 40);
      if (!name || name.length < 1) {
        input?.focus();
        return;
      }
      if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        input?.focus();
        return;
      }
      const newProfile = { id: `profile-${crypto.randomUUID()}`, name, color: "#ffa424", workspaceIds: [] };
      await onSave(newProfile);
      profiles.push(newProfile);
      renderContent();
      return;
    }
    if (action === "toggle-workspace-in-profile") {
      const profileId = element.dataset.profileId;
      const workspaceId = element.dataset.workspaceId;
      const profile = profiles.find((entry) => entry.id === profileId);
      if (!profile) {
        return;
      }
      if (profile.workspaceIds.includes(workspaceId)) {
        profile.workspaceIds = profile.workspaceIds.filter((id) => id !== workspaceId);
      } else {
        profile.workspaceIds.push(workspaceId);
      }
      await onSave(profile);
      renderContent();
    }
  });

  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches('[data-role="new-profile-name"]')) {
      event.preventDefault();
      overlay.querySelector('[data-action="add-profile"]')?.click();
    }
    if (event.key === "Enter" && event.target.matches('[data-action="rename-profile"]')) {
      event.preventDefault();
      event.target.blur();
    }
  });

  overlay.addEventListener("change", async (event) => {
    if (event.target.matches('[data-action="rename-profile"]')) {
      const profileId = event.target.dataset.profileId;
      const profile = profiles.find((p) => p.id === profileId);
      const newName = event.target.value.trim();
      if (profile && newName) {
        profile.name = newName;
        await onSave(profile);
      }
    }
  });

  overlay.addEventListener("input", async (event) => {
    if (event.target.matches('[data-action="pick-profile-color"]')) {
      const profileId = event.target.dataset.profileId;
      const profile = profiles.find((p) => p.id === profileId);
      if (profile) {
        profile.color = event.target.value;
        await onSave(profile);
      }
    }
  });

  renderContent();
  return overlay;
}

export function createNewWorkspacePicker({ plugins, onPickEmpty, onPickPlugin, onCancel }) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const pluginsWithTemplates = (plugins || []).filter((plugin) => plugin.workspaceDefaults && !plugin.error);

  renderInto(overlay, html`
    <div class="dialog" style="width:min(540px,100%);">
      <div class="dialog__header">
        <div>
          <p class="eyebrow">New Workspace</p>
          <h2>Choose a template</h2>
        </div>
        <button type="button" class="button button--ghost" data-action="cancel">Close</button>
      </div>
      <div style="display:grid;gap:8px;margin-top:14px;">
        <button class="project" data-action="pick-empty" style="--accent:#ffa424;border:1px solid var(--border);cursor:pointer;">
          <span class="project__badge" style="background:rgba(255,164,36,0.24);font-size:16px;">+</span>
          <span class="project__meta">
            <span class="project__title-row"><strong>Empty Workspace</strong></span>
            <small style="color:var(--muted);">Start from scratch with a blank terminal workspace.</small>
          </span>
        </button>
        ${pluginsWithTemplates.map((plugin) => html`
          <button class="project" data-action="pick-plugin" data-plugin-id=${plugin.id} style=${`--accent:${escapeHtml(plugin.color)};border:1px solid var(--border);cursor:pointer;`}>
            <span class="project__badge">${plugin.icon}</span>
            <span class="project__meta">
              <span class="project__title-row"><strong>${plugin.name}</strong></span>
              <small style="color:var(--muted);">${plugin.description || "Plugin workspace template"}</small>
            </span>
          </button>
        `)}
      </div>
    </div>
  `);

  overlay.addEventListener("click", (event) => {
    const element = event.target.closest("[data-action]");
    const action = element?.dataset.action;
    if (!action) {
      if (event.target === overlay) {
        onCancel();
      }
      return;
    }
    if (action === "cancel") {
      onCancel();
      return;
    }
    if (action === "pick-empty") {
      onPickEmpty();
      return;
    }
    if (action === "pick-plugin") {
      onPickPlugin(element.dataset.pluginId);
    }
  });

  return overlay;
}
