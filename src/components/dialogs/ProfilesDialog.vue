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
              title="Rename this profile. The new name takes effect when you click away or press Enter."
              @click.stop
              @blur="onRenameProfile(profile)"
              @keydown.enter="(e: Event) => (e.target as HTMLInputElement).blur()"
            />
            <span v-if="profile.id === activeProfileId" class="profile-active-badge">(active)</span>
            <div class="profile-card__actions">
              <button
                v-if="profile.id !== activeProfileId"
                type="button"
                class="button button--ghost"
                :disabled="occupiedByOtherWindow.has(profile.id)"
                :title="
                  occupiedByOtherWindow.has(profile.id)
                    ? `Open in Window ${occupiedByOtherWindow.get(profile.id)}`
                    : 'Switch to this profile — the sidebar will filter to show only its workspaces. Credentials and runtime managers are shared across all profiles in this install.'
                "
                @click="handleActivate(profile.id)"
              >
                Activate
              </button>
              <button
                v-if="localProfiles.length > 1"
                type="button"
                class="button button--ghost button--danger-text"
                title="Delete this profile. Any workspaces assigned to it move back to the default profile — they are not deleted."
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
              title="Pick the profile's accent colour — used for the profile bar and the workspace card border so you can spot which profile a workspace belongs to at a glance."
              @input="(e) => onProfileColorChange(profile, (e.target as HTMLInputElement).value)"
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
          title="Type a name for the new profile. Press Enter or click + Add to create it."
          @click.stop
          @keydown.enter="addProfile"
        />
        <button
          type="button"
          class="button button--ghost"
          title="Create a new profile with the typed name. New profiles start empty — drag workspaces into them or assign workspaces via the workspace editor."
          @click="addProfile"
        >
          + Add
        </button>
      </div>
      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

interface Profile {
  id: string;
  name: string;
  color?: string;
  workspaceIds?: string[];
}

interface WorkspaceEntry {
  id: string;
  profileId?: string;
}

interface WindowSlot {
  id: string;
  profileId: string;
}

interface Props {
  profiles?: Profile[];
  activeProfileId?: string;
  workspaces?: WorkspaceEntry[];
  windowSlots?: WindowSlot[];
}

const props = withDefaults(defineProps<Props>(), {
  profiles: () => [],
  activeProfileId: "default",
  workspaces: () => [],
  windowSlots: () => [],
});

// Profiles occupied by another window (not this window's active profile).
// Maps profileId → 1-based window index.
const occupiedByOtherWindow = computed<Map<string, number>>(() => {
  const map = new Map<string, number>();
  const slots = props.windowSlots || [];
  slots.forEach((slot, idx) => {
    if (slot.profileId !== props.activeProfileId) {
      map.set(slot.profileId, idx + 1);
    }
  });
  return map;
});

const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();

const localProfiles = reactive(props.profiles.map((p) => ({ ...p })));
const newProfileName = ref("");
const errorMessage = ref("");

function workspaceCount(profileId: string) {
  return props.workspaces.filter((ws) => (ws.profileId || "default") === profileId).length;
}

// Strip Vue reactive proxies before handing a profile to the parent (which
// forwards it into Electron IPC). Nested `workspaceIds` is a reactive array
// proxy — structuredClone can't serialize it and throws "An object could
// not be cloned", which silently killed the save without feedback.
function plainProfile(profile: Profile) {
  return JSON.parse(JSON.stringify(profile));
}

function handleError(err: unknown) {
  const raw = (err as Error)?.message || String(err || "Unknown error");
  errorMessage.value = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}

async function onRenameProfile(profile: Profile) {
  const name = profile.name.trim();
  if (!name) return;
  errorMessage.value = "";
  try {
    await (attrs.onSave as ((profile: unknown) => Promise<void>) | undefined)?.(plainProfile({ ...profile, name }));
  } catch (err) {
    handleError(err);
  }
}

async function onProfileColorChange(profile: Profile, color: string) {
  profile.color = color;
  errorMessage.value = "";
  try {
    await (attrs.onSave as ((profile: unknown) => Promise<void>) | undefined)?.(plainProfile(profile));
  } catch (err) {
    handleError(err);
  }
}

async function handleActivate(profileId: string) {
  errorMessage.value = "";
  try {
    await (attrs.onActivate as ((id: string) => Promise<void>) | undefined)?.(profileId);
  } catch (err) {
    handleError(err);
  }
}

async function handleDelete(profileId: string) {
  errorMessage.value = "";
  try {
    await (attrs.onDelete as ((id: string) => Promise<void>) | undefined)?.(profileId);
    const idx = localProfiles.findIndex((p) => p.id === profileId);
    if (idx >= 0) localProfiles.splice(idx, 1);
  } catch (err) {
    handleError(err);
  }
}

async function addProfile() {
  const name = newProfileName.value.trim().substring(0, 40);
  if (!name) return;
  if (localProfiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
  const newProfile = { id: `profile-${crypto.randomUUID()}`, name, color: "#ffa424", workspaceIds: [] };
  errorMessage.value = "";
  try {
    await (attrs.onSave as ((profile: unknown) => Promise<void>) | undefined)?.(plainProfile(newProfile));
    localProfiles.push(newProfile);
    newProfileName.value = "";
  } catch (err) {
    handleError(err);
  }
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
