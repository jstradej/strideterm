<template>
  <div class="remote-pause-control">
    <button
      type="button"
      class="button button--ghost"
      :disabled="busy || (!paused && !configured)"
      :title="
        paused
          ? 'Resume the previously enabled connections. Pairings and configuration are preserved.'
          : 'Disconnect mobile and browser clients and pause all remote access. Pairings and configuration are preserved.'
      "
      @click="toggle"
    >
      {{ busy ? "Updating…" : paused ? "Resume remote access" : "Pause all connections" }}
    </button>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
const store = useAppStore();
const paused = computed(() => store.payload?.appState?.settings?.remoteAccess?.paused === true);
const configured = computed(() => store.payload?.appState?.settings?.remoteAccess?.enabled || store.mobileEnabled);
const busy = ref(false);
const error = ref("");
async function toggle() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await store.updateSettings({ remoteAccess: { paused: !paused.value } });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not change remote access.";
  } finally {
    busy.value = false;
  }
}
</script>
