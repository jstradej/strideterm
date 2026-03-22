import { defineStore } from "pinia";
import { ref, computed } from "vue";

const STORAGE_KEY = "strideterm-notifications";
const MAX_NOTIFICATIONS = 100;

function loadFromStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToStorage(items) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_NOTIFICATIONS)));
  } catch {
    // Ignore storage failures.
  }
}

export const useNotificationStore = defineStore("notifications", () => {
  const items = ref(loadFromStorage());
  const panelOpen = ref(false);

  const unreadCount = computed(() => items.value.filter((n) => !n.read).length);

  function add({ title, body, kind = "info", workspaceId = "", workspaceName = "", tabName = "", viewId = "" }) {
    const entry = {
      id: crypto.randomUUID(),
      title,
      body,
      kind, // "completed" | "waiting" | "info"
      workspaceId,
      workspaceName,
      tabName,
      viewId,
      at: new Date().toISOString(),
      read: false,
    };
    items.value = [entry, ...items.value].slice(0, MAX_NOTIFICATIONS);
    saveToStorage(items.value);
    return entry;
  }

  function markRead(id) {
    const item = items.value.find((n) => n.id === id);
    if (item && !item.read) {
      item.read = true;
      items.value = [...items.value];
      saveToStorage(items.value);
    }
  }

  function markAllRead() {
    let changed = false;
    for (const item of items.value) {
      if (!item.read) {
        item.read = true;
        changed = true;
      }
    }
    if (changed) {
      items.value = [...items.value];
      saveToStorage(items.value);
    }
  }

  function remove(id) {
    items.value = items.value.filter((n) => n.id !== id);
    saveToStorage(items.value);
  }

  function clearAll() {
    items.value = [];
    saveToStorage(items.value);
    // Also clear backend attention alerts (bells on tabs/workspaces)
    import("./app.js").then(({ useAppStore }) => {
      const appStore = useAppStore();
      const api = appStore.getApi();
      if (api?.clearAllAttention) {
        api.clearAllAttention().then((nextPayload) => {
          if (nextPayload) appStore.payload = nextPayload;
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  function togglePanel() {
    panelOpen.value = !panelOpen.value;
  }

  function closePanel() {
    panelOpen.value = false;
  }

  return {
    items,
    panelOpen,
    unreadCount,
    add,
    markRead,
    markAllRead,
    remove,
    clearAll,
    togglePanel,
    closePanel,
  };
});
