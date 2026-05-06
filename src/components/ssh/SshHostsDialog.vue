<template>
  <div class="dialog ssh-hosts-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">SSH</p>
        <h2>Manage Hosts</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <div class="ssh-hosts-dialog__toolbar">
      <input
        v-model="searchQuery"
        type="text"
        class="input"
        placeholder="Search hosts..."
        title="Filter the host list by name, address, or tag (case-insensitive substring match)."
      />
      <button
        type="button"
        class="button"
        title="Open the empty SSH host editor — fill in name, host, port, user, auth, optional jump chain, and post-login command, then Save to add it to the host book."
        @click="store.openSshHostEditor()"
      >
        + Add Host
      </button>
    </div>

    <div class="ssh-hosts-dialog__list">
      <div v-if="filteredHosts.length === 0" class="empty-state">
        <p>No SSH hosts found.</p>
      </div>
      <div v-for="host in filteredHosts" :key="host.id" class="ssh-host-card">
        <div class="ssh-host-card__info">
          <strong class="ssh-host-card__name">{{ host.name }}</strong>
          <span class="ssh-host-card__address">{{ host.username }}@{{ host.host }}:{{ host.port || 22 }}</span>
          <div v-if="host.tags && host.tags.length" class="ssh-host-card__tags">
            <span v-for="tag in host.tags" :key="tag" class="ssh-host-card__tag">{{ tag }}</span>
          </div>
        </div>
        <div class="ssh-host-card__actions">
          <button
            type="button"
            class="button button--ghost button--small"
            title="Open the SSH host editor for this entry — change name, host, auth, jump hosts, post-login command, and other advanced options."
            @click="store.openSshHostEditor(host)"
          >
            Edit
          </button>
          <button
            type="button"
            class="button button--ghost button--small"
            title="Open a new SSH tab in the active workspace using this saved host — the host's auth and post-login command are applied automatically."
            @click="connectHost(host)"
          >
            Connect
          </button>
          <button
            type="button"
            class="button button--danger button--small"
            title="Delete this saved host from the host book after a confirmation prompt. Tabs that referenced it will fail to reconnect until you re-add or pick a different host."
            @click="deleteHost(host)"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useSshStore } from "../../stores/ssh.js";
import { useAppStore } from "../../stores/app.js";
import type { SshHost as BaseSshHost } from "../../../electron/shared/types/ssh.js";

// Extended host type — backend returns additional UI fields
interface SshHost extends BaseSshHost {
  name?: string;
  tags?: string[];
}

const emit = defineEmits<{
  (e: "cancel"): void;
}>();

const sshStore = useSshStore();
const store = useAppStore();
const searchQuery = ref("");

onMounted(() => {
  sshStore.load();
});

const filteredHosts = computed((): SshHost[] => {
  const query = searchQuery.value.toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sshStore.hosts as any[]).filter(
    (h: SshHost) =>
      (h.name || "").toLowerCase().includes(query) ||
      h.host.toLowerCase().includes(query) ||
      (h.tags || []).some((t) => t.toLowerCase().includes(query)),
  ) as SshHost[];
});

async function deleteHost(host: SshHost): Promise<void> {
  if (confirm(`Delete SSH host '${host.name}'?`)) {
    await sshStore.deleteHost(host.id);
  }
}

async function connectHost(host: SshHost): Promise<void> {
  // To connect, we open a new tab with kind=ssh and this host id
  // This requires app logic to handle adding a tab template equivalent
  emit("cancel");
  await store.quickAddTemplateTab("", host.name || host.host || "", "", { kind: "ssh", sshHostId: host.id });
}
</script>

<style scoped>
.ssh-hosts-dialog {
  width: min(600px, 100%);
  height: min(600px, 85vh);
  display: flex;
  flex-direction: column;
}
.ssh-hosts-dialog__toolbar {
  display: flex;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.ssh-hosts-dialog__toolbar .input {
  flex: 1;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px;
  border-radius: 4px;
}
.ssh-hosts-dialog__list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ssh-host-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
}
.ssh-host-card__info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ssh-host-card__name {
  font-size: 14px;
  font-weight: 600;
}
.ssh-host-card__address {
  font-size: 12px;
  color: var(--muted);
  font-family: var(--font-mono);
}
.ssh-host-card__tags {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.ssh-host-card__tag {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
}
.ssh-host-card__actions {
  display: flex;
  gap: 6px;
}
.empty-state {
  text-align: center;
  color: var(--muted);
  padding: 32px;
}
</style>
