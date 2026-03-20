import { nothing, render } from "lit";

export function createWorkspaceUiController({
  state,
  api,
  appConfig,
  root,
  workspaceList,
  remoteAccess,
  sidebarFooter,
  workspaceHero,
  tabStrip,
  tabActions,
  terminalStage,
  layouts,
  areaNames,
  areaLayouts,
  qrCode,
  terminalController,
  renderPaneShell,
  renderAzureInboxPaneMarkup,
  renderAzureReviewPaneMarkup,
  renderGitPaneMarkup,
  renderDockerPaneMarkup,
  renderRemoteAccessMarkup,
  renderRemoteAccessCardMarkup,
  renderSidebarList,
  renderSidebarFooter,
  getRemoteQrTarget,
  renderBrowserUrlBar,
  renderEmptyTerminalState,
  renderWelcomeScreen,
  renderWorkspaceHero,
  renderTabActions,
  renderTabStrip,
  buildTabStripModel,
  buildWorkspaceCards,
  normalizeWorkspaces,
  summarizeAttention,
  syncBrowserAttentionBadge,
  isInSplitGroup,
  activeSplitLayout,
  getWorkspace,
  getGitSnapshot,
  getGitUiState,
  getWorkspaceAttention,
  getTabAttention,
  getWorkspaceTabs,
  getVisibleTabs,
  isGitViewId,
  isDockerViewId,
  isAzureViewId,
  isReviewViewId,
}) {
  function findExistingPane(viewId) {
    return Array.from(terminalStage.children || []).find((child) => child?.dataset?.viewId === viewId) || null;
  }

  function capturePaneScroll(container) {
    if (!container) {
      return [];
    }

    const entries = [{
      key: "__pane_body__",
      top: container.scrollTop || 0,
      left: container.scrollLeft || 0,
    }];

    container.querySelectorAll("[data-scroll-key]").forEach((element) => {
      entries.push({
        key: element.dataset.scrollKey,
        top: element.scrollTop || 0,
        left: element.scrollLeft || 0,
      });
    });
    return entries;
  }

  function restorePaneScroll(container, entries = []) {
    if (!container || !entries.length) {
      return;
    }

    for (const entry of entries) {
      if (!entry?.key) {
        continue;
      }

      if (entry.key === "__pane_body__") {
        container.scrollTop = entry.top || 0;
        container.scrollLeft = entry.left || 0;
        continue;
      }

      const element = container.querySelector(`[data-scroll-key="${entry.key}"]`);
      if (element) {
        element.scrollTop = entry.top || 0;
        element.scrollLeft = entry.left || 0;
      }
    }
  }

  function createTerminalPane(viewTab, showHeader = false) {
    const sessionId = viewTab.id;
    const pane = document.createElement("article");
    pane.className = `workspace-pane ${sessionId === state.activeViewId ? "workspace-pane--active" : ""} ${showHeader ? "" : "workspace-pane--plain"}`;
    pane.dataset.viewId = sessionId;
    renderPaneShell(pane, {
      showHeader,
      title: viewTab.title,
      status: viewTab.status,
      actions: [
        { className: "workspace-pane__icon-btn", action: "select-tab", viewId: sessionId, title: "Focus tab", label: "\u25C9" },
        ...(viewTab.persistent ? [{ className: "workspace-pane__icon-btn", action: "rename-tab", viewId: sessionId, title: "Rename tab", label: "\u270E" }] : []),
        { className: "workspace-pane__icon-btn", action: "export-terminal-transcript", sessionId, title: "Save last 500 lines", label: "\u21E9" },
        { className: "workspace-pane__icon-btn", action: "clear-terminal", sessionId, title: "Clear output", label: "\u232B" },
        { className: "workspace-pane__icon-btn", action: "restart-session", sessionId, title: "Restart", label: "\u21BB" },
        { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: sessionId, title: "Close tab", label: "\u00D7" },
      ],
    });

    const paneBody = pane.querySelector(".workspace-pane__body");
    terminalController.attachTerminalPane(sessionId, paneBody);
    return pane;
  }

  function createGitPane(viewTab, workspaceId, showHeader = false) {
    const existingPane = findExistingPane(viewTab.id);
    const scrollState = capturePaneScroll(existingPane?.querySelector(".workspace-pane__body"));
    const pane = existingPane || document.createElement("article");
    pane.className = `workspace-pane ${viewTab.id === state.activeViewId ? "workspace-pane--active" : ""} ${showHeader ? "" : "workspace-pane--plain"}`;
    pane.dataset.viewId = viewTab.id;
    renderPaneShell(pane, {
      showHeader,
      title: viewTab.title,
      status: viewTab.status,
      bodyClass: "workspace-pane__body workspace-pane__body--git",
      actions: [
        { className: "workspace-pane__icon-btn", action: "select-tab", viewId: viewTab.id, title: "Focus tab", label: "\u25C9" },
        { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: viewTab.id, title: "Close tab", label: "\u00D7" },
      ],
    });
    render(renderGitPaneMarkup(
      getGitSnapshot(workspaceId),
      workspaceId,
      getGitUiState(workspaceId),
      state.payload?.appState?.workspaces || [],
    ), pane.querySelector(".workspace-pane__body"));
    restorePaneScroll(pane.querySelector(".workspace-pane__body"), scrollState);
    return pane;
  }

  function createAzurePane(viewTab, workspaceId, showHeader = false) {
    const existingPane = findExistingPane(viewTab.id);
    const scrollState = capturePaneScroll(existingPane?.querySelector(".workspace-pane__body"));
    const pane = existingPane || document.createElement("article");
    pane.className = `workspace-pane ${viewTab.id === state.activeViewId ? "workspace-pane--active" : ""} ${showHeader ? "" : "workspace-pane--plain"}`;
    pane.dataset.viewId = viewTab.id;
    renderPaneShell(pane, {
      showHeader,
      title: viewTab.title,
      status: viewTab.status,
      bodyClass: "workspace-pane__body workspace-pane__body--git",
      actions: [
        { className: "workspace-pane__icon-btn", action: "refresh-azure", title: "Refresh Azure DevOps", label: "\u21BB" },
      ],
    });
    const azureSettings = state.payload?.appState?.settings?.integrations?.azureDevops || {};
    const azureSnapshot = state.payload?.azureDevops || {};
    const hasConnections = (azureSettings.connections || []).length > 0;
    const body = pane.querySelector(".workspace-pane__body");
    if (!hasConnections) {
      // Use innerHTML for empty state to avoid Lit render issues after profile switch
      body.innerHTML = '<div class="terminal-empty" style="align-content:start;padding-top:32px;">'
        + '<p>No Azure DevOps connections yet</p>'
        + '<small>Add a connection with organization URL, login, PAT and review checkout path.</small>'
        + '<div class="docker-card__actions" style="margin-top:12px;">'
        + '<button type="button" class="button" data-action="open-azure-connection-dialog">Add Azure connection</button>'
        + '</div></div>';
    } else {
      render(renderAzureInboxPaneMarkup(azureSnapshot, azureSettings), body);
    }
    restorePaneScroll(pane.querySelector(".workspace-pane__body"), scrollState);
    return pane;
  }

  function createReviewPane(viewTab, workspace, showHeader = false) {
    const activeWorkspace = workspace.workspace || workspace.project;
    const prKey = activeWorkspace.review?.prKey || "";
    const detail = state.payload?.azureDevops?.pullRequests?.[prKey] || {};
    const reviewBridge = {
      ...(state.payload?.reviewBridge?.pullRequests?.[prKey] || {}),
      agentPrompts: state.payload?.reviewBridge?.agentPrompts || [],
    };
    const reviewUi = state.gitUiState?.[activeWorkspace.id] || {};
    const existingPane = findExistingPane(viewTab.id);
    const scrollState = capturePaneScroll(existingPane?.querySelector(".workspace-pane__body"));
    const pane = existingPane || document.createElement("article");
    pane.className = `workspace-pane ${viewTab.id === state.activeViewId ? "workspace-pane--active" : ""} ${showHeader ? "" : "workspace-pane--plain"}`;
    pane.dataset.viewId = viewTab.id;
    renderPaneShell(pane, {
      showHeader,
      title: viewTab.title,
      status: viewTab.status,
      bodyClass: "workspace-pane__body workspace-pane__body--git",
      actions: [
        { className: "workspace-pane__icon-btn", action: "refresh-azure", title: "Refresh Azure DevOps", label: "\u21BB" },
      ],
    });
    render(renderAzureReviewPaneMarkup(detail, activeWorkspace.id, reviewBridge, reviewUi), pane.querySelector(".workspace-pane__body"));
    restorePaneScroll(pane.querySelector(".workspace-pane__body"), scrollState);

    // Auto-refresh if PR detail is empty (e.g. after app restart)
    if (prKey && (!detail.pullRequest?.title || !detail.checks?.items) && !pane._reviewAutoRefreshed) {
      pane._reviewAutoRefreshed = true;
      api.refreshAzure().then((payload) => {
        state.payload = payload;
        renderAll();
        // If checks are still missing, force re-open the PR to trigger ensurePullRequestDetail
        const refreshedDetail = payload?.azureDevops?.pullRequests?.[prKey];
        if (refreshedDetail && !refreshedDetail.checks?.items) {
          return api.openAzurePullRequest({ prKey, workspaceId: activeWorkspace.id });
        }
      }).then((payload) => {
        if (payload) {
          state.payload = payload;
          renderAll();
        }
      }).catch(() => {});
    }

    return pane;
  }

  function createDockerPane(viewTab, showHeader = false) {
    const existingPane = findExistingPane(viewTab.id);
    const scrollState = capturePaneScroll(existingPane?.querySelector(".workspace-pane__body"));
    const pane = existingPane || document.createElement("article");
    pane.className = `workspace-pane ${viewTab.id === state.activeViewId ? "workspace-pane--active" : ""} ${showHeader ? "" : "workspace-pane--plain"}`;
    pane.dataset.viewId = viewTab.id;
    renderPaneShell(pane, {
      showHeader,
      title: viewTab.title,
      status: viewTab.status,
      bodyClass: "workspace-pane__body workspace-pane__body--git",
      actions: [
        { className: "workspace-pane__icon-btn", action: "refresh-docker", title: "Refresh Docker", label: "\u21BB" },
        { className: "workspace-pane__icon-btn", action: "select-tab", viewId: viewTab.id, title: "Focus tab", label: "\u25C9" },
        { className: "workspace-pane__icon-btn workspace-pane__icon-btn--danger", action: "close-tab", viewId: viewTab.id, title: "Close tab", label: "\u00D7" },
      ],
    });
    render(renderDockerPaneMarkup(state.payload?.docker || {}), pane.querySelector(".workspace-pane__body"));
    restorePaneScroll(pane.querySelector(".workspace-pane__body"), scrollState);
    return pane;
  }

  const browserPaneCache = new Map();

  function createBrowserPane(viewTab, showHeader = false) {
    // Return cached pane if it exists (preserves iframe/webview state)
    const cached = browserPaneCache.get(viewTab.id);
    if (cached) {
      cached.pane.className = `workspace-pane ${viewTab.id === state.activeViewId ? "workspace-pane--active" : ""} ${showHeader ? "" : "workspace-pane--plain"}`;
      return cached.pane;
    }
    const pane = document.createElement("article");
    pane.className = `workspace-pane ${viewTab.id === state.activeViewId ? "workspace-pane--active" : ""} ${showHeader ? "" : "workspace-pane--plain"}`;
    pane.dataset.viewId = viewTab.id;
    // No pane header actions — all controls are in the URL bar
    renderPaneShell(pane, {
      showHeader: false,
      title: viewTab.title,
      status: "",
      bodyClass: "workspace-pane__body workspace-pane__body--browser",
      actions: [],
    });
    const body = pane.querySelector(".workspace-pane__body");
    const homeUrl = viewTab.url || "about:blank";
    const isElectron = !!window.strideterm;

    // URL bar with inline nav buttons
    const urlBar = document.createElement("div");
    urlBar.className = "browser-url-bar";
    render(renderBrowserUrlBar({ homeUrl }), urlBar);
    body.appendChild(urlBar);

    // Embed - only set src if it's a real URL (not just "https://")
    const isValidUrl = homeUrl.length > 10;
    const isDark = document.documentElement.dataset.theme !== "light";
    const embedBg = isDark ? "#1c1c20" : "#fff";
    let embed;
    if (isElectron) {
      embed = document.createElement("webview");
      if (isValidUrl) embed.setAttribute("src", homeUrl);
      else embed.setAttribute("src", "about:blank");
      embed.setAttribute("allowpopups", "");
      if (isDark) embed.setAttribute("webpreferences", "darkTheme=yes");
      embed.style.cssText = `flex:1;min-height:0;border:none;background:${embedBg};border-radius:0 0 3px 3px;`;
    } else {
      embed = document.createElement("iframe");
      embed.src = isValidUrl ? homeUrl : "about:blank";
      embed.style.cssText = `flex:1;min-height:0;border:none;background:${embedBg};border-radius:0 0 3px 3px;`;
      embed.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
    }
    embed.dataset.viewId = viewTab.id;
    body.appendChild(embed);

    const urlInput = urlBar.querySelector("input");

    function navigateTo(target) {
      if (!target) return;
      if (!/^https?:\/\//i.test(target)) target = "https://" + target;
      if (isElectron) {
        try { embed.loadURL(target); } catch { embed.setAttribute("src", target); }
      } else {
        embed.src = target;
      }
    }

    // Enter in URL input
    urlBar.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateTo(urlInput.value.trim());
      urlInput.blur();
    });

    // Also handle Enter key directly in case form submit doesn't fire
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        navigateTo(urlInput.value.trim());
        urlInput.blur();
      }
    });

    // Nav button clicks
    urlBar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-browser-action]");
      if (!btn) return;
      const action = btn.dataset.browserAction;
      if (action === "back" && isElectron && embed.goBack) embed.goBack();
      if (action === "forward" && isElectron && embed.goForward) embed.goForward();
      if (action === "reload") {
        if (isElectron && embed.reload) embed.reload();
        else embed.src = embed.src;
      }
      if (action === "home") navigateTo(homeUrl);
      if (action === "external") {
        const url = isElectron && embed.getURL ? embed.getURL() : embed.src;
        if (url && url !== "about:blank") {
          if (window.strideterm?.openExternal) {
            window.strideterm.openExternal(url);
          } else {
            window.open(url, "_blank");
          }
        }
      }
    });

    function shortDomain(hostname) {
      const parts = hostname.split(".");
      if (parts.length <= 2) return hostname;
      const sld = parts[parts.length - 2];
      // Keep 3 parts for short SLDs like co.uk, com.br, co.jp
      if (sld.length <= 3 && parts.length >= 3) return parts.slice(-3).join(".");
      return parts.slice(-2).join(".");
    }

    function syncTabLabel(url) {
      try {
        const domain = shortDomain(new URL(url).hostname);
        const tab = tabStrip.querySelector(`[data-view-id="${viewTab.id}"] small`);
        if (tab) tab.textContent = domain;
      } catch {}
    }

    // Sync URL bar and tab label when webview navigates
    if (isElectron) {
      embed.addEventListener("did-navigate", (e) => { urlInput.value = e.url; syncTabLabel(e.url); });
      embed.addEventListener("did-navigate-in-page", (e) => { if (e.isMainFrame) { urlInput.value = e.url; syncTabLabel(e.url); } });
    }

    browserPaneCache.set(viewTab.id, { pane });
    return pane;
  }

  /** Replace terminalStage with static HTML (avoids broken Lit state after manual DOM ops). */
  function resetStage(html) {
    terminalStage.className = "terminal-stage";
    terminalStage.innerHTML = html;
    state.attachedSessionId = null;
    terminalController.disconnectHiddenPaneObservers(new Set());
  }

  function renderVisibleViews(workspace, visibleTabs) {
    if (!visibleTabs.length) {
      resetStage('<div class="terminal-empty"><p>No active terminal</p><small>Select a tab or open a Docker shell/log stream.</small></div>');
      return;
    }

    const visibleSessionIds = new Set(visibleTabs.filter((tab) => tab.type === "terminal").map((tab) => tab.id));
    terminalController.disconnectHiddenPaneObservers(visibleSessionIds);
    const layout = activeSplitLayout();
    const useAreas = areaLayouts.has(layout);
    terminalStage.className = `terminal-stage terminal-stage--${layout} terminal-stage--count-${visibleTabs.length}`;
    const isSplit = visibleTabs.length > 1;

    const nextPanes = visibleTabs.map((tab, index) => {
      let pane;
      if (tab.type === "git") {
        pane = createGitPane(tab, (workspace.workspace || workspace.project).id, isSplit);
      } else if (tab.type === "azure") {
        pane = createAzurePane(tab, (workspace.workspace || workspace.project).id, isSplit);
      } else if (tab.type === "review") {
        pane = createReviewPane(tab, workspace, isSplit);
      } else if (tab.type === "docker") {
        pane = createDockerPane(tab, isSplit);
      } else if (tab.type === "browser") {
        pane = createBrowserPane(tab, isSplit);
      } else {
        pane = createTerminalPane(tab, isSplit);
      }
      if (useAreas && areaNames[index]) {
        pane.style.gridArea = areaNames[index];
      }
      return pane;
    });

    // Smart DOM update: preserve browser panes already in DOM to avoid reload
    const nextSet = new Set(nextPanes);
    // Remove old children not in next set (including welcome screen or empty state)
    for (const child of Array.from(terminalStage.children)) {
      if (!nextSet.has(child)) child.remove();
    }
    // Clear any leftover innerHTML (welcome screen etc.) if panes are present
    if (nextPanes.length) {
      for (const stale of terminalStage.querySelectorAll(".welcome-screen, .terminal-empty")) {
        stale.remove();
      }
    }
    // Append/reorder to match nextPanes order
    nextPanes.forEach((pane, i) => {
      if (terminalStage.children[i] !== pane) {
        terminalStage.insertBefore(pane, terminalStage.children[i] || null);
      }
    });
    // Refit all visible terminals after DOM changes (prevents blank terminals)
    terminalController.scheduleAllVisibleResize();
    state.attachedSessionId = state.activeSessionId;
  }

  function renderRemoteAccessCardView(payload = state.payload) {
    renderRemoteAccessMarkup(remoteAccess, renderRemoteAccessCardMarkup({
      payload,
      selectedLanUrl: state.selectedLanUrl,
      remoteAccessExpanded: state.remoteAccessExpanded,
      remoteAccessMode: state.remoteAccessMode,
      remoteQrUrl: state.remoteQrUrl,
      isRemote: api.isRemote,
    }));
  }

  function queueRemoteQr(url) {
    const nextKey = url || "";
    if (state.remoteQrKey === nextKey) {
      return;
    }

    state.remoteQrKey = nextKey;
    if (!url) {
      state.remoteQrUrl = "";
      renderRemoteAccessCardView();
      return;
    }

    qrCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 6,
      color: {
        dark: appConfig.ui.qrForegroundColor,
        light: "#0000",
      },
    }).then((dataUrl) => {
      if (state.remoteQrKey !== nextKey) {
        return;
      }

      state.remoteQrUrl = dataUrl;
      renderRemoteAccessCardView();
    }).catch(() => {
      if (state.remoteQrKey !== nextKey) {
        return;
      }

      state.remoteQrUrl = "";
      renderRemoteAccessCardView();
    });
  }

  function renderRemoteAccess() {
    if (!state.payload) {
      remoteAccess.classList.remove("remote-access--expanded");
      renderRemoteAccessMarkup(remoteAccess, "");
      return;
    }

    const payload = state.payload;
    const config = payload.appState.settings.remoteAccess || {};
    const qrTarget = getRemoteQrTarget({
      payload,
      selectedLanUrl: state.selectedLanUrl,
      remoteAccessExpanded: state.remoteAccessExpanded,
      remoteAccessMode: state.remoteAccessMode,
    });
    remoteAccess.classList.toggle("remote-access--expanded", state.remoteAccessExpanded);
    renderRemoteAccessCardView(payload);
    queueRemoteQr(config.enabled ? qrTarget : "");
  }

  function renderSidebarFooterView(payload = state.payload) {
    renderSidebarFooter(sidebarFooter, {
      appVersion: payload?.meta?.appVersion || "",
      repositoryUrl: payload?.meta?.repositoryUrl || appConfig.app.repositoryUrl,
    });
  }

  function readCustomPublicUrl() {
    return remoteAccess.querySelector('[data-role="custom-public-url"]')?.value?.trim() || "";
  }

  function syncAttentionContext(visibleTabs) {
    const visibleSessionIds = [...new Set(
      (visibleTabs || [])
        .filter((tab) => tab.type === "terminal")
        .map((tab) => tab.id)
        .sort(),
    )];
    const nextKey = visibleSessionIds.join("|");
    if (state.attentionSyncKey === nextKey) {
      return;
    }

    state.attentionSyncKey = nextKey;
    api.syncAttentionContext?.({ visibleSessionIds }).catch(() => {});
  }

  function renderWorkspace() {
    const workspace = getWorkspace();
    const allWorkspaces = getFilteredWorkspaces();


    // Clear welcome screen / empty state if workspaces now exist
    if (allWorkspaces.length > 0 || workspace) {
      const stale = terminalStage.querySelector(".welcome-screen");
      if (stale) {
        stale.remove();
      }
    }

    // Welcome screen: only when no workspaces exist at all
    if (allWorkspaces.length === 0 && !workspace) {
      render(nothing, workspaceHero);
      renderTabStrip(tabStrip, []);
      render(nothing, tabActions);
      resetStage(
        '<div class="welcome-screen"><div class="welcome-screen__card">'
        + '<h1 class="welcome-screen__title">Welcome to str<em>IDE</em>term</h1>'
        + '<p class="welcome-screen__subtitle">Multi-workspace terminal hub for developers</p>'
        + '<div class="welcome-screen__steps">'
        + '<div class="welcome-screen__step"><span class="welcome-screen__step-num">1</span><div><strong>Create a workspace</strong><small>Click <strong>+</strong> in the sidebar or press <strong>Ctrl+N</strong></small></div></div>'
        + '<div class="welcome-screen__step"><span class="welcome-screen__step-num">2</span><div><strong>Pick a working directory</strong><small>Browse to your project folder</small></div></div>'
        + '<div class="welcome-screen__step"><span class="welcome-screen__step-num">3</span><div><strong>Add terminal tabs</strong><small>Shell, Claude Code, Codex, Gemini, Dev Server, Browser...</small></div></div>'
        + '</div>'
        + '<button type="button" class="button" data-action="new-workspace" style="margin-top:16px;padding:10px 24px;font-size:14px;">+ Create your first workspace</button>'
        + '</div></div>',
      );
      syncAttentionContext([]);
      return;
    }

    if (!workspace) {
      render(renderWorkspaceHero({
        workspace: null,
        remoteConnectionIssue: state.remoteConnectionIssue,
        isRemote: api.isRemote,
      }), workspaceHero);
      renderTabStrip(tabStrip, []);
      render(nothing, tabActions);
      renderVisibleViews(null, []);
      syncAttentionContext([]);
      return;
    }

    const activeWorkspace = workspace.workspace || workspace.project;
    const gitSnapshot = getGitSnapshot(activeWorkspace.id);
    const attention = getWorkspaceAttention(activeWorkspace.id);
    const dockerState = state.payload?.docker || {};
    render(renderWorkspaceHero({
      workspace,
      dockerState,
      gitSnapshot,
      attention,
      remoteConnectionIssue: state.remoteConnectionIssue,
      isRemote: api.isRemote,
    }), workspaceHero);

    const preferredSessionId = activeWorkspace.activePanelId
      ? `${activeWorkspace.id}:${activeWorkspace.activePanelId}`
      : workspace.sessions[0]?.sessionId || null;
    const tabs = getWorkspaceTabs(workspace);
    const preferredVirtualViewId = activeWorkspace.kind === "azure"
      ? `azure:${activeWorkspace.id}`
      : (activeWorkspace.review?.provider === "azure-devops" ? `review:${activeWorkspace.id}` : null);
    const fallbackViewId = preferredVirtualViewId && tabs.some((tab) => tab.id === preferredVirtualViewId)
      ? preferredVirtualViewId
      : (tabs.some((tab) => tab.id === preferredSessionId)
        ? preferredSessionId
        : tabs[0]?.id || null);
    state.activeViewId = tabs.some((tab) => tab.id === state.activeViewId) ? state.activeViewId : fallbackViewId;
    state.activeSessionId = (isGitViewId(state.activeViewId) || isDockerViewId(state.activeViewId) || isAzureViewId(state.activeViewId) || isReviewViewId(state.activeViewId)) ? null : state.activeViewId;
    const visibleTabs = getVisibleTabs(tabs);

    renderTabStrip(tabStrip, buildTabStripModel({
      tabs,
      activeViewId: state.activeViewId,
      isInSplitGroup,
      getTabAttention: (viewId) => getTabAttention(activeWorkspace.id, viewId),
    }));

    const currentLayout = activeSplitLayout();
    render(renderTabActions({
      workspaceKind: activeWorkspace.kind,
      splitGroup: state.splitGroup,
      currentLayout,
      layouts,
    }), tabActions);

    renderVisibleViews(workspace, visibleTabs);
    syncAttentionContext(visibleTabs);
  }

  function getFilteredWorkspaces() {
    const allWorkspaces = normalizeWorkspaces(state.payload.appState.workspaces);
    const activeProfileId = state.payload.appState.activeProfileId || "default";
    return allWorkspaces.filter((workspace) => (workspace.profileId || "default") === activeProfileId);
  }

  function renderProfileBar() {
    const profileBar = root.querySelector('[data-role="profile-bar"]');
    if (!profileBar) return;
    const profiles = state.payload?.appState?.profiles || [];
    const activeId = state.payload?.appState?.activeProfileId || "default";
    const activeProfile = profiles.find((p) => p.id === activeId) || { name: "Default", color: "#ffa424" };
    profileBar.style.setProperty("--profile-color", activeProfile.color || "#ffa424");
    profileBar.textContent = activeProfile.name;
  }

  function renderWorkspaces() {
    renderProfileBar();
    const workspaces = getFilteredWorkspaces();
    const workspaceCards = buildWorkspaceCards({
      workspaces,
      activeWorkspaceId: state.payload.appState.activeWorkspaceId,
      getGitSnapshot,
      getWorkspaceAttention,
    });

    const plugins = (state.payload?.plugins || []).filter((plugin) => plugin.workspaceDefaults && !plugin.error);
    const existingNames = new Set(workspaces.map((workspace) => workspace.name.toLowerCase()));
    const suggestions = plugins
      .filter((plugin) => !existingNames.has((plugin.workspaceDefaults.name || plugin.name).toLowerCase()))
      .map((plugin) => ({
        id: plugin.id,
        color: plugin.color,
        icon: plugin.icon,
        name: plugin.workspaceDefaults.name || plugin.name,
      }));

    renderSidebarList(workspaceList, {
      workspaces: workspaceCards,
      suggestions,
    });
  }

  function renderAttentionBadges() {
    const { count } = summarizeAttention();
    const hamburgerBadge = root.querySelector('[data-role="hamburger-badge"]');
    if (hamburgerBadge) {
      hamburgerBadge.textContent = count > 0 ? String(count) : "";
      hamburgerBadge.classList.toggle("mobile-hamburger__badge--visible", count > 0);
    }
  }

  function applyTheme() {
    const requested = state.payload.appState.settings.theme || "dark";
    document.documentElement.dataset.theme = requested === "system" ? state.payload.themeSource : requested;
    terminalController.syncTheme();
  }

  function renderBackground() {
    if (!state.payload || state.bootstrapError) {
      return;
    }

    renderSidebarFooterView(state.payload);
    renderWorkspaces();
    renderRemoteAccess();
    applyTheme();
    syncBrowserAttentionBadge();
    renderAttentionBadges();
  }

  function renderAll(renderBootstrapError) {
    renderSidebarFooterView(state.payload);

    if (state.bootstrapError) {
      renderBootstrapError(state.bootstrapError);
      return;
    }

    terminalController.pruneTerminalViews(new Set(
      (state.payload?.appState?.workspaces || []).flatMap((workspace) => workspace.panels.map((panel) => `${workspace.id}:${panel.id}`)),
    ));
    // Clean up browser panes for removed tabs
    const allVisibleBrowserIds = new Set(
      (state.payload?.appState?.workspaces || []).flatMap((ws) =>
        (ws.panels || []).filter((p) => /^https?:\/\//i.test(p.command || "")).map((p) => `browser:${p.id}`)
      ),
    );
    for (const key of browserPaneCache.keys()) {
      if (!allVisibleBrowserIds.has(key)) browserPaneCache.delete(key);
    }
    renderWorkspaces();
    renderRemoteAccess();
    renderWorkspace();
    applyTheme();
    syncBrowserAttentionBadge();
    renderAttentionBadges();
  }

  return {
    getFilteredWorkspaces,
    readCustomPublicUrl,
    render: renderAll,
    renderBackground,
    renderRemoteAccess,
  };
}
