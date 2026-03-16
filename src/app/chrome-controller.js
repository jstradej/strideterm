export function createChromeController({
  state,
  api,
  root,
  frame,
  sidebar,
  sidebarBackdrop,
  sidebarCollapseButton,
  workspaceList,
  tabStrip,
  terminalStage,
  layouts,
  writeSidebarCollapsed,
  writeSidebarWidth,
  escapeHtml,
  isInSplitGroup,
  activeSplitLayout,
  isGitViewId,
  isDockerViewId,
  getWorkspacePanelByViewId,
  openWorkspaceDialog,
  renameWorkspacePanel,
  reorderWorkspacePanels,
  scheduleActiveResize,
  render,
}) {
  function openSidebar() {
    sidebar.classList.add("sidebar--open");
    sidebarBackdrop.classList.add("sidebar-backdrop--visible");
  }

  function closeSidebar() {
    sidebar.classList.remove("sidebar--open");
    sidebarBackdrop.classList.remove("sidebar-backdrop--visible");
  }

  function syncSidebarCollapsed() {
    writeSidebarCollapsed(state.sidebarCollapsed);
    frame.classList.toggle("frame--sidebar-collapsed", state.sidebarCollapsed);
    if (sidebarCollapseButton) {
      sidebarCollapseButton.innerHTML = state.sidebarCollapsed ? "&#9654;" : "&#9664;";
      sidebarCollapseButton.title = state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
      sidebarCollapseButton.setAttribute("aria-label", sidebarCollapseButton.title);
    }
  }

  function hideContextMenu() {
    root.querySelectorAll(".context-menu").forEach((element) => element.remove());
  }

  function showTabContextMenu(x, y, viewId) {
    hideContextMenu();
    const inGroup = isInSplitGroup(viewId);
    const menu = document.createElement("div");
    menu.className = "context-menu";

    let items = "";
    const isTerminal = !isGitViewId(viewId) && !isDockerViewId(viewId);
    const persistentTarget = getWorkspacePanelByViewId(viewId);
    if (isTerminal) {
      items += `<button class="context-menu__item" data-action="restart-session" data-session-id="${viewId}">&#8635;  Restart</button>`;
      if (persistentTarget) {
        items += `<button class="context-menu__item" data-action="rename-tab" data-view-id="${viewId}">&#9998;  Rename tab</button>`;
      }
    }
    if (inGroup) {
      if (isTerminal) items += '<div class="context-menu__divider"></div>';
      items += `<button class="context-menu__item" data-action="ctx-remove-from-group" data-view-id="${viewId}">\u2715  Remove from split</button>`;
      items += `<button class="context-menu__item context-menu__item--danger" data-action="ctx-disband-group">\u2573  Disband split</button>`;
    } else if (state.splitGroup) {
      const slots = layouts[state.splitGroup.layout]?.slots || 2;
      if (state.splitGroup.viewIds.length < slots) {
        if (isTerminal) items += '<div class="context-menu__divider"></div>';
        items += `<button class="context-menu__item" data-action="ctx-add-to-group" data-view-id="${viewId}">\u002B  Add to split</button>`;
      }
    }
    menu.innerHTML = items;

    if (!items) {
      return;
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    root.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  }

  function hideLayoutPicker() {
    root.querySelectorAll(".layout-picker").forEach((element) => element.remove());
  }

  function layoutThumbSvg(layout) {
    const radius = 'rx="1.5"';
    switch (layout) {
      case "cols":
        return `<rect x="1" y="1" width="18" height="28" ${radius} fill="currentColor" opacity="0.5"/><rect x="21" y="1" width="18" height="28" ${radius} fill="currentColor" opacity="0.3"/>`;
      case "rows":
        return `<rect x="1" y="1" width="38" height="13" ${radius} fill="currentColor" opacity="0.5"/><rect x="1" y="16" width="38" height="13" ${radius} fill="currentColor" opacity="0.3"/>`;
      case "top-split":
        return `<rect x="1" y="1" width="38" height="13" ${radius} fill="currentColor" opacity="0.5"/><rect x="1" y="16" width="18" height="13" ${radius} fill="currentColor" opacity="0.3"/><rect x="21" y="16" width="18" height="13" ${radius} fill="currentColor" opacity="0.3"/>`;
      case "left-split":
        return `<rect x="1" y="1" width="18" height="28" ${radius} fill="currentColor" opacity="0.5"/><rect x="21" y="1" width="18" height="13" ${radius} fill="currentColor" opacity="0.3"/><rect x="21" y="16" width="18" height="13" ${radius} fill="currentColor" opacity="0.3"/>`;
      case "grid":
        return `<rect x="1" y="1" width="18" height="13" ${radius} fill="currentColor" opacity="0.5"/><rect x="21" y="1" width="18" height="13" ${radius} fill="currentColor" opacity="0.3"/><rect x="1" y="16" width="18" height="13" ${radius} fill="currentColor" opacity="0.3"/><rect x="21" y="16" width="18" height="13" ${radius} fill="currentColor" opacity="0.3"/>`;
      default:
        return `<rect x="1" y="1" width="38" height="28" ${radius} fill="currentColor" opacity="0.5"/>`;
    }
  }

  function showLayoutPicker(anchorElement) {
    hideLayoutPicker();
    hideContextMenu();
    const picker = document.createElement("div");
    picker.className = "layout-picker";
    const currentLayout = activeSplitLayout();
    picker.innerHTML = `
      <div class="layout-picker__grid">
        ${Object.entries(layouts).filter(([key]) => key !== "solo").map(([key, { label }]) => `
          <button class="layout-picker__item ${currentLayout === key ? "layout-picker__item--active" : ""}" data-action="pick-layout" data-layout="${key}" title="${escapeHtml(label)}">
            <svg class="layout-thumb" viewBox="0 0 40 30">${layoutThumbSvg(key)}</svg>
            <span>${escapeHtml(label)}</span>
          </button>
        `).join("")}
      </div>
    `;

    root.appendChild(picker);
    const buttonRect = anchorElement.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    picker.style.top = `${buttonRect.bottom - rootRect.top + 4}px`;
    picker.style.right = `${rootRect.right - buttonRect.right}px`;
    const pickerRect = picker.getBoundingClientRect();
    if (pickerRect.left < 0) {
      picker.style.right = "auto";
      picker.style.left = "4px";
    }
    if (pickerRect.bottom > window.innerHeight) {
      picker.style.top = `${buttonRect.top - rootRect.top - pickerRect.height - 4}px`;
    }
  }

  function closeOverlay() {
    state.overlay?.remove();
    state.overlay = null;
  }

  function clearBootstrapError() {
    root.querySelector('[data-role="boot-shell"]')?.remove();
  }

  function renderBootstrapError(message) {
    state.bootstrapError = message;
    clearBootstrapError();
    const shell = document.createElement("div");
    shell.className = "boot-shell";
    shell.dataset.role = "boot-shell";
    shell.innerHTML = `
      <section class="boot-card">
        <p class="eyebrow">${api.isRemote ? "Remote Access" : "Startup Error"}</p>
        <h1>strIDEterm could not load the workspace</h1>
        <p class="boot-copy">${escapeHtml(message)}</p>
        ${
          api.isRemote
            ? `
              <form class="boot-form" data-role="remote-auth-form">
                <label>
                  <span>Access token</span>
                  <input name="token" value="${escapeHtml(api.getRemoteToken())}" placeholder="Paste the strIDEterm token" />
                </label>
                <button type="submit" class="button">Connect</button>
              </form>
            `
            : `<button type="button" class="button" data-action="retry-bootstrap">Retry</button>`
        }
      </section>
    `;
    root.append(shell);

    if (api.isRemote) {
      shell.querySelector('[data-role="remote-auth-form"]')?.addEventListener("submit", (event) => {
        event.preventDefault();
        const token = event.currentTarget.elements.token.value.trim();
        api.setRemoteToken(token);
      });
      return;
    }

    shell.querySelector('[data-action="retry-bootstrap"]')?.addEventListener("click", () => {
      window.location.reload();
    });
  }

  function wireChromeInteractions() {
    sidebarBackdrop.addEventListener("click", closeSidebar);
    syncSidebarCollapsed();

    workspaceList.addEventListener("click", (event) => {
      if (event.target.closest("[data-action='activate-workspace']") && sidebar.classList.contains("sidebar--open")) {
        closeSidebar();
      }
    });

    function clearWorkspaceDragIndicators() {
      workspaceList.querySelectorAll(".workspace-card--drag-before, .workspace-card--drag-after, .workspace-card--dragging").forEach((item) => {
        item.classList.remove("workspace-card--drag-before", "workspace-card--drag-after", "workspace-card--dragging");
      });
    }
    workspaceList.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".workspace-card");
      if (!card) return;
      event.dataTransfer.effectAllowed = "move";
      const workspaceId = card.dataset.workspaceId;
      event.dataTransfer.setData("text/plain", workspaceId);
      const groupIds = getWorktreeGroup(workspaceId, state.payload.appState.workspaces);
      requestAnimationFrame(() => {
        workspaceList.querySelectorAll(".workspace-card").forEach((c) => {
          if (groupIds.includes(c.dataset.workspaceId)) {
            c.classList.add("workspace-card--dragging");
          }
        });
      });
    });
    workspaceList.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const card = event.target.closest(".workspace-card");
      clearWorkspaceDragIndicators();
      if (card && !card.classList.contains("workspace-card--dragging")) {
        const rect = card.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;
        card.classList.add(before ? "workspace-card--drag-before" : "workspace-card--drag-after");
      }

    });
    workspaceList.addEventListener("dragleave", (event) => {
      if (!workspaceList.contains(event.relatedTarget)) {
        clearWorkspaceDragIndicators();
      }
    });
    function getWorktreeGroup(workspaceId, workspaces) {
      const ws = workspaces.find((w) => w.id === workspaceId);
      if (!ws) return [workspaceId];
      // If this is a worktree child, find parent and get its group
      if ((ws.notes || "").startsWith("Worktree of ")) {
        const parentName = ws.name.split(" / ")[0];
        const parent = workspaces.find((w) => w.name === parentName && !(w.notes || "").startsWith("Worktree of "));
        if (parent) return getWorktreeGroup(parent.id, workspaces);
      }
      // This is a parent — collect self + all worktree children
      const prefix = ws.name + " / ";
      const groupIds = [ws.id];
      for (const w of workspaces) {
        if (w.name.startsWith(prefix) && (w.notes || "").startsWith("Worktree of ")) {
          groupIds.push(w.id);
        }
      }
      return groupIds;
    }

    workspaceList.addEventListener("drop", async (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData("text/plain");
      const dropTarget = event.target.closest(".workspace-card");
      clearWorkspaceDragIndicators();
      if (!dropTarget || dropTarget.dataset.workspaceId === draggedId) return;
      const rect = dropTarget.getBoundingClientRect();
      const insertBefore = event.clientY < rect.top + rect.height / 2;
      const workspaces = state.payload.appState.workspaces;
      const allIds = workspaces.map((w) => w.id);
      const groupIds = getWorktreeGroup(draggedId, workspaces);
      // Remove the entire group from the list
      const remaining = allIds.filter((id) => !groupIds.includes(id));
      // Find insert position in the remaining list
      let toIndex = remaining.indexOf(dropTarget.dataset.workspaceId);
      if (toIndex < 0) return;
      if (!insertBefore) toIndex++;
      // Insert group at position
      remaining.splice(toIndex, 0, ...groupIds);
      state.payload = await api.reorderWorkspaces(remaining);
      render();
    });
    workspaceList.addEventListener("dragend", () => {
      clearWorkspaceDragIndicators();
    });

    const stageObserver = new ResizeObserver(() => {
      scheduleActiveResize();
    });
    stageObserver.observe(terminalStage);

    function clearTabDragIndicators() {
      tabStrip.querySelectorAll(".tab--drag-before, .tab--drag-after, .tab--dragging").forEach((item) => {
        item.classList.remove("tab--drag-before", "tab--drag-after", "tab--dragging");
      });
    }
    tabStrip.addEventListener("dragstart", (event) => {
      const tab = event.target.closest(".tab");
      if (!tab || tab.dataset.persistent !== "true") {
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tab.dataset.viewId);
      requestAnimationFrame(() => tab.classList.add("tab--dragging"));
    });
    tabStrip.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearTabDragIndicators();
      const tab = event.target.closest(".tab");
      if (tab && !tab.classList.contains("tab--dragging")) {
        const rect = tab.getBoundingClientRect();
        const before = event.clientX < rect.left + rect.width / 2;
        tab.classList.add(before ? "tab--drag-before" : "tab--drag-after");
      } else if (!tab) {
        // Hovering over empty space — find nearest edge tab
        const tabs = Array.from(tabStrip.querySelectorAll(".tab:not(.tab--dragging)"));
        if (tabs.length) {
          const last = tabs[tabs.length - 1];
          last.classList.add("tab--drag-after");
        }
      }
    });
    tabStrip.addEventListener("dragleave", (event) => {
      if (!tabStrip.contains(event.relatedTarget)) {
        clearTabDragIndicators();
      }
    });
    tabStrip.addEventListener("drop", async (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData("text/plain");
      clearTabDragIndicators();
      const tab = event.target.closest(".tab");
      if (tab && tab.dataset.viewId !== draggedId && tab.dataset.persistent === "true") {
        const rect = tab.getBoundingClientRect();
        const insertBefore = event.clientX < rect.left + rect.width / 2;
        await reorderWorkspacePanels(draggedId, tab.dataset.viewId, insertBefore);
        return;
      }
      // Dropped on empty space — move to end
      const allTabs = Array.from(tabStrip.querySelectorAll(".tab[data-persistent='true']"));
      if (allTabs.length) {
        const lastTab = allTabs[allTabs.length - 1];
        if (lastTab.dataset.viewId !== draggedId) {
          await reorderWorkspacePanels(draggedId, lastTab.dataset.viewId, false);
        }
      }
    });
    tabStrip.addEventListener("dragend", () => {
      clearTabDragIndicators();
    });
    tabStrip.addEventListener("dblclick", async (event) => {
      const tab = event.target.closest(".tab");
      if (!tab || tab.dataset.persistent !== "true") {
        return;
      }
      await renameWorkspacePanel(tab.dataset.viewId);
    });
    tabStrip.addEventListener("contextmenu", (event) => {
      const tab = event.target.closest(".tab");
      if (!tab) return;
      event.preventDefault();
      showTabContextMenu(event.clientX, event.clientY, tab.dataset.viewId);
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".context-menu")) {
        hideContextMenu();
      }
      if (!event.target.closest(".layout-picker") && !event.target.closest('[data-action="open-layout-picker"]')) {
        hideLayoutPicker();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideContextMenu();
        hideLayoutPicker();
      }
    });

    // ── Sidebar resize handle ──
    const SIDEBAR_COLLAPSE_THRESHOLD = 100;
    const SIDEBAR_MIN = 110;
    const SIDEBAR_MAX = 500;
    const resizeHandle = sidebar.querySelector('[data-role="sidebar-resize-handle"]');
    if (resizeHandle) {
      let resizing = false;
      let startX = 0;
      let startWidth = 0;
      let wasCollapsed = false;

      resizeHandle.addEventListener("mousedown", (event) => {
        event.preventDefault();
        resizing = true;
        wasCollapsed = state.sidebarCollapsed;
        startX = event.clientX;
        startWidth = wasCollapsed
          ? Number.parseFloat(getComputedStyle(frame).getPropertyValue("--sidebar-collapsed-width")) || 84
          : sidebar.getBoundingClientRect().width;
        frame.classList.add("frame--resizing");
        resizeHandle.classList.add("sidebar-resize-handle--active");
      });

      window.addEventListener("mousemove", (event) => {
        if (!resizing) return;
        const delta = event.clientX - startX;
        const rawWidth = startWidth + delta;

        if (rawWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
          // Snap to collapsed
          if (!state.sidebarCollapsed) {
            state.sidebarCollapsed = true;
            syncSidebarCollapsed();
          }
        } else {
          // Uncollapse if we were collapsed
          if (state.sidebarCollapsed) {
            state.sidebarCollapsed = false;
            syncSidebarCollapsed();
          }
          const clampedWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, rawWidth));
          frame.style.setProperty("--sidebar-width", `${clampedWidth}px`);
        }
      });

      window.addEventListener("mouseup", () => {
        if (!resizing) return;
        resizing = false;
        frame.classList.remove("frame--resizing");
        resizeHandle.classList.remove("sidebar-resize-handle--active");
        if (!state.sidebarCollapsed) {
          const currentWidth = sidebar.getBoundingClientRect().width;
          writeSidebarWidth(Math.round(currentWidth));
        }
        scheduleActiveResize();
      });
    }
  }

  return {
    clearBootstrapError,
    closeOverlay,
    closeSidebar,
    hideContextMenu,
    hideLayoutPicker,
    openSidebar,
    renderBootstrapError,
    showLayoutPicker,
    syncSidebarCollapsed,
    wireChromeInteractions,
  };
}
