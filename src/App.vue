<template>
  <!-- Splash screen — stays visible until initial payload arrives -->
  <div v-if="!store.payload && !store.bootstrapError" class="splash">
    <img src="/splash.png" alt="strIDEterm" class="splash__logo" />
    <div class="splash__progress">
      <div class="splash__bar"></div>
    </div>
  </div>

  <div
    v-else
    ref="frameRef"
    class="frame"
    :class="{
      'frame--remote': api?.isRemote,
      'frame--sidebar-collapsed': store.sidebarCollapsed,
      'frame--notif-pinned': notifStore.pinned,
      'frame--has-overlay': !!store.overlay,
    }"
  >
    <div
      class="sidebar-backdrop"
      :class="{ 'sidebar-backdrop--visible': sidebarOpen }"
      data-role="sidebar-backdrop"
      @click="closeSidebar"
    ></div>

    <aside ref="sidebarRef" class="sidebar" :class="{ 'sidebar--open': sidebarOpen }">
      <div class="sidebar__head">
        <h1 class="brand">str<em>IDE</em>term</h1>
        <div class="sidebar__tools">
          <button
            type="button"
            class="sidebar__icon-btn sidebar__icon-btn--primary"
            title="Open the New Workspace picker — pick an empty workspace, an Agent Task Runner, or one of the installed plugin templates (Azure DevOps, GitHub, Docker, System Monitor)."
            @click="store.openNewWorkspaceFlow()"
          >
            +
          </button>
          <button
            v-if="hasAnyStarred"
            type="button"
            class="sidebar__icon-btn"
            :class="{ 'sidebar__icon-btn--star-active': store.starFilterActive }"
            :title="
              store.starFilterActive
                ? 'Drop the starred-only filter — every workspace in the active profile becomes visible again.'
                : 'Hide non-starred workspaces — only the ones you marked with ★ stay visible in the sidebar list.'
            "
            @click="store.starFilterActive = !store.starFilterActive"
          >
            {{ store.starFilterActive ? "★" : "☆" }}
          </button>
          <button
            type="button"
            class="sidebar__icon-btn"
            title="Open the Settings dialog (theme, notifications, agent hooks, SSH, tab templates, Telegram bot, and About)."
            @click="store.openSettingsDialog()"
          >
            ⚙
          </button>
          <button
            type="button"
            class="sidebar__icon-btn"
            title="Open the Help dialog — keyboard shortcuts, navigation tips, and links to the project's docs."
            @click="store.openHelpDialog()"
          >
            ?
          </button>
          <!-- Collapse sits at the far right (after Help) so the desktop chrome
               ends with the shrink action, mirroring the expand-from-icon strip
               on the other side. On mobile the close (✕) takes over via CSS. -->
          <button
            type="button"
            class="sidebar__icon-btn sidebar__collapse-btn"
            data-role="sidebar-collapse"
            :title="
              store.sidebarCollapsed
                ? 'Expand the sidebar back to its full width — workspace names, summaries, and the Configure button reappear.'
                : 'Shrink the sidebar to a slim icon strip so the active workspace gets more horizontal room. Workspace cards collapse to icons; click one to switch.'
            "
            :aria-label="sidebarCollapseLabel"
            @click="toggleSidebarCollapse"
          >
            {{ store.sidebarCollapsed ? "▶" : "◀" }}
          </button>
          <button
            type="button"
            class="sidebar__icon-btn sidebar__close-btn"
            title="Hide the sidebar drawer (mobile / narrow viewports). The hamburger menu in the toolbar reopens it."
            aria-label="Close sidebar"
            @click="closeSidebar"
          >
            ✕
          </button>
        </div>
      </div>

      <ProfileBar @click="store.openProfilesDialog()" />
      <SidebarPanel
        @activate="closeSidebar"
        @create-worktree="store.createWorktreeWithDialog($event)"
        @edit-workspace="onEditWorkspace($event)"
        @delete-workspace="store.deleteWorkspace($event)"
        @force-remove-workspace="store.forceRemoveWorkspace($event)"
        @add-plugin-workspace="store.openNewWorkspaceFlow()"
        @create-task="store.openTaskWorkspaceDialog($event)"
      />

      <!-- Remote access panel (above footer so version info stays at very bottom) -->
      <RemoteAccessPanel v-if="store.payload" />

      <footer class="sidebar-footer" data-role="sidebar-footer">
        <div class="sidebar-footer__card">
          <div class="sidebar-footer__meta">
            <span class="eyebrow">App</span>
            <strong class="sidebar-footer__version">{{ versionLabel }}</strong>
            <button
              v-if="versionsBehind > 0"
              type="button"
              class="sidebar-footer__update-hint"
              :title="`Open the latest release page on GitHub in your default web browser so you can download the new build (current latest: v${latestVersionLabel}).`"
              @click="api?.openExternal?.(latestReleaseUrl)"
            >
              {{ versionsBehind }} {{ versionsBehind === 1 ? "update" : "updates" }} behind
            </button>
          </div>
          <button
            v-if="repositoryUrl"
            type="button"
            class="sidebar-footer__repo"
            :title="`Open the strIDEterm GitHub repository (${repositoryUrl}) in your default web browser — issues, releases, and source.`"
            @click="api?.openExternal?.(repositoryUrl)"
          >
            GitHub repo
          </button>
        </div>
      </footer>

      <div class="sidebar-resize-handle" data-role="sidebar-resize-handle"></div>
    </aside>

    <main class="workspace">
      <section class="workspace-main" :class="{ 'workspace-main--grid': store.isGridVisible }">
        <WorkspaceHero />

        <div v-show="!store.isGridVisible" class="terminal-toolbar">
          <button
            type="button"
            class="mobile-hamburger"
            title="Open the sidebar drawer (mobile / narrow viewports) — workspace list, profile bar, settings, help, and remote-access controls. The badge shows how many workspaces currently need your attention."
            @click="openSidebar"
          >
            ☰
            <span
              class="mobile-hamburger__badge"
              :class="{ 'mobile-hamburger__badge--visible': store.attentionSummary.count > 0 }"
              >{{ store.attentionSummary.count > 0 ? store.attentionSummary.count : "" }}</span
            >
          </button>

          <TabStrip
            @edit-tab="store.editTabWithDialog($event)"
            @contextmenu-tab="onTabContextMenu"
            @menu-tab="onTabContextMenu"
          />

          <!-- Mobile tab picker (replaces cramped tab strip) -->
          <div class="mobile-tab-picker">
            <button
              type="button"
              class="mobile-tab-picker__trigger"
              title="Open the mobile tab list — every tab in the active workspace as a stacked dropdown. Tap a row to switch to that tab; tap the ☰ icon for the per-tab actions menu."
              @click="mobileTabOpen = !mobileTabOpen"
            >
              ▤ Tabs
            </button>
            <div v-if="mobileTabOpen" class="mobile-tab-picker__dropdown">
              <button
                v-for="tab in store.workspaceTabs"
                :key="tab.id"
                type="button"
                :class="['mobile-tab-picker__item', tab.id === store.activeViewId && 'mobile-tab-picker__item--active']"
                @click="
                  store.activateView(tab.id);
                  mobileTabOpen = false;
                "
              >
                <span class="mobile-tab-picker__name">{{ tab.title }}</span>
                <small class="mobile-tab-picker__status">{{ tab.status }}</small>
                <span
                  class="mobile-tab-picker__menu"
                  title="Open the tab actions menu (Focus, Edit, Save scrollback, Clear, Restart, Close, split moves) — same options as the right-click context menu."
                  @click.stop="onMobileTabMenu($event, tab.id)"
                  >☰</span
                >
              </button>
            </div>
          </div>
          <div v-if="mobileTabOpen" class="mobile-tab-picker__backdrop" @click="mobileTabOpen = false"></div>

          <!-- Mobile: explicit "show keyboard" button. The tap-to-focus path
               in the terminal touch handler can miss when the synthesized
               click is suppressed by preventDefault, leaving the user with a
               visible terminal but no way to type. This button is a
               deterministic focus path: it picks the active xterm helper
               textarea and focuses it, which triggers the IME on Android /
               iOS reliably. -->
          <button
            type="button"
            class="mobile-keyboard-btn"
            title="Open the on-screen keyboard and focus the active terminal — use when the keyboard doesn't appear after tapping the terminal."
            aria-label="Show keyboard"
            @click="showMobileKeyboard"
          >
            ⌨
          </button>

          <TabActions
            @toggle-tab-picker="onToggleTabPicker"
            @disband-split="store.disbandSplit()"
            @open-layout-picker="onOpenLayoutPicker"
            @quick-fix="onToolbarQuickFix"
            @create-worktree="onToolbarCreateWorktree"
            @create-task="store.openTaskWorkspaceDialog()"
            @edit-workspace="onToolbarEditWorkspace"
            @delete-workspace="onToolbarDeleteWorkspace"
          />
        </div>

        <!-- Welcome screen (no workspaces yet) -->
        <WelcomeScreen
          v-if="showWelcome"
          @new-workspace="store.openNewWorkspaceFlow()"
          @open-settings="store.openSettingsDialog()"
        />

        <!-- Workspace stage (grid or single pane) -->
        <WorkspaceStage v-else-if="store.payload" />

        <!-- Mobile composer input bar (remote clients only; hidden on
             desktop viewports via mobile.css). Sits as the last grid row of
             workspace-main so it pins above the on-screen keyboard — the
             visualViewport handler in useGlobalEvents shrinks the document
             to the visible area when the keyboard opens. -->
        <MobileInputBar />
      </section>
    </main>

    <!-- Notification center — direct child of .frame so pinned mode can
         occupy the 3rd grid column. Unpinned mode uses position: fixed. -->
    <NotificationCenter />
  </div>

  <!-- Bootstrap error -->
  <BootstrapError v-if="store.bootstrapError" :message="store.bootstrapError" />

  <!-- Dialog overlay -->
  <DialogOverlay />

  <!-- Context menu -->
  <ContextMenu />

  <!-- Layout picker -->
  <LayoutPicker />

  <!-- Tab picker dropdown -->
  <TabPickerDropdown :anchor-rect="tabPickerAnchor" @close="tabPickerAnchor = null" />

  <!-- Return-to-app banner (shows when focus returns after >30s with waiting sessions) -->
  <ReturnToAppBanner />

  <!-- Notification toast — suppressed when the dock is pinned (the dock
       itself plays that role). Sound alert still fires via useNotificationCapture. -->
  <NotificationToast v-if="!notifStore.pinned" :toast="latestToast" @dismissed="latestToast = null" />

  <!-- Sticky toasts (background-deletion errors, etc.). These never auto-hide
       so the user can take action even if the original flow has moved on. -->
  <PersistentToastStack />

  <!-- Manual refresh indicator — shown briefly when the user triggers the
       pull-up-to-refresh gesture on a mobile terminal. Plain visual ack so
       the user knows the swipe-past-bottom was registered (the actual state
       update happens silently via the WS once /api/state lands). -->
  <Transition name="refresh-banner">
    <div v-if="showRefreshBanner" class="manual-refresh-banner" role="status" aria-live="polite">
      <span class="manual-refresh-banner__spinner" aria-hidden="true">⟳</span>
      <span>Refreshing…</span>
    </div>
  </Transition>

  <!-- SSH modal prompts rendered as teleported overlays driven by the SSH
       store. They sit outside the normal DialogOverlay because they're
       triggered by backend events rather than user navigation, and can
       coexist with other dialogs. -->
  <Teleport to="body">
    <div v-if="sshStore.authPrompt" class="overlay ssh-overlay">
      <SshAuthPrompt :prompt="sshStore.authPrompt" />
    </div>
    <div v-if="sshStore.hostKeyWarning" class="overlay ssh-overlay">
      <SshHostKeyWarning :warning="hostKeyWarning" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, onErrorCaptured, onMounted, onUnmounted, ref, watch } from "vue";
