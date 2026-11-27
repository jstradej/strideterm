<template>
  <details v-if="showDisclosure" class="agent-usage__accounts usage-accounts">
    <summary>
      Other logins and profiles<span v-if="entry.otherAccounts?.length" class="usage-accounts__count">
        &nbsp;· {{ entry.otherAccounts.length }}
      </span>
    </summary>
    <div class="usage-accounts__list">
      <article
        v-for="account in entry.otherAccounts ?? []"
        :key="account.id"
        class="agent-usage__account usage-account"
      >
        <div class="usage-account__head">
          <strong>{{ account.label }}</strong>
          <button
            v-if="account.status === 'candidate' && canAddAccount"
            type="button"
            class="agent-usage__remove usage-btn"
            :disabled="busyAccountId === account.id"
            @click="checkAccount(account.id)"
          >
            <Spinner v-if="busyAccountId === account.id" label="" />
            {{ busyAccountId === account.id ? "Checking…" : "Check this profile" }}
          </button>
          <button
            v-else-if="account.status !== 'candidate' && account.removable && canRemoveAccount"
            type="button"
            class="agent-usage__remove usage-btn"
            :disabled="busyAccountId === account.id"
            @click="removeAccount(account.id)"
          >
            <Spinner v-if="busyAccountId === account.id" label="" />
            {{ busyAccountId === account.id ? "Removing…" : "Remove" }}
          </button>
        </div>
        <p v-if="account.status === 'candidate'" class="usage-accounts__msg" role="status">
          Detected configuration folder
        </p>
        <p v-else class="usage-accounts__msg" role="status">
          {{ accountStatus(account.status, account.checkedAt) }}
        </p>
        <p v-if="account.sameAsDefault" class="usage-accounts__msg">Same account as default.</p>
        <p v-if="account.status === 'candidate' && canAddAccount" class="usage-accounts__msg">
          Check this folder to verify its account and current usage.
        </p>
        <p v-else-if="account.unavailable" class="usage-accounts__msg" role="status">
          {{ account.unavailable }}
        </p>
        <template v-else-if="displayedAccountWindows(account).length">
          <p class="usage-accounts__msg">
            <span v-for="(window, index) in displayedAccountWindows(account)" :key="`${window.label}-${index}`">
              {{ window.label }}: {{ accountUsageText(window.usedPercent)
              }}<template v-if="window.resetsAt"> · Reset {{ formatTime(window.resetsAt) }}</template
              ><span v-if="index < displayedAccountWindows(account).length - 1">; </span>
            </span>
          </p>
          <template v-if="account.status === 'separate-login' && accountPace(account)">
            <UsageMeter
              class="usage-account__meter"
              :used="accountPace(account)?.window.usedPercent ?? 0"
              :tick="accountPace(account)?.pace.elapsedPercent"
              :tone="toneForState(accountPace(account)?.pace.state)"
              :label="`${accountPace(account)?.window.label}: ${accountUsageText(accountPace(account)?.window.usedPercent ?? 0)}. ${accountPaceText(accountPace(account)?.pace.state)}`"
            />
            <p class="usage-accounts__msg">{{ accountPaceText(accountPace(account)?.pace.state) }}</p>
          </template>
        </template>
        <p v-else-if="account.status !== 'listed'" class="usage-accounts__msg">No active quota windows.</p>
      </article>
    </div>
    <button
      v-if="canAddAccount && manageable"
      type="button"
      class="agent-usage__add usage-btn usage-accounts__add"
      :disabled="addingProvider"
      @click="addAccount"
    >
      <Spinner v-if="addingProvider" label="" />
      {{ addingProvider ? "Choosing folder…" : `Add ${providerName(entry.provider)} account folder` }}
    </button>
    <p v-if="canAddAccount && entry.provider === 'codex'" class="usage-accounts__msg">
      For a signed-in Codex CLI, choose its CODEX_HOME folder.
    </p>
    <p v-else-if="canAddAccount && entry.provider === 'claude'" class="usage-accounts__msg">
      For a signed-in Claude CLI, choose its CLAUDE_CONFIG_DIR folder.
    </p>
  </details>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import Spinner from "../../common/Spinner.vue";
import UsageMeter from "./UsageMeter.vue";
import { useAgentUsage } from "../../../composables/useAgentUsage.js";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { apiKey } from "../../../types/keys.js";
import type { AgentUsage, UsageAccountSnapshot, UsageWindow } from "../../../../electron/shared/agent-usage.js";
import { formatTime, providerName, toneForState } from "../../../lib/usage-advice.js";
import { assessUsagePace, formatQuotaPercent, selectPacingWindow, type UsagePace } from "../../../lib/usage-pace.js";

const props = defineProps<{ entry: AgentUsage }>();

