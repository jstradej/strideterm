<template>
  <section class="boot-shell">
    <div class="boot-card">
      <p class="eyebrow">{{ isRemote ? 'Remote Access' : 'Startup Error' }}</p>
      <h1>strIDEterm could not load the workspace</h1>
      <p class="boot-copy">{{ message }}</p>
      <form v-if="isRemote" class="boot-form" @submit.prevent="handleTokenSubmit">
        <label>
          <span>Access token</span>
          <input v-model="tokenInput" name="token" placeholder="Paste the strIDEterm token" />
        </label>
        <button type="submit" class="button">Connect</button>
      </form>
      <button v-else type="button" class="button" @click="retry">Retry</button>
    </div>
  </section>
</template>

<script setup>
import { ref, inject } from "vue";

const props = defineProps({
  message: { type: String, required: true },
});

const api = inject("api");
const isRemote = api?.isRemote || false;
const tokenInput = ref(api?.getRemoteToken?.() || "");

function handleTokenSubmit() {
  const token = tokenInput.value.trim();
  if (token) api?.setRemoteToken?.(token);
}

function retry() {
  window.location.reload();
}
</script>
