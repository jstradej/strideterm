<template>
  <section class="credentials-tab" data-testid="credentials-settings">
    <h3 class="credentials-tab__title">Stored credentials</h3>
    <p class="credentials-tab__hint">
      Every token, password and key strIDEterm keeps on this computer for another system, across all profiles. The
      values are never shown. Removing one here deletes strIDEterm's copy only: the token stays valid at the provider
      until you revoke it there, and the connection or host stays and asks for it again.
    </p>
    <p v-if="overview && !overview.encryptionAvailable" class="credentials-tab__warn" role="status">
      Secure storage is not available on this computer, so new credentials are kept as plain text in strIDEterm's
      credentials file.
    </p>

    <p v-if="loading && !overview" class="credentials-tab__hint">Loading…</p>
    <p v-else-if="loadFailed" class="credentials-tab__bad" role="alert" data-testid="credentials-load-failed">
      The stored credentials could not be read.
      <button type="button" class="button button--ghost button--small" @click="load">Try again</button>
    </p>
    <p v-else-if="!groups.length" class="credentials-tab__hint" data-testid="credentials-empty">
      strIDEterm stores no credentials for other systems.
    </p>

    <table v-if="groups.length" class="credentials-tab__table">
      <colgroup>
        <col class="credentials-tab__col-kind" />
        <col />
        <col class="credentials-tab__col-status" />
        <col class="credentials-tab__col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">Credential</th>
          <th scope="col">Belongs to</th>
          <th scope="col">Status</th>
          <th scope="col"><span class="credentials-tab__sr">Actions</span></th>
        </tr>
      </thead>
      <tbody v-for="group in groups" :key="group.system" :data-testid="`credentials-${group.system}`">
        <tr class="credentials-tab__group">
          <th scope="rowgroup" colspan="4">{{ group.label }}</th>
        </tr>
        <tr v-for="row in group.rows" :key="row.ref" data-testid="credential-row">
          <td>{{ CREDENTIAL_KIND_LABELS[row.kind] }}</td>
          <td class="credentials-tab__owner">
            <template v-if="row.orphan">—</template>
            <template v-else>
              {{ row.ownerLabel }}<small v-if="row.profileName"> · {{ row.profileName }}</small>
            </template>
          </td>
          <td>
            <span :class="{ 'credentials-tab__muted': row.orphan }">{{ row.orphan ? "Unused" : "In use" }}</span>
            <small v-if="row.storage === 'encrypted'"> · Encrypted</small>
            <span v-else class="credentials-tab__plain"> · Plain text</span>
          </td>
          <td>
            <div class="credentials-tab__actions">
              <button
                v-if="row.manageUrl"
                type="button"
                class="button button--ghost button--small"
                :disabled="busy"
                @click="manage(row)"
              >
                Manage at provider
              </button>
              <button
                v-if="canChange(row)"
                type="button"
                class="button button--ghost button--small"
                :disabled="busy || otherProfile(row)"
                :title="otherProfile(row) ? `Belongs to profile ${row.profileName}. Switch to it to change this.` : ''"
                @click="emit('change', row)"
              >
                Change
              </button>
              <button
                type="button"
                class="button button--ghost button--small"
                :disabled="busy"
                title="Delete strIDEterm's copy. Nothing is revoked at the provider."
                @click="remove(row)"
              >
                Remove
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="orphans.length" class="credentials-tab__bulk">
      <button
        type="button"
        class="button button--ghost"
        :disabled="busy"
        data-testid="credentials-remove-orphans"
        @click="removeOrphans"
      >
        Remove unused ({{ orphans.length }})
      </button>
      <small>Unused credentials are not referenced by any connection, host or key.</small>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from "vue";
import { apiKey } from "../../../types/keys.js";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import type { Transport } from "../../../transport.js";
import {
  CREDENTIAL_KIND_LABELS,
  CREDENTIAL_SYSTEMS,
  CREDENTIAL_SYSTEM_LABELS,
  type CredentialOverview,
  type CredentialRow,
} from "../../../../electron/shared/credential-overview.js";

const emit = defineEmits<{ change: [row: CredentialRow] }>();
const api = inject<Transport>(apiKey);
const store = useAppStore();

const overview = ref<CredentialOverview | null>(null);
const loading = ref(false);
const loadFailed = ref(false);
const busy = ref(false);

const currentProfileId = computed(() => String(store.myActiveProfileId || "default"));
const groups = computed(() =>
  CREDENTIAL_SYSTEMS.map((system) => ({
    system,
    label: CREDENTIAL_SYSTEM_LABELS[system],
    rows: (overview.value?.rows ?? []).filter((row) => row.system === system),
  })).filter((group) => group.rows.length),
);
const orphans = computed(() => (overview.value?.rows ?? []).filter((row) => row.orphan));

