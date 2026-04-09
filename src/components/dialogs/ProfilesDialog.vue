<template>
  <div class="dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Workspace</p>
        <h2>Profiles</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <div class="form profiles-form">
      <p class="profiles-description">
        Each profile has its own set of workspaces. Switch profiles to work on different projects.
      </p>
      <div class="profile-list">
        <article
          v-for="profile in localProfiles"
          :key="profile.id"
          class="profile-card"
          :style="{ borderColor: profile.id === activeProfileId ? 'var(--accent)' : 'var(--border)' }"
        >
          <div class="profile-card__header">
            <input
              v-model="profile.name"
              class="profile-name-input"
              maxlength="40"
              @click.stop
              @blur="onRenameProfile(profile)"
              @keydown.enter="(e) => e.target.blur()"
            />
            <span v-if="profile.id === activeProfileId" class="profile-active-badge">(active)</span>
            <div class="profile-card__actions">
              <button
                v-if="profile.id !== activeProfileId"
                class="button button--ghost"
                @click="handleActivate(profile.id)"
              >
                Activate
              </button>
              <button
                v-if="localProfiles.length > 1"
                class="button button--ghost button--danger-text"
                @click="handleDelete(profile.id)"
              >
                Delete
              </button>
            </div>
          </div>
          <div class="profile-card__footer">
            <small class="text-muted"
              >{{ workspaceCount(profile.id) }} workspace{{ workspaceCount(profile.id) !== 1 ? "s" : "" }}</small
            >
            <input
              v-if="profile.id === activeProfileId"
              type="color"
              :value="profile.color || '#ffa424'"
              class="profile-color-input"
              title="Profile color"
              @input="(e) => onProfileColorChange(profile, e.target.value)"
            />
          </div>
        </article>
      </div>
      <div class="add-profile-row">
        <input
          v-model="newProfileName"
          placeholder="New profile name..."
          maxlength="40"
          class="add-profile-input"
          @click.stop
          @keydown.enter="addProfile"
        />
        <button class="button button--ghost" @click="addProfile">+ Add</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  profiles: { type: Array, default: () => [] },
  activeProfileId: { type: String, default: "default" },
  workspaces: { type: Array, default: () => [] },
});

const emit = defineEmits(["cancel"]);
const attrs = useAttrs();

const localProfiles = reactive(props.profiles.map((p) => ({ ...p })));
const newProfileName = ref("");

function workspaceCount(profileId) {
  return props.workspaces.filter((ws) => (ws.profileId || "default") === profileId).length;
}

async function onRenameProfile(profile) {
  const name = profile.name.trim();
  if (name) await attrs.onSave?.({ ...profile, name });
}

async function onProfileColorChange(profile, color) {
  profile.color = color;
  await attrs.onSave?.({ ...profile });
}

async function handleActivate(profileId) {
  await attrs.onActivate?.(profileId);
}

async function handleDelete(profileId) {
  await attrs.onDelete?.(profileId);
  const idx = localProfiles.findIndex((p) => p.id === profileId);
  if (idx >= 0) localProfiles.splice(idx, 1);
}

async function addProfile() {
  const name = newProfileName.value.trim().substring(0, 40);
  if (!name) return;
  if (localProfiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
  const newProfile = { id: `profile-${crypto.randomUUID()}`, name, color: "#ffa424", workspaceIds: [] };
  await attrs.onSave?.(newProfile);
  localProfiles.push(newProfile);
  newProfileName.value = "";
}
</script>

<style scoped>
.profiles-form {
  margin-top: 14px;
}
.profiles-description {
  color: var(--muted);
  font-size: 13px;
}
.profile-list {
  display: grid;
  gap: 8px;
}
.profile-card {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.03);
  display: grid;
  gap: 8px;
}
.profile-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.profile-card__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.profile-card__actions {
  display: flex;
  gap: 4px;
}
.profile-name-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 2px 6px;
  font: inherit;
  font-weight: 700;
  color: var(--text);
  font-size: 14px;
}
.profile-name-input:focus {
  border-color: var(--border);
  background: rgba(255, 255, 255, 0.04);
}
.profile-active-badge {
  color: var(--accent);
  font-size: 11px;
  flex-shrink: 0;
}
.text-muted {
  color: var(--muted);
}
.button--danger-text {
  color: var(--danger);
}
.profile-color-input {
  width: 28px;
  height: 22px;
  padding: 1px;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: transparent;
}
.add-profile-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
.add-profile-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  font: inherit;
  font-size: 13px;
}
</style>
