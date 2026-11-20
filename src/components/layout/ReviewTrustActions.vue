<template>
  <div class="review-trust">
    <p class="notification-item__body" :title="fallback">{{ fallback }}</p>
    <div v-if="record?.outcome === 'pending'" class="review-trust__actions">
      <button
        type="button"
        class="quick-action review-trust__trust"
        :disabled="record.busy"
        title="Answer the agent's question with “Yes, I trust this folder”. The review prompt then starts. Its own project settings and hooks are not loaded either way."
        @click.stop="store.trust(api, record.sessionId)"
      >
        {{ record.busy ? "Trusting…" : "Trust folder & start review" }}
      </button>
      <button
        type="button"
        class="quick-action"
        title="Open the agent's terminal to read the question and answer it there."
        @click.stop="$emit('open')"
      >
        Open terminal
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import { useReviewTrustStore } from "../../stores/review-trust.js";
import { useAppStore } from "../../stores/app.js";

const props = defineProps<{ viewId: string; fallback: string }>();
defineEmits<{ open: [] }>();

const store = useReviewTrustStore();
const api = inject<Transport | null>(apiKey, null) ?? useAppStore().getApi();
const record = computed(() =>
  store.records.find((item) => `review-trust:${item.sessionId}` === props.viewId && item.outcome === "pending"),
);
</script>

<style scoped>
.review-trust__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.review-trust__trust {
  font-weight: 600;
}
</style>
