import { html, nothing } from "lit";
import {
  attentionTitle,
  isContainerRunning,
  isFreshAlert,
  isFreshAttention,
  safeColor,
  tabAttentionTitle,
} from "./helpers.js";

export function renderWorkspaceHero({
  workspace,
  dockerState = {},
  gitSnapshot,
  attention,
  remoteConnectionIssue = "",
  isRemote = false,
}) {
  if (!workspace) {
    return html`
      ${isRemote && remoteConnectionIssue
        ? html`<div class="workspace-remote-alert"><strong>Remote connection issue.</strong> ${remoteConnectionIssue}</div>`
        : nothing}
      <p class="workspace-empty-copy">Select or create a workspace to open it.</p>
    `;
  }

  const activeWorkspace = workspace.workspace || workspace.project;
  if (activeWorkspace.kind === "azure") {
    const reviewTemplateCount = activeWorkspace.panels?.length || 0;
    return html`
      ${isRemote && remoteConnectionIssue
        ? html`<div class="workspace-remote-alert"><strong>Remote connection issue.</strong> ${remoteConnectionIssue}</div>`
        : nothing}
      <div class="workspace-meta" style=${`--accent:${safeColor(activeWorkspace.color)}`}>
        <div class="workspace-meta__main">
          <span class="workspace-meta__path" title=${activeWorkspace.cwd || ""}>${activeWorkspace.cwd || "Azure DevOps inbox"}</span>
        </div>
        <div class="workspace-meta__stats">
          <span class="workspace-chip"><strong>Azure</strong> inbox</span>
          <span class="workspace-chip"><strong>${String(reviewTemplateCount)}</strong> review tabs</span>
          ${attention?.count
            ? html`
                <span
                  class=${`workspace-chip workspace-chip--alert ${isFreshAttention(attention) ? "workspace-chip--alert-fresh" : ""}`}
                  title=${attentionTitle(attention)}
                >
                  <strong>${String(attention.count)}</strong> attention
                </span>
              `
            : nothing}
        </div>
      </div>
    `;
  }
  const running = workspace.sessions.filter((session) => session.status === "running").length;
  const accent = safeColor(activeWorkspace.color);
  const attentionFresh = isFreshAttention(attention);
  const attentionTooltip = attentionTitle(attention);

  return html`
    ${isRemote && remoteConnectionIssue
      ? html`<div class="workspace-remote-alert"><strong>Remote connection issue.</strong> ${remoteConnectionIssue}</div>`
      : nothing}
    <div class="workspace-meta" style=${`--accent:${accent}`}>
      <div class="workspace-meta__main">
        <span class="workspace-meta__path" title=${activeWorkspace.cwd || ""}>${activeWorkspace.cwd || "Not set"}</span>
      </div>
      <div class="workspace-meta__stats">
        <span class="workspace-chip"><strong>${workspace.sessions.length}</strong> tabs</span>
        <span class="workspace-chip"><strong>${running}</strong> running</span>
        ${gitSnapshot?.available
          ? html`
              <span class="workspace-chip" style=${`border-color:${gitSnapshot.dirty ? "rgba(255,111,141,0.4)" : "rgba(110,223,182,0.4)"};`}>
                <strong style=${`color:${gitSnapshot.dirty ? "#ff6f8d" : "#6edfb6"};`}>${gitSnapshot.branch}</strong>
                ${gitSnapshot.dirty
                  ? html`<span style="color:#ff6f8d;margin-left:4px;">${String(gitSnapshot.dirtyCount)} uncommitted</span>`
                  : html`<span style="color:#6edfb6;margin-left:4px;">clean</span>`}
              </span>
            `
          : nothing}
        ${activeWorkspace.kind === "docker" && dockerState.available
          ? html`<span class="workspace-chip"><strong>${(dockerState.containers || []).filter(isContainerRunning).length}</strong>/${(dockerState.containers || []).length} containers up</span>`
          : nothing}
        ${attention?.count
          ? html`
              <span
                class=${`workspace-chip workspace-chip--alert ${attentionFresh ? "workspace-chip--alert-fresh" : ""}`}
                title=${attentionTooltip}
              >
                <strong>${String(attention.count)}</strong> attention
              </span>
            `
          : nothing}
      </div>
    </div>
  `;
}

export function buildTabStripModel({
  tabs,
  activeViewId,
  isInSplitGroup,
  getTabAttention,
}) {
  return tabs.map((session) => {
    const tabAttention = getTabAttention(session.id);
    const attentionTooltip = tabAttentionTitle(tabAttention);
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      tone: session.tone,
      active: session.id === activeViewId,
      grouped: isInSplitGroup(session.id),
      persistent: !!session.persistent,
      closable: session.closable !== false,
      attention: !!tabAttention,
      attentionFresh: isFreshAlert(tabAttention),
      attentionTooltip,
      titleTooltip: attentionTooltip || (session.persistent ? "Double click to rename. Drag to reorder." : `${session.title}${session.status ? `\n${session.status}` : ""}`),
    };
  });
}

