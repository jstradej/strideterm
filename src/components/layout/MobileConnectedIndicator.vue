<template>
  <button
    v-if="devices.length > 0"
    type="button"
    class="mobile-connected-indicator"
    data-role="mobile-connected-indicator"
    :title="tooltip"
    :aria-label="ariaLabel"
    @click="openPhones"
  >
    <span aria-hidden="true">📱</span>
    <span v-if="devices.length > 1" class="mobile-connected-indicator__count" aria-hidden="true">{{
      devices.length
    }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";

// "A phone is connected right now" — the desktop equivalent of a screen-sharing icon. It sits next to
// the notification bell and is rendered only while at least one paired phone holds a live session, so
// a connection the user did not expect is visible without opening anything.
const appStore = useAppStore();

const devices = computed(() => appStore.mobileConnectedDevices);

function profileName(profileId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profiles = (appStore.payload?.appState?.profiles || []) as any[];
  return profiles.find((profile) => profile.id === profileId)?.name || profileId;
}

function sinceLabel(startedAt: number): string {
  try {
    return new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

const tooltip = computed(() =>
  devices.value
    .map((device) => `${device.name} · ${profileName(device.profileId)} · since ${sinceLabel(device.startedAt)}`)
    .join("\n"),
);

const ariaLabel = computed(() =>
  devices.value.length === 1
    ? `1 phone connected: ${devices.value[0].name}`
    : `${devices.value.length} phones connected: ${devices.value.map((device) => device.name).join(", ")}`,
);

function openPhones(): void {
  appStore.openSettingsDialog({ initialTab: "mobile", initialMobileView: "phones" });
}
</script>