const { refreshAfterAccountChange } = useAgentUsage();
const appStore = useAppStore();
const notifications = useNotificationStore();
const injectedApi = inject(apiKey, null);
const managementApi = () => injectedApi ?? appStore.getApi();
const canAddAccount = computed(() => typeof managementApi()?.addUsageAccountProfile === "function");
const canRemoveAccount = computed(() => typeof managementApi()?.removeUsageAccountProfile === "function");
const manageable = computed(() => props.entry.provider === "claude" || props.entry.provider === "codex");
const showDisclosure = computed(
  () => Boolean(props.entry.otherAccounts?.length) || (canAddAccount.value && manageable.value),
);
const busyAccountId = ref("");
const addingProvider = ref(false);

function accountStatus(status: "separate-login" | "last-seen" | "listed", checkedAt?: number): string {
  return status === "separate-login"
    ? checkedAt
      ? `Separate login · checked ${formatTime(checkedAt)}`
      : "Separate login · no usage check yet"
    : status === "last-seen"
      ? `Last seen ${checkedAt ? formatTime(checkedAt) : ""}`.trim()
      : "Listed account · no quota data available.";
}
function accountUsageText(value: number): string {
  return `${formatQuotaPercent(value)} used`;
}
function displayedAccountWindows(account: UsageAccountSnapshot): UsageWindow[] {
  if (account.status === "last-seen") return account.windows ?? [];
  const currentTime = Date.now();
  return (account.windows ?? []).filter((window) => window.resetsAt === undefined || window.resetsAt > currentTime);
}
function accountPace(account: UsageAccountSnapshot) {
  if (account.status !== "separate-login" || account.checkedAt === undefined) return undefined;
  const window = selectPacingWindow(displayedAccountWindows(account), account.checkedAt)?.window;
  return window ? { window, pace: assessUsagePace(window, account.checkedAt) } : undefined;
}
function accountPaceText(state?: UsagePace["state"]): string {
  switch (state) {
    case "slow-down":
      return "Above even pace.";
    case "exhausted":
      return "Quota exhausted.";
    case "use-more":
      return "Below even pace.";
    case "on-track":
      return "On even pace.";
    case "early":
      return "Too little time to estimate pace.";
    default:
      return "Pace unavailable.";
  }
}
async function addAccount(): Promise<void> {
  const provider = props.entry.provider;
  if (provider !== "claude" && provider !== "codex") return;
  const api = managementApi();
  if (typeof api?.addUsageAccountProfile !== "function") {
    notifications.showError("Could not add account", "Account folders are unavailable in this client.");
    return;
  }
  addingProvider.value = true;
  try {
    if (await api.addUsageAccountProfile(provider)) await refreshAfterAccountChange();
  } catch (cause) {
    notifications.showError("Could not add account", cause);
  } finally {
    addingProvider.value = false;
  }
}
async function checkAccount(id: string): Promise<void> {
  const provider = props.entry.provider;
  if (provider !== "claude" && provider !== "codex") return;
  const api = managementApi();
  if (typeof api?.addUsageAccountProfile !== "function") {
    notifications.showError("Could not check profile", "Account folders are unavailable in this client.");
    return;
  }
  busyAccountId.value = id;
  try {
    if (await api.addUsageAccountProfile(provider, id)) await refreshAfterAccountChange();
  } catch (cause) {
    notifications.showError("Could not check profile", cause);
  } finally {
    busyAccountId.value = "";
  }
}
async function removeAccount(id: string): Promise<void> {
  const api = managementApi();
  if (typeof api?.removeUsageAccountProfile !== "function") {
    notifications.showError("Could not remove account", "Account folders are unavailable in this client.");
    return;
  }
  busyAccountId.value = id;
  try {
    await api.removeUsageAccountProfile(id);
    await refreshAfterAccountChange();
  } catch (cause) {
    notifications.showError("Could not remove account", cause);
  } finally {
    busyAccountId.value = "";
  }
}
</script>

<style scoped>
.usage-accounts {
  border-top: 1px solid var(--border);
  padding-top: 7px;
}
.usage-accounts summary {
  display: list-item;
  color: var(--muted);
  font-size: 10.5px;
  cursor: pointer;
}
.usage-accounts__count {
  white-space: nowrap;
}
.usage-accounts__list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}
.usage-account {
  min-width: 0;
  padding: 7px 9px;
  border-radius: 6px;
  background: rgba(var(--tint), 0.04);
  overflow-wrap: anywhere;
}
.usage-account__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
}
.usage-account__meter {
  margin-top: 6px;
}
.usage-accounts__msg {
  margin: 5px 0 0;
  color: var(--muted);
  font-size: 10.5px;
  line-height: 1.4;
}
.usage-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: rgba(var(--tint), 0.06);
  color: var(--text);
  padding: 3px 9px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.usage-btn:hover:not(:disabled) {
  background: rgba(var(--tint), 0.12);
}
.usage-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.usage-accounts__add {
  margin-top: 8px;
}
@media (max-width: 400px) {
  .usage-account__head {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .usage-account__head .usage-btn {
    justify-content: center;
    width: 100%;
  }
}
@media (pointer: coarse) {
  .usage-accounts summary,
  .usage-btn {
    min-height: 44px;
  }
}
</style>