import type { ComponentPublicInstance } from "vue";
import type { Transport } from "./transport.js";
import { apiKey } from "./types/keys.js";
import { useAppStore } from "./stores/app.js";
import { useGlobalEvents } from "./composables/useGlobalEvents.js";
import { useAttentionSync } from "./composables/useAttentionSync.js";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts.js";
import { useSidebarResize } from "./composables/useSidebarResize.js";
import { useNotificationDockResize } from "./composables/useNotificationDockResize.js";
import { writeSidebarCollapsed, readSidebarWidth, readNotificationDockWidth } from "./app/helpers.js";
import ProfileBar from "./components/layout/ProfileBar.vue";
import SidebarPanel from "./components/layout/SidebarPanel.vue";
import TabStrip from "./components/layout/TabStrip.vue";
import TabActions from "./components/layout/TabActions.vue";
import MobileInputBar from "./components/layout/MobileInputBar.vue";
import WorkspaceHero from "./components/workspace/WorkspaceHero.vue";
import WelcomeScreen from "./components/workspace/WelcomeScreen.vue";
import WorkspaceStage from "./components/workspace/WorkspaceStage.vue";
import DialogOverlay from "./components/dialogs/DialogOverlay.vue";
import RemoteAccessPanel from "./components/layout/RemoteAccessPanel.vue";
import BootstrapError from "./components/layout/BootstrapError.vue";
import ContextMenu from "./components/layout/ContextMenu.vue";
import LayoutPicker from "./components/layout/LayoutPicker.vue";
import TabPickerDropdown from "./components/layout/TabPickerDropdown.vue";
import NotificationCenter from "./components/layout/NotificationCenter.vue";
import NotificationToast from "./components/layout/NotificationToast.vue";
import PersistentToastStack from "./components/layout/PersistentToastStack.vue";
import ReturnToAppBanner from "./components/layout/ReturnToAppBanner.vue";
import SshAuthPrompt from "./components/ssh/SshAuthPrompt.vue";
import SshHostKeyWarning from "./components/ssh/SshHostKeyWarning.vue";
import { useNotificationCapture } from "./composables/useNotificationCapture.js";
import { useReviewNotifications } from "./composables/useReviewNotifications.js";
import { usePipelineNotifications } from "./composables/usePipelineNotifications.js";
import { useNotificationStore } from "./stores/notifications.js";
import { useSshStore } from "./stores/ssh.js";