export function renderTabActions({
  workspaceKind,
  splitGroup,
  currentLayout,
  layouts,
}) {
  return html`
    ${workspaceKind !== "docker" && workspaceKind !== "azure"
      ? html`<button type="button" class="button button--ghost" data-action="toggle-tab-picker">+ Tab</button>`
      : nothing}
    ${splitGroup
      ? html`<button type="button" class="button button--ghost" data-action="disband-split">Unsplit</button>`
      : nothing}
    <button
      type="button"
      class=${`button button--ghost ${currentLayout !== "solo" ? "button--active" : ""}`}
      data-action="open-layout-picker"
      title="Layout"
    >
      ${currentLayout !== "solo" ? (layouts[currentLayout]?.label || "Split") : "Split"}
    </button>
  `;
}

export function renderBrowserUrlBar({ homeUrl = "about:blank" } = {}) {
  return html`
    <button type="button" class="browser-url-bar__btn" data-browser-action="back" title="Back">\u25C0</button>
    <button type="button" class="browser-url-bar__btn" data-browser-action="forward" title="Forward">\u25B6</button>
    <button type="button" class="browser-url-bar__btn" data-browser-action="reload" title="Reload">\u21BB</button>
    <button type="button" class="browser-url-bar__btn" data-browser-action="home" title="Home">\u{1F3E0}</button>
    <form class="browser-url-bar__form">
      <input class="browser-url-bar__input" .value=${homeUrl} placeholder="https://..." />
    </form>
    <button type="button" class="browser-url-bar__btn" data-browser-action="external" title="Open in browser">\u{1F517}</button>
  `;
}

export function renderEmptyTerminalState() {
  return html`
    <div class="terminal-empty">
      <p>No active terminal</p>
      <small>Select a tab or open a Docker shell/log stream.</small>
    </div>
  `;
}

export function renderWelcomeScreen() {
  return html`
    <div class="welcome-screen">
      <div class="welcome-screen__card">
        <h1 class="welcome-screen__title">Welcome to str<em>IDE</em>term</h1>
        <p class="welcome-screen__subtitle">Multi-workspace terminal hub for developers</p>
        <div class="welcome-screen__steps">
          <div class="welcome-screen__step">
            <span class="welcome-screen__step-num">1</span>
            <div>
              <strong>Create a workspace</strong>
              <small>Click <strong>+</strong> in the sidebar or press <strong>Ctrl+N</strong></small>
            </div>
          </div>
          <div class="welcome-screen__step">
            <span class="welcome-screen__step-num">2</span>
            <div>
              <strong>Pick a working directory</strong>
              <small>Browse to your project folder</small>
            </div>
          </div>
          <div class="welcome-screen__step">
            <span class="welcome-screen__step-num">3</span>
            <div>
              <strong>Add terminal tabs</strong>
              <small>Shell, Claude Code, Codex, Gemini, Dev Server, Browser...</small>
            </div>
          </div>
        </div>
        <button type="button" class="button" data-action="new-workspace" style="margin-top:16px;padding:10px 24px;font-size:14px;">+ Create your first workspace</button>
      </div>
    </div>
  `;
}

export function buildWorkspaceCards({
  workspaces,
  activeWorkspaceId,
  getGitSnapshot,
  getWorkspaceAttention,
}) {
  return workspaces.map((workspace, index) => {
    const active = workspace.id === activeWorkspaceId;
    const gitSnapshot = getGitSnapshot(workspace.id);
    const attention = getWorkspaceAttention(workspace.id);
    const attentionTooltip = attentionTitle(attention);
    const isReviewChild = workspace.review?.provider === "azure-devops"
      && workspace.review?.checkout?.mode === "managed-worktree";
    const summary = workspace.kind === "docker"
      ? "Docker"
      : workspace.kind === "azure"
        ? `${workspace.cwd || "Azure inbox"}${workspace.panels?.length ? ` \u00B7 ${workspace.panels.length} review tabs` : ""}`
      : isReviewChild
        ? `Azure review \u00B7 ${gitSnapshot?.branch || `${workspace.panels.length} tabs`}${gitSnapshot?.dirty ? ` \u00B7 ${gitSnapshot.dirtyCount} dirty` : ""}`
      : gitSnapshot?.available
        ? `${gitSnapshot.branch}${gitSnapshot.dirty ? ` \u00B7 ${gitSnapshot.dirtyCount} dirty` : ""}`
        : `${workspace.panels.length} tabs`;

    return {
      id: workspace.id,
      index: index + 1,
      icon: workspace.icon,
      name: workspace.name,
      active,
      color: safeColor(workspace.color),
      summary,
      title: `${attention?.count ? attentionTooltip : workspace.name}${index < 9 ? ` (Ctrl+${index + 1})` : ""}`,
      attentionCount: attention?.count || 0,
      attentionFresh: isFreshAttention(attention),
      attentionTooltip,
      gitAvailable: !!gitSnapshot?.available,
      isWorktree: (workspace.notes || "").startsWith("Worktree of ") || isReviewChild,
    };
  });
}
