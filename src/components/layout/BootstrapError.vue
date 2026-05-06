<template>
  <section class="boot-shell">
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
import type { Transport } from "../../transport.js";

defineProps<{
  message: string;
}>();

const api = inject<Transport>("api");
const isRemote = api?.isRemote || false;
const tokenInput = ref(api?.getRemoteToken?.() || "");

function handleTokenSubmit(): void {
  const token = tokenInput.value.trim();
  if (token) api?.setRemoteToken?.(token);
}

function retry(): void {
  window.location.reload();
}
</script>
