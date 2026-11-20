<template>
  <PeerHostFailure v-if="peerFailure" :failure="peerFailure" />
  <section v-else class="boot-shell">
    <div class="boot-card">
      <p class="eyebrow">{{ isRemote ? "Remote Access" : "Startup Error" }}</p>
      <h1>strIDEterm could not load the workspace</h1>
      <p class="boot-copy">{{ message }}</p>
      <form v-if="isRemote" class="boot-form" @submit.prevent="handleTokenSubmit">
        <label>
          <span>Access token</span>
          <input v-model="tokenInput" name="token" placeholder="Paste the strIDEterm token" />
        </label>
        <button
          type="submit"
          class="button"
          title="Save the access token for this remote session and reload — the page will reconnect to the strIDEterm runtime if the token is valid."
        >
          Connect
        </button>
      </form>
      <button
        v-else
        type="button"
        class="button"
        title="Reload the page to retry connecting to the runtime. The error message above shows what failed last time."
        @click="retry"
      >
        Retry
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, inject } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import PeerHostFailure from "../peers/PeerHostFailure.vue";
import type { PeerFailure } from "../../peer-link.js";
import { windowBackend } from "../../window-backend.js";

const props = defineProps<{
  message: string;
}>();

const api = inject<Transport>(apiKey);
const isRemote = api?.isRemote || false;
// A window attached to another computer has no token to paste and no page to reload.
const peerFailure: PeerFailure | null =
  windowBackend.value.kind === "peer"
    ? { reason: "offline", title: `${windowBackend.value.hostLabel} could not be loaded`, message: props.message }
    : null;
const tokenInput = ref(api?.getRemoteToken?.() || "");

function handleTokenSubmit(): void {
  const token = tokenInput.value.trim();
  if (token) api?.setRemoteToken?.(token);
}

function retry(): void {
  window.location.reload();
}
</script>
