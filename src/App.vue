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
      'frame--remote-expanded': store.remoteAccessExpanded,
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
          <button type="button" class="sidebar__icon-btn" title="Add workspace" @click="store.openNewWorkspaceFlow()">
            +
          </button>
          <button
            v-if="hasAnyStarred"
            type="button"
            class="sidebar__icon-btn"
            :class="{ 'sidebar__icon-btn--star-active': store.starFilterActive }"
            :title="store.starFilterActive ? 'Show all workspaces' : 'Show starred only'"
            @click="store.starFilterActive = !store.starFilterActive"
          >
            {{ store.starFilterActive ? "★" : "☆" }}
          </button>
          <button
            type="button"
            class="sidebar__icon-btn sidebar__collapse-btn"
            data-role="sidebar-collapse"
            :title="sidebarCollapseLabel"
            :aria-label="sidebarCollapseLabel"
            @click="toggleSidebarCollapse"
          >
            {{ store.sidebarCollapsed ? "▶" : "◀" }}
          </button>
          <button type="button" class="sidebar__icon-btn" title="Settings" @click="store.openSettingsDialog()">
            ⚙
          </button>
          <button type="button" class="sidebar__icon-btn" title="Help" @click="store.openHelpDialog()">?</button>
          <button
            type="button"
            class="sidebar__icon-btn sidebar__close-btn"
            title="Close sidebar"
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
        @add-plugin-workspace="store.openNewWorkspaceFlow()"
        @create-task="store.openTaskWorkspaceDialog()"
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
              :title="`Open latest release (v${latestVersionLabel})`"
              @click="api?.openExternal?.(latestReleaseUrl)"
            >
              {{ versionsBehind }} {{ versionsBehind === 1 ? "update" : "updates" }} behind
            </button>
          </div>
          <button
            v-if="repositoryUrl"
            type="button"
            class="sidebar-footer__repo"
            :title="repositoryUrl"
            @click="api?.openExternal?.(repositoryUrl)"
          >
            GitHub repo
          </button>
        </div>
      </footer>

      <div class="sidebar-resize-handle" data-role="sidebar-resize-handle"></div>
    </aside>

    <main class="workspace">
      <section class="workspace-main">
        <WorkspaceHero />

        <div class="terminal-toolbar">
          <button type="button" class="mobile-hamburger" title="Menu" @click="openSidebar">
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
            <button type="button" class="mobile-tab-picker__trigger" @click="mobileTabOpen = !mobileTabOpen">
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
                <span class="mobile-tab-picker__menu" title="Tab menu" @click.stop="onMobileTabMenu($event, tab.id)"
                  >☰</span
                >
              </button>
            </div>
          </div>
          <div v-if="mobileTabOpen" class="mobile-tab-picker__backdrop" @click="mobileTabOpen = false"></div>

          <button
            v-if="!notifStore.pinned"
            type="button"
            class="notification-bell"
            :class="{ 'notification-bell--has-unread': notifStore.unreadCount > 0 }"
            data-role="notification-bell"
            title="Notifications"
            @click="notifStore.togglePanel()"
          >
            🔔
            <span
              class="notification-bell__badge"
              :class="{ 'notification-bell__badge--visible': notifStore.unreadCount > 0 }"
              >{{
                notifStore.unreadCount > 0 ? (notifStore.unreadCount > 9 ? "9+" : notifStore.unreadCount) : ""
              }}</span
            >
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

        <!-- Terminal + pane stage -->
        <PaneStage v-else-if="store.payload" />
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
import { computed, inject, onErrorCaptured, onMounted, ref, watch } from "vue";
import type { ComponentPublicInstance } from "vue";
import type { Transport } from "./transport.js";
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
import WorkspaceHero from "./components/workspace/WorkspaceHero.vue";
import WelcomeScreen from "./components/workspace/WelcomeScreen.vue";
import PaneStage from "./components/workspace/PaneStage.vue";
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

const api = inject<Transport>("api");
const store = useAppStore();
const notifStore = useNotificationStore();
const sshStore = useSshStore();
const { latestToast } = useNotificationCapture();
useReviewNotifications(latestToast);
usePipelineNotifications();

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
const latestReleaseUrl = computed(() => versionCheck.value?.latestUrl || "");

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
  const wsId = store.payload?.appState?.activeWorkspaceId;
  if (wsId) store.createWorktreeWithDialog(wsId);
}

function onToolbarEditWorkspace(): void {
  const wsId = store.payload?.appState?.activeWorkspaceId;
  if (wsId) onEditWorkspace(wsId);
}

function onToolbarDeleteWorkspace(): void {
  const wsId = store.payload?.appState?.activeWorkspaceId;
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

onMounted(() => {
  const savedWidth = readSidebarWidth();
  if (savedWidth && frameRef.value) {
    frameRef.value.style.setProperty("--sidebar-width", `${savedWidth}px`);
  }
  const savedDockWidth = readNotificationDockWidth();
  if (savedDockWidth && frameRef.value) {
    frameRef.value.style.setProperty("--notif-dock-width", `${savedDockWidth}px`);
  }
});

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
</style>
