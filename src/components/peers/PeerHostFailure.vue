<template>
  <section class="peer-failure" data-testid="peer-failure" role="alert">
    <div class="boot-card">
      <p class="eyebrow">{{ hostLabel }}</p>
      <h1 data-testid="peer-failure-title">{{ failure.title }}</h1>
      <p class="boot-copy" data-testid="peer-failure-message">{{ failure.message }}</p>
      <div class="peer-failure__actions">
        <button
          type="button"
          class="button"
          :class="{ 'button--pending': action === 'reconnect' }"
          :aria-busy="action === 'reconnect' ? 'true' : undefined"
          data-testid="peer-failure-reconnect"
          :disabled="busy"
          title="Check the other computer again. The window reloads when it answers."
          @click="reconnect"
        >
          Reconnect
        </button>
        <button
          type="button"
          class="button button--ghost"
          :class="{ 'button--pending': action === 'local' }"
          :aria-busy="action === 'local' ? 'true' : undefined"
          data-testid="peer-failure-local"
          :disabled="busy"
          title="Show a profile of this computer in this window instead."
          @click="switchToLocal"
        >
          Switch to a local profile
        </button>
        <button
          type="button"
          class="button button--ghost"
          :class="{ 'button--pending': action === 'close' }"
          :aria-busy="action === 'close' ? 'true' : undefined"
          data-testid="peer-failure-close"
          :disabled="busy"
          title="Close this window."
          @click="closeWindow"
        >
          Close window
        </button>
      </div>
      <ul v-if="localProfiles.length > 1" class="peer-failure__profiles" data-testid="peer-failure-profiles">
        <li v-for="profile in localProfiles" :key="profile.id">
          <button
            type="button"
            class="button button--ghost"
            :class="{ 'button--pending': action === profile.id }"
            :aria-busy="action === profile.id ? 'true' : undefined"
            data-testid="peer-failure-profile"
            :disabled="busy"
            @click="activateLocal(profile.id)"
          >
            {{ profile.name }}
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { LocalProfileOverview } from "../../../electron/shared/peers.js";
import type { PeerFailure } from "../../peer-link.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { windowBackend } from "../../window-backend.js";

defineProps<{ failure: PeerFailure }>();

type WindowApi = {
  getLocalProfilesOverview?: () => Promise<LocalProfileOverview[]>;
  activateLocalProfile?: (profileId: string) => Promise<unknown>;
  closeWindow?: () => Promise<void>;
};

const store = useAppStore();
const notifications = useNotificationStore();
const action = ref<string | null>(null);
const busy = computed(() => action.value !== null);
const localProfiles = ref<LocalProfileOverview[]>([]);
const hostLabel = computed(() => (windowBackend.value.kind === "peer" ? windowBackend.value.hostLabel : ""));

function windowApi(): WindowApi {
  return ((window as unknown as { strideterm?: WindowApi }).strideterm ?? {}) as WindowApi;
}

async function run(key: string, title: string, task: () => Promise<unknown>): Promise<boolean> {
  action.value = key;
  try {
    return await notifications.runWithToast(title, task);
  } finally {
    action.value = null;
  }
}

async function reconnect(): Promise<void> {
  await run("reconnect", "Could not reconnect", () => store.reconnectPeerHost());
}

async function activateLocal(profileId: string, key = profileId): Promise<void> {
  await run(key, "Could not switch the profile", async () => {
    const activate = windowApi().activateLocalProfile;
    if (!activate) throw new Error("Switching profiles is not available in this window.");
    await activate(profileId);
  });
}

async function switchToLocal(): Promise<void> {
  let profiles: LocalProfileOverview[] = [];
  const listed = await run("local", "Could not list the profiles of this computer", async () => {
    const list = windowApi().getLocalProfilesOverview;
    if (!list) throw new Error("Switching profiles is not available in this window.");
    profiles = await list();
    if (profiles.length === 0) throw new Error("This computer has no profile to switch to.");
  });
  if (!listed) return;
  if (profiles.length === 1) await activateLocal(profiles[0].id, "local");
  else localProfiles.value = profiles;
}

async function closeWindow(): Promise<void> {
  await run("close", "Could not close the window", async () => {
    const close = windowApi().closeWindow;
    if (!close) throw new Error("Closing is not available in this window.");
    await close();
  });
}
</script>

<style scoped>
.peer-failure {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg, #14161a);
}

.peer-failure__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.peer-failure__profiles {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