function otherProfile(row: CredentialRow): boolean {
  return Boolean(row.profileId) && row.profileId !== currentProfileId.value;
}
function canChange(row: CredentialRow): boolean {
  return !row.orphan && row.system !== "connection";
}

async function load() {
  const list = api?.listCredentials;
  if (!list) return;
  loading.value = true;
  loadFailed.value = false;
  try {
    overview.value = await list();
  } catch (error) {
    loadFailed.value = true;
    useNotificationStore().showError("Could not read the stored credentials", error);
  } finally {
    loading.value = false;
  }
}

async function run(title: string, action: () => Promise<void>) {
  busy.value = true;
  try {
    await action();
  } catch (error) {
    useNotificationStore().showError(title, error);
  } finally {
    busy.value = false;
    await load();
  }
}

function confirmation(row: CredentialRow) {
  const what = CREDENTIAL_KIND_LABELS[row.kind].toLowerCase();
  const owner = row.orphan
    ? "no connection uses it"
    : `${row.ownerLabel}${row.profileName ? ` (${row.profileName})` : ""}`;
  const lines = [
    `${CREDENTIAL_SYSTEM_LABELS[row.system]}, ${owner}.`,
    `strIDEterm forgets this ${what}. It is not revoked at the provider, and the ${row.orphan ? "secret" : "connection"} stays${row.orphan ? " gone" : " and asks for it again"}.`,
  ];
  if (row.kind === "ssh-private-key") {
    lines.push("The private key is deleted for good: if you have no other copy of it, it cannot be recovered.");
  }
  return { title: `Remove ${what}?`, message: lines.join(" ") };
}

async function remove(row: CredentialRow) {
  const removeCredential = api?.removeCredential;
  if (!removeCredential) return;
  const { title, message } = confirmation(row);
  const confirmed = await store.confirmInApp({ title, message, confirmLabel: "Remove", danger: true });
  if (!confirmed) return;
  await run("Could not remove the credential", async () => {
    await removeCredential(row.ref);
  });
}

async function removeOrphans() {
  const removeUnused = api?.removeOrphanCredentials;
  if (!removeUnused) return;
  const count = orphans.value.length;
  const confirmed = await store.confirmInApp({
    title: "Remove unused credentials?",
    message: `${count} stored ${count === 1 ? "credential is" : "credentials are"} not used by any connection, host or key. They will be deleted from strIDEterm; nothing is revoked at the providers.`,
    confirmLabel: `Remove ${count}`,
    danger: true,
  });
  if (!confirmed) return;
  await run("Could not remove the unused credentials", async () => {
    await removeUnused();
  });
}

async function manage(row: CredentialRow) {
  const openExternal = api?.openExternal;
  if (!openExternal || !row.manageUrl) return;
  try {
    await openExternal(row.manageUrl);
  } catch (error) {
    useNotificationStore().showError("Could not open the provider's page", error);
  }
}

onMounted(load);
</script>

<style scoped>
.credentials-tab {
  display: grid;
  gap: 10px;
}
.credentials-tab__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.credentials-tab__hint,
.credentials-tab__warn,
.credentials-tab__bad {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
}
.credentials-tab__hint {
  color: var(--muted);
}
.credentials-tab__bad {
  color: var(--danger, var(--text));
}
.credentials-tab__table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12px;
}
.credentials-tab__col-kind {
  width: 30%;
}
.credentials-tab__col-status {
  width: 22%;
}
.credentials-tab__col-actions {
  width: 300px;
}
.credentials-tab__table th,
.credentials-tab__table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: middle;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.credentials-tab__table thead th {
  color: var(--muted);
  font-weight: 500;
}
.credentials-tab__table .credentials-tab__group th {
  padding-top: 16px;
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
}
.credentials-tab__table tbody:first-of-type .credentials-tab__group th {
  padding-top: 8px;
}
.credentials-tab__table tbody tr[data-testid="credential-row"]:hover td {
  background: var(--hover);
}
.credentials-tab__table small,
.credentials-tab__muted {
  color: var(--muted);
}
.credentials-tab__plain {
  color: var(--warning, var(--danger, var(--text)));
}
.credentials-tab__table td:has(> .credentials-tab__actions) {
  overflow: visible;
}
.credentials-tab__actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.credentials-tab__bulk {
  display: flex;
  gap: 10px;
  align-items: center;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.credentials-tab__bulk small {
  color: var(--muted);
}
.credentials-tab__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
