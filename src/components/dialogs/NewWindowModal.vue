<template>
  <div class="dialog new-window-modal">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Window</p>
        <h2>Open New Window</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <div class="form new-window-form">
      <template v-if="availableProfiles.length > 0">
        <p class="new-window-hint">Select a profile for the new window:</p>
        <div class="profile-pick-list">
          <button
            v-for="profile in availableProfiles"
            :key="profile.id"
            type="button"
            class="profile-pick-item"
            :disabled="busy"
            @click="openWindow(profile.id)"
          >
            <span class="profile-pick-swatch" :style="{ background: profile.color || '#ffa424' }"></span>
            <span class="profile-pick-name">{{ profile.name }}</span>
          </button>
        </div>
      </template>
      <template v-else>
        <p class="new-window-hint">All profiles are already open in a window.</p>
        <button type="button" class="button button--ghost" @click="emit('create-profile')">
          + Create new profile
        </button>
      </template>

      <template v-if="occupiedProfiles.length > 0">
        <p class="new-window-occupied-label">Already open:</p>
        <div class="profile-pick-list profile-pick-list--occupied">
          <div
            v-for="entry in occupiedProfiles"
            :key="entry.profile.id"
            class="profile-pick-item profile-pick-item--disabled"
            :title="`Open in window ${entry.windowIndex}`"
          >
            <span class="profile-pick-swatch" :style="{ background: entry.profile.color || '#ffa424' }"></span>
            <span class="profile-pick-name">{{ entry.profile.name }}</span>
            <span class="profile-pick-badge">Window {{ entry.windowIndex }}</span>
          </div>
        </div>
      </template>

      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";

interface Profile {
  id: string;
  name: string;
  color?: string;
}

interface WindowSlot {
  id: string;
  profileId: string;
}

const props = defineProps<{
  profiles?: Profile[];
  windowSlots?: WindowSlot[];
}>();

const emit = defineEmits<{
  cancel: [];
  "create-profile": [];
}>();

const busy = ref(false);
const errorMessage = ref("");

const occupiedProfileIds = computed<Set<string>>(() => {
  const slots = props.windowSlots || [];
  return new Set(slots.map((s) => s.profileId));
});

const availableProfiles = computed<Profile[]>(() => {
  return (props.profiles || []).filter((p) => !occupiedProfileIds.value.has(p.id));
});

const occupiedProfiles = computed<{ profile: Profile; windowIndex: number }[]>(() => {
  const slots = props.windowSlots || [];
  return (props.profiles || [])
    .filter((p) => occupiedProfileIds.value.has(p.id))
    .map((p) => {
      const slotIdx = slots.findIndex((s) => s.profileId === p.id);
      return { profile: p, windowIndex: slotIdx + 1 };
    });
});

async function openWindow(profileId: string): Promise<void> {
  busy.value = true;
  errorMessage.value = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (window as any).strideterm?.createWindow?.(profileId);
    if (result?.error) {
      errorMessage.value = result.error;
    } else {
      emit("cancel");
    }
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to open window";
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.new-window-form {
  margin-top: 14px;
  display: grid;
  gap: 12px;
}
.new-window-hint {
  color: var(--muted);
  font-size: 13px;
  margin: 0;
}
.new-window-occupied-label {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 0;
}
.profile-pick-list {
  display: grid;
  gap: 6px;
}
.profile-pick-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  text-align: left;
  transition: background 0.1s;
}
.profile-pick-item:hover:not(:disabled):not(.profile-pick-item--disabled) {
  background: rgba(255, 255, 255, 0.07);
}
.profile-pick-item:disabled,
.profile-pick-item--disabled {
  opacity: 0.45;
  cursor: default;
  pointer-events: none;
}
.profile-pick-list--occupied .profile-pick-item--disabled {
  pointer-events: auto;
}
.profile-pick-swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.profile-pick-name {
  flex: 1;
  font-weight: 600;
}
.profile-pick-badge {
  font-size: 11px;
  color: var(--muted);
}
</style>