const api = inject(apiKey);
const store = useAppStore();
const notifStore = useNotificationStore();
const sshStore = useSshStore();
const { latestToast } = useNotificationCapture();
useReviewNotifications(latestToast);
usePipelineNotifications();

sshStore.init(api as Transport);
sshStore.bindEvents();
sshStore.load();

const frameRef = ref<HTMLElement | null>(null);
const sidebarRef = ref<HTMLElement | null>(null);
const sidebarOpen = ref(false);
const mobileTabOpen = ref(false);
const tabPickerAnchor = ref<DOMRect | null>(null);

const sidebarCollapseLabel = computed(() => (store.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"));

const hasAnyStarred = computed(() => store.filteredWorkspaces.some((ws) => ws.starred));
const showWelcome = computed(() => store.payload && store.filteredWorkspaces.length === 0);

const versionLabel = computed(() => {
  const v = store.payload?.meta?.appVersion;
  return v ? `v${v}` : "Version unavailable";
});

const repositoryUrl = computed(() => store.payload?.meta?.repositoryUrl || "");

// -- Version check --
const versionCheck = computed(() => store.payload?.meta?.versionCheck);
const versionsBehind = computed(() => versionCheck.value?.versionsBehind || 0);
const latestVersionLabel = computed(() => versionCheck.value?.latestVersion || "");
// Always use GitHub's /releases/latest redirect rather than the cached
// html_url of a specific tag. The cache can lag behind the live releases
// list (24h throttle, plus the user can sit on a stale cache between fetch
// and click), so a hard-coded tag URL would sometimes land the user on a
// release that's no longer the latest by the time they click. /latest is
// resolved server-side at click time and always redirects to the most
// recent non-prerelease release.
const latestReleaseUrl = computed(() =>
  repositoryUrl.value ? `${repositoryUrl.value.replace(/\/+$/, "")}/releases/latest` : "",
);

const versionToastShown = ref(false);
watch(versionCheck, (check) => {
  if (!check || versionToastShown.value) return;
  versionToastShown.value = true;
  const versionsBehindCount = check.versionsBehind ?? 0;
  if (versionsBehindCount > 0) {
    const label = versionsBehindCount === 1 ? "1 version" : `${versionsBehindCount} versions`;
    latestToast.value = {
      id: crypto.randomUUID(),
      title: "Update available",
      body: `You are ${label} behind (latest: v${check.latestVersion}).`,
      kind: "info",
      at: new Date().toISOString(),
      tier: 1,
      urgency: "normal",
      category: "info",
    };
  }
});

function toggleSidebarCollapse(): void {
  store.sidebarCollapsed = !store.sidebarCollapsed;
  writeSidebarCollapsed(store.sidebarCollapsed);
}

function openSidebar(): void {
  sidebarOpen.value = true;
}

function closeSidebar(): void {
  sidebarOpen.value = false;
}

// Mobile keyboard rescue. xterm.js renders an invisible helper textarea
// that receives the IME input; tapping the terminal canvas should focus
// it (and on mobile the OS pops up the on-screen keyboard), but the touch
// handler in terminal-controller.ts preventDefaults touchstart to take
// over pinch/scroll, which suppresses the synthesized click and forces
// the controller to detect "tap" itself from touchend coordinates. That
// detection can miss (multi-finger touches, fast double-taps, dragged
// fingers under 10 px). When it does, the user is left looking at a
// visible terminal with no way to type. This button finds the active
// xterm helper textarea by DOM query and focuses it directly — that
// always brings up the IME because the focus call happens inside a real
// `click` event handler, which counts as a user gesture.
function showMobileKeyboard(): void {
  // Only act when the active pane actually has a terminal in it. Falling
  // back to the first xterm anywhere on the page is wrong — the user
  // would land typing into a hidden background tab's terminal, which is
  // both surprising and a subtle security issue (keystrokes routed to
  // the wrong workspace). When there's no terminal in the active pane
  // (Files, Docker, Git, Azure, etc.) the button is a no-op.
  const active = document.querySelector<HTMLTextAreaElement>(".workspace-pane--active .xterm-helper-textarea");
  if (!active) return;
  // scrollIntoView is harmless here and helps when the keyboard slides up
  // and would otherwise cover the cursor.
  try {
    active.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    // Older WebViews — ignore.
  }
  active.focus({ preventScroll: false });
}

function onEditWorkspace(workspaceId: string): void {
  const ws = (store.payload?.appState?.workspaces || []).find((w) => w.id === workspaceId);
  if (ws) store.openWorkspaceDialog(ws);
}

function onToolbarQuickFix(): void {
  const ws = store.activeWorkspace;
  if (ws?.kind === "github") store.openGitHubQuickFixWizard();
  else store.openQuickFixWizard();
}

function onToolbarCreateWorktree(): void {
  const wsId = store.myActiveWorkspaceId;
  if (wsId) store.createWorktreeWithDialog(wsId);
}

function onToolbarEditWorkspace(): void {
  const wsId = store.myActiveWorkspaceId;
  if (wsId) onEditWorkspace(wsId);
}

function onToolbarDeleteWorkspace(): void {
  const wsId = store.myActiveWorkspaceId;
  if (wsId) store.deleteWorkspace(wsId);
}

function onTabContextMenu(event: { x: number; y: number; viewId: string }): void {
  store.showContextMenu(event.x, event.y, event.viewId);
}

function onMobileTabMenu(event: MouseEvent, viewId: string): void {
  const btn = (event.currentTarget || event.target) as Element;
  const rect = btn.getBoundingClientRect();
  mobileTabOpen.value = false;
  store.showContextMenu(rect.left, rect.bottom + 4, viewId);
}

function onToggleTabPicker(event: MouseEvent): void {
  if (tabPickerAnchor.value) {
    tabPickerAnchor.value = null;
  } else {
    const btn = (event.target ?? event.currentTarget) as Element | null;
    tabPickerAnchor.value = btn ? btn.getBoundingClientRect() : null;
  }
}

function onOpenLayoutPicker(event: MouseEvent): void {
  const btn = (event.target ?? event.currentTarget) as Element | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.showLayoutPicker((btn ? btn.getBoundingClientRect() : null) as any);
}

// Pull-up-to-refresh visual ack. The terminal controller dispatches
// `strideterm:manual-refresh` when the user swipes past the buffer
// bottom; we flash a banner for ~1.2 s so the gesture has a visible
// confirmation. The actual state refetch is owned by transport.refresh().
const showRefreshBanner = ref(false);
let refreshBannerTimer = 0;
function onManualRefreshEvent(): void {
  showRefreshBanner.value = true;
  window.clearTimeout(refreshBannerTimer);
  refreshBannerTimer = window.setTimeout(() => {
    showRefreshBanner.value = false;
  }, 1200);
}

onMounted(() => {
  const savedWidth = readSidebarWidth();
  if (savedWidth && frameRef.value) {
    frameRef.value.style.setProperty("--sidebar-width", `${savedWidth}px`);
  }
  const savedDockWidth = readNotificationDockWidth();
  if (savedDockWidth && frameRef.value) {
    frameRef.value.style.setProperty("--notif-dock-width", `${savedDockWidth}px`);
  }
  window.addEventListener("open-tab-picker", onOpenTabPickerEvent);
  window.addEventListener("strideterm:manual-refresh", onManualRefreshEvent);
  // Ctrl+Shift+N / Cmd+Shift+N from main process → open the new-window profile picker
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).strideterm?.onNewWindowShortcut?.(() => {
    store.openNewWindowModal();
  });

  // Multi-viewer input lease: typing into a terminal another viewer is
  // actively controlling gets blocked by the backend; offer a gentle
  // take-over instead of silently interleaving two users' keystrokes.
  const transportApi = store.getApi();
  transportApi?.onTerminalInputBlocked?.(({ sessionId, ownerLabel }: { sessionId: string; ownerLabel: string }) => {
    store.openDialog("ConfirmDialog", {
      eyebrow: "Terminal",
      title: "Terminal is controlled elsewhere",
      message: `This terminal is being controlled from ${ownerLabel}. Take control?\n\nTask dashboard buttons (Pause/Resume/Stop) keep working from every window either way.`,
      confirmLabel: "Take control",
      cancelLabel: "Just watch",
      onConfirm: async () => {
        store.closeDialog();
        try {
          await transportApi?.takeSessionControl?.(sessionId);
        } catch {
          // Best-effort — the next keystroke re-prompts if it failed.
        }
      },
      onCancel: () => store.closeDialog(),
    });
  });

  // Main asks "really close the last window?" when workspaces or running
  // task agents would be lost. Show our ConfirmDialog and reply via IPC —
  // until we respond, the close stays prevented in main.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).strideterm;
  api?.onConfirmCloseRequest?.(
    (payload: { workspaceCount: number; runningTaskCount: number; runningTaskWorkspaceNames: string[] }) => {
      const lines: string[] = [];
      if (payload.runningTaskCount > 0) {
        const names = payload.runningTaskWorkspaceNames.slice(0, 5).join(", ");
        const extra =
          payload.runningTaskWorkspaceNames.length > 5 ? `, +${payload.runningTaskWorkspaceNames.length - 5} more` : "";
        lines.push(
          `${payload.runningTaskCount} task agent${payload.runningTaskCount === 1 ? "" : "s"} still running: ${names}${extra}.`,
        );
      }
      if (payload.workspaceCount > 0) {
        lines.push(
          `${payload.workspaceCount} workspace${payload.workspaceCount === 1 ? "" : "s"} will be closed and any running terminals killed.`,
        );
      }
      lines.push("Are you sure you want to quit strIDEterm?");
      const respond = (confirmed: boolean) => {
        store.closeDialog();
        try {
          void api?.respondConfirmClose?.(confirmed);
        } catch {
          // Best-effort — if IPC is torn down we drop silently.
        }
      };
      store.openDialog("ConfirmDialog", {
        eyebrow: "Quit",
        title: "Close strIDEterm?",
        message: lines.join("\n\n"),
        confirmLabel: "Quit anyway",
        cancelLabel: "Keep open",
        danger: true,
        onConfirm: () => respond(true),
        onCancel: () => respond(false),
      });
    },
  );
});

onUnmounted(() => {
  window.removeEventListener("open-tab-picker", onOpenTabPickerEvent);
  window.removeEventListener("strideterm:manual-refresh", onManualRefreshEvent);
  window.clearTimeout(refreshBannerTimer);
});

function onOpenTabPickerEvent(event: Event): void {
  const detail = (event as CustomEvent).detail as { anchorRect?: DOMRect } | undefined;
  tabPickerAnchor.value = detail?.anchorRect ?? null;
}

onErrorCaptured((err, instance: ComponentPublicInstance | null, info) => {
  console.error(
    `[ErrorBoundary] Unhandled error in ${(instance as any)?.$options?.name || "component"} (${info}):`, // eslint-disable-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: Vue internal $options is not fully typed
    err,
  );
  return false;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hostKeyWarning = computed(() => sshStore.hostKeyWarning as any);

useGlobalEvents();
useAttentionSync(api as Transport);
useKeyboardShortcuts(api as Transport, { onNewWorkspace: () => store.openNewWorkspaceFlow() });
useSidebarResize(frameRef, sidebarRef);
useNotificationDockResize(frameRef);
</script>

<style>
.splash {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #141416;
  gap: 20px;
  padding: 20px;
}
.splash__logo {
  max-width: 480px;
  width: 90%;
  border-radius: 8px;
  opacity: 0.92;
}
.splash__progress {
  width: 220px;
  height: 3px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 2px;
  overflow: hidden;
}
.splash__bar {
  height: 100%;
  width: 0%;
  background: #ffa424;
  border-radius: 2px;
  animation: splash-fill 28s cubic-bezier(0.1, 0.4, 0.2, 1) forwards;
}
@keyframes splash-fill {
  0% {
    width: 0%;
  }
  15% {
    width: 30%;
  }
  40% {
    width: 55%;
  }
  70% {
    width: 78%;
  }
  90% {
    width: 90%;
  }
  100% {
    width: 97%;
  }
}

/* Pull-up-to-refresh banner. Sits at the top of the viewport so it doesn't
   overlap the just-bottom area the user was swiping. The spinner glyph
   rotates while visible to make the ack feel like work-in-progress.
   `env(safe-area-inset-top)` keeps the banner below an iPhone notch /
   Dynamic Island instead of disappearing under it. */
.manual-refresh-banner {
  position: fixed;
  top: calc(12px + env(safe-area-inset-top, 0px));
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--panel), #000 20%);
  border: 1px solid var(--accent);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.manual-refresh-banner__spinner {
  display: inline-block;
  color: var(--accent);
  font-size: 15px;
  animation: refresh-spin 0.8s linear infinite;
}
@keyframes refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
.refresh-banner-enter-active,
.refresh-banner-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}
.refresh-banner-enter-from,
.refresh-banner-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}
.refresh-banner-enter-to,
.refresh-banner-leave-from {
  opacity: 1;
  transform: translate(-50%, 0);
}
</style>
