<template>
  <div class="about-content">
    <h1 class="about-title">str<em class="about-accent">IDE</em>term</h1>
    <p class="about-subtitle">Multi-workspace terminal hub for developers</p>
    <p class="about-version">Version {{ appVersion }}</p>

    <template v-if="appUpdate.phase !== 'unsupported'">
      <div
        v-if="updateMessage"
        class="update-banner"
        :class="{ 'update-banner--current': appUpdate.phase === 'current' }"
      >
        <p class="update-banner__text" role="status">{{ updateMessage }}</p>
        <progress
          v-if="appUpdate.phase === 'downloading'"
          :value="appUpdate.percent"
          max="100"
          aria-label="Update download"
        />
        <a
          v-if="appUpdate.phase === 'failed'"
          :href="APP_UPDATE_RELEASES_URL"
          class="link-accent"
          @click.prevent="openRelease"
          >Download from GitHub</a
        >
      </div>
      <button
        v-if="appUpdate.phase === 'ready'"
        type="button"
        class="button check-update-btn"
        @click="emit('restart-for-update')"
      >
        Restart and install
      </button>
      <button
        v-else-if="updateActionLabel"
        type="button"
        class="button button--ghost check-update-btn"
        @click="emit('download-update')"
      >
        {{ updateActionLabel }}
      </button>
    </template>
    <template v-else>
      <div v-if="updateInfo" class="update-banner" :class="updateInfo.kind">
        <p class="update-banner__text">{{ updateInfo.message }}</p>
        <a
          v-if="updateInfo.url"
          :href="updateInfo.url"
          class="link-accent"
          @click.prevent="api?.openExternal?.(updateInfo.url)"
          >{{ updateInfo.linkLabel || "View release" }}</a
        >
      </div>
      <p v-else-if="checkingUpdate" class="about-version">Checking for updates...</p>

      <button
        v-if="canCheckUpdates"
        type="button"
        class="button button--ghost check-update-btn"
        :disabled="checkingUpdate"
        @click="emit('check-updates')"
      >
        {{ checkingUpdate ? "Checking..." : "Check for updates" }}
      </button>
    </template>

    <p v-if="repositoryUrl" class="about-link">
      <a :href="repositoryUrl" target="_blank" rel="noopener noreferrer" class="link-accent">GitHub Repository</a>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { APP_UPDATE_RELEASES_URL, type AppUpdateStatus } from "../../../../electron/shared/app-update.js";
import type { Transport } from "../../../transport.js";
import { useNotificationStore } from "../../../stores/notifications.js";

interface UpdateInfo {
  kind: string;
  message: string;
  url: string;
  linkLabel?: string;
}

interface Props {
  api?: Transport | null;
  appVersion?: string;
  repositoryUrl?: string;
  checkingUpdate?: boolean;
  canCheckUpdates?: boolean;
  updateInfo?: UpdateInfo | null;
  appUpdate?: AppUpdateStatus;
  hasNewerVersion?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  api: null,
  appVersion: "",
  repositoryUrl: "",
  checkingUpdate: false,
  canCheckUpdates: true,
  updateInfo: null,
  appUpdate: () => ({ phase: "unsupported" }),
  hasNewerVersion: false,
});

const emit = defineEmits<{
  "check-updates": [];
  "download-update": [];
  "restart-for-update": [];
}>();

const updateMessage = computed(() => {
  const update = props.appUpdate;
  switch (update.phase) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading v${update.version} (${update.percent}%)`;
    case "ready":
      return `Version ${update.version} is ready to install.`;
    case "restarting":
      return `Preparing to install v${update.version}…`;
    case "current":
      return "You are on the latest version.";
    case "failed":
      return update.message;
    case "idle":
      return props.hasNewerVersion ? "A new version is available." : "";
    default:
      return "";
  }
});

const updateActionLabel = computed(() => {
  switch (props.appUpdate.phase) {
    case "idle":
      return props.hasNewerVersion ? "Download update" : "Check for and download updates";
    case "current":
      return "Check for and download updates";
    case "failed":
      return props.appUpdate.retryable ? "Try again" : "";
    default:
      return "";
  }
});

async function openRelease(): Promise<void> {
  try {
    await props.api?.openAppUpdateRelease?.();
  } catch (error) {
    useNotificationStore().showError("Could not open the release page", error);
  }
}
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

.update-banner--store {
  background: rgba(var(--tint), 0.05);
  color: var(--text);
}

.update-banner__text {
  margin: 0 0 4px;
}

.update-banner progress {
  width: min(20rem, 100%);
  accent-color: var(--accent);
}

.check-update-btn {
  margin-top: 12px;
}

.link-accent {
  color: var(--accent);
}
</style>
