<template>
  <div v-if="rows.length" class="sandbox-requests">
    <div
      v-for="record in rows"
      :key="record.key"
      class="sandbox-request"
      data-testid="sandbox-request"
      :data-outcome="record.outcome"
    >
      <p class="sandbox-request__source">{{ record.label }}</p>
      <p class="sandbox-request__destination" data-testid="sandbox-destination">
        <strong class="sandbox-request__domain">{{ split(record).domain }}</strong>
        <small v-if="record.destination !== split(record).domain" class="sandbox-request__host">{{
          record.destination
        }}</small>
      </p>
      <template v-if="record.outcome === 'pending'">
        <p class="sandbox-request__hint">Waiting for your answer — it is refused if you do not give one.</p>
        <div class="notification-item__quick-actions">
          <button
            type="button"
            class="quick-action"
            data-testid="sandbox-allow-workspace"
            :disabled="record.busy"
            @click.stop="store.decide(api!, record.key, 'workspace')"
          >
            Allow for this workspace
          </button>
          <button
            type="button"
            class="quick-action"
            data-testid="sandbox-allow-once"
            :disabled="record.busy"
            @click.stop="store.decide(api!, record.key, 'once')"
          >
            Allow this time
          </button>
          <button
            type="button"
            class="quick-action"
            data-testid="sandbox-deny"
            :disabled="record.busy"
            @click.stop="store.decide(api!, record.key, 'deny')"
          >
            Deny
          </button>
        </div>
      </template>
      <template v-else>
        <p class="sandbox-request__outcome" data-testid="sandbox-outcome">{{ SANDBOX_OUTCOME_TEXT[record.outcome] }}</p>
        <div
          v-if="record.outcome === 'refused' || record.outcome === 'expired'"
          class="notification-item__quick-actions"
        >
          <button
            type="button"
            class="quick-action"
            data-testid="sandbox-allow-later"
            :disabled="record.busy"
            @click.stop="store.allowForWorkspace(api!, record.key)"
          >
            Allow for this workspace
          </button>
        </div>
      </template>
    </div>
  </div>
  <p v-else class="notification-item__body" :title="fallback">{{ fallback }}</p>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import { apiKey } from "../../types/keys.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { SANDBOX_OUTCOME_TEXT, useSandboxRequestsStore } from "../../stores/sandbox-requests.js";
import type { SandboxRequestRecord } from "../../stores/sandbox-requests.js";
import { splitRegistrableDomain } from "../../lib/sandbox-request-text.js";
import type { Transport } from "../../transport.js";

const props = defineProps<{ workspaceId: string; fallback: string }>();

const api = inject<Transport>(apiKey);
const store = useSandboxRequestsStore();
const notifStore = useNotificationStore();

// An entry the user removed from the history (or the caps dropped) takes its request with it.
const rows = computed(() =>
  store.records.filter(
    (record) => record.workspaceId === props.workspaceId && notifStore.findEventBySourceAlertId(record.alertId),
  ),
);

function split(record: SandboxRequestRecord): { prefix: string; domain: string } {
  return splitRegistrableDomain(record.host);
}
</script>

<style scoped>
.sandbox-requests {
  display: grid;
  gap: 8px;
}
.sandbox-request {
  display: grid;
  gap: 2px;
}
.sandbox-request p {
  margin: 0;
}
.sandbox-request__source,
.sandbox-request__hint {
  color: var(--muted);
  font-size: 11px;
}
.sandbox-request__domain {
  font-size: 13px;
}
.sandbox-request__host {
  margin-left: 6px;
  color: var(--muted);
  font-size: 11px;
}
.sandbox-request__outcome {
  font-size: 12px;
}
</style>
