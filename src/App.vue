<template>
  <div
    ref="frameRef"
    class="frame"
    :class="{
      'frame--remote': api?.isRemote,
      'frame--sidebar-collapsed': store.sidebarCollapsed,
    }"
  >
    <div class="sidebar-backdrop" data-role="sidebar-backdrop" @click="closeSidebar"></div>

    <aside ref="sidebarRef" class="sidebar">
      <div class="sidebar__head">
        <h1 class="brand">str<em>IDE</em>term</h1>
        <div class="sidebar__tools">
          <button type="button" class="sidebar__icon-btn" title="Add workspace" @click="store.openNewWorkspaceFlow()">
            +
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
          <button type="button" class="sidebar__icon-btn" title="Profiles" @click="store.openProfilesDialog()">
            ☰
          </button>
          <button type="button" class="sidebar__icon-btn" title="Settings" @click="store.openSettingsDialog()">
            ⚙
          </button>
          <button type="button" class="sidebar__icon-btn" title="Help" @click="store.openHelpDialog()">?</button>
        </div>
      </div>

      <ProfileBar @click="store.openProfilesDialog()" />
      <SidebarPanel
        @activate="closeSidebar"
        @create-worktree="store.createWorktreeWithDialog($event)"
        @edit-workspace="onEditWorkspace($event)"
        @delete-workspace="store.deleteWorkspace($event)"
        @add-plugin-workspace="store.openNewWorkspaceFlow()"
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
            @rename-tab="store.renameTabWithDialog($event)"
            @close-tab="store.closeTab($event)"
            @contextmenu-tab="onTabContextMenu"
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
              </button>
            </div>
          </div>
          <div v-if="mobileTabOpen" class="mobile-tab-picker__backdrop" @click="mobileTabOpen = false"></div>

          <button
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
          />
        </div>

        <!-- Welcome screen (no workspaces yet) -->
        <WelcomeScreen v-if="showWelcome" @new-workspace="store.openNewWorkspaceFlow()" />

        <!-- Terminal + pane stage -->
        <PaneStage v-else-if="store.payload" />
      </section>
    </main>
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

  <!-- Notification center panel -->
  <NotificationCenter />

  <!-- Notification toast -->
  <NotificationToast :toast="latestToast" @dismissed="latestToast = null" />
</template>

<script setup>
import { computed, inject, onErrorCaptured, onMounted, ref, watch } from "vue";
import { useAppStore } from "./stores/app.js";
import { useGlobalEvents } from "./composables/useGlobalEvents.js";
import { useAttentionSync } from "./composables/useAttentionSync.js";
import { useKeyboardShortcuts } from "./composables/useKeyboardShortcuts.js";
import { useSidebarResize } from "./composables/useSidebarResize.js";
import { writeSidebarCollapsed, readSidebarWidth } from "./app/helpers.js";
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
import { useNotificationCapture } from "./composables/useNotificationCapture.js";
import { useNotificationStore } from "./stores/notifications.js";

const api = inject("api");
const store = useAppStore();
const notifStore = useNotificationStore();
const { latestToast } = useNotificationCapture();

const frameRef = ref(null);
const sidebarRef = ref(null);
const mobileTabOpen = ref(false);
const tabPickerAnchor = ref(null);

const sidebarCollapseLabel = computed(() => (store.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"));

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
  if (check.versionsBehind > 0) {
    const label = check.versionsBehind === 1 ? "1 version" : `${check.versionsBehind} versions`;
    latestToast.value = {
      id: crypto.randomUUID(),
      title: "Update available",
      body: `You are ${label} behind (latest: v${check.latestVersion}).`,
      kind: "info",
      at: new Date().toISOString(),
      read: false,
    };
  }
});

function toggleSidebarCollapse() {
  store.sidebarCollapsed = !store.sidebarCollapsed;
  writeSidebarCollapsed(store.sidebarCollapsed);
}

function openSidebar() {
  sidebarRef.value?.classList.add("sidebar--open");
}

function closeSidebar() {
  sidebarRef.value?.classList.remove("sidebar--open");
}

function onEditWorkspace(workspaceId) {
  const ws = (store.payload?.appState?.workspaces || []).find((w) => w.id === workspaceId);
  if (ws) store.openWorkspaceDialog(ws);
}

function onTabContextMenu(event) {
  store.showContextMenu(event.x, event.y, event.viewId);
}

function onToggleTabPicker(event) {
  if (tabPickerAnchor.value) {
    tabPickerAnchor.value = null;
  } else {
    const btn = event?.target || event?.currentTarget;
    tabPickerAnchor.value = btn ? btn.getBoundingClientRect().toJSON() : null;
  }
}

function onOpenLayoutPicker(event) {
  const btn = event?.target || event?.currentTarget;
  store.showLayoutPicker(btn ? btn.getBoundingClientRect().toJSON() : null);
}

onMounted(() => {
  const savedWidth = readSidebarWidth();
  if (savedWidth && frameRef.value) {
    frameRef.value.style.setProperty("--sidebar-width", `${savedWidth}px`);
  }
});

onErrorCaptured((err, instance, info) => {
  console.error(`[ErrorBoundary] Unhandled error in ${instance?.$options?.name || "component"} (${info}):`, err);
  return false;
});

useGlobalEvents();
useAttentionSync(api);
useKeyboardShortcuts(api, { onNewWorkspace: () => store.openNewWorkspaceFlow() });
useSidebarResize(frameRef, sidebarRef);
</script>
