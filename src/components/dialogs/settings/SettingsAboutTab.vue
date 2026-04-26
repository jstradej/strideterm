<template>
  <div class="about-content">
    <h1 class="about-title">str<em class="about-accent">IDE</em>term</h1>
    <p class="about-subtitle">Multi-workspace terminal hub for developers</p>
    <p class="about-version">Version {{ appVersion }}</p>

    <div v-if="updateInfo" class="update-banner" :class="updateInfo.kind">
      <p class="update-banner__text">{{ updateInfo.message }}</p>
      <a
        v-if="updateInfo.url"
        :href="updateInfo.url"
        class="link-accent"
        @click.prevent="api?.openExternal?.(updateInfo.url)"
        >View release</a
      >
    </div>
    <p v-else-if="checkingUpdate" class="about-version">Checking for updates...</p>

    <button
      type="button"
      class="button button--ghost check-update-btn"
      :disabled="checkingUpdate"
      @click="emit('check-updates')"
    >
      {{ checkingUpdate ? "Checking..." : "Check for updates" }}
    </button>

    <p v-if="repositoryUrl" class="about-link">
      <a :href="repositoryUrl" target="_blank" rel="noopener noreferrer" class="link-accent">GitHub Repository</a>
    </p>
  </div>
</template>

<script setup lang="ts">
import type { Transport } from "../../../transport.js";

interface UpdateInfo {
  kind: string;
  message: string;
  url: string;
}

interface Props {
  api?: Transport | null;
  appVersion?: string;
  repositoryUrl?: string;
  checkingUpdate?: boolean;
  updateInfo?: UpdateInfo | null;
}

withDefaults(defineProps<Props>(), {
  api: null,
  appVersion: "",
  repositoryUrl: "",
  checkingUpdate: false,
  updateInfo: null,
});

const emit = defineEmits<{
  "check-updates": [];
}>();
</script>

<style scoped>
.about-content {
  text-align: center;
  padding: 24px 0;
}

.about-title {
  font-size: 28px;
}

.about-accent {
  color: var(--accent);
  font-style: normal;
}

.about-subtitle {
  color: var(--muted);
  margin: 8px 0;
}

.about-version {
  font-size: 13px;
  color: var(--muted);
}

.about-link {
  margin-top: 16px;
}

.update-banner {
  margin: 12px 0;
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
}

.update-banner--current {
  background: rgba(76, 175, 80, 0.1);
  color: #81c784;
}

.update-banner--behind {
  background: rgba(255, 163, 71, 0.1);
  color: #ffb347;
}

.update-banner__text {
  margin: 0 0 4px;
}

.check-update-btn {
  margin-top: 12px;
}

.link-accent {
  color: var(--accent);
}
</style>
