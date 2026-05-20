<template>
  <div class="dialog" data-no-autofocus>
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
      <!-- Arrow-key navigation between profile cards. Tab still walks every
           focusable element in document order; ↑/↓ jump card-to-card by
           focusing each card's primary action (rename input or Activate). -->
      <div ref="profileListRef" class="profile-list" @keydown="onProfileListKeydown">
        <article
          v-for="profile in localProfiles"
          :key="profile.id"
          class="profile-card"
          :data-profile-id="profile.id"
          :style="{ borderColor: profile.id === activeProfileId ? 'var(--accent)' : 'var(--border)' }"
        >
          <div class="profile-card__header">
            <span v-if="isRemote" class="profile-name-display">{{ profile.name }}</span>
            <input
              v-else
              v-model="profile.name"
              class="profile-name-input"
              maxlength="40"
              title="Rename this profile. The new name takes effect when you click away or press Enter."
              @click.stop
              @blur="onRenameProfile(profile)"
              @keydown.enter="(e: Event) => (e.target as HTMLInputElement).blur()"
            />
            <span v-if="profile.id === activeProfileId" class="profile-active-badge">(active)</span>
            <span
              v-if="isRemote && occupiedByOtherWindow.has(profile.id)"
              class="profile-desktop-badge"
              :title="`This profile is open on desktop Window ${occupiedByOtherWindow.get(profile.id)}`"
              >Window {{ occupiedByOtherWindow.get(profile.id) }}</span
            >
            <div class="profile-card__actions">
              <button
                v-if="profile.id !== activeProfileId"
                type="button"
                class="button button--ghost"
                :disabled="(!isRemote && occupiedByOtherWindow.has(profile.id)) || activatingProfileId !== null"
                :title="
                  !isRemote && occupiedByOtherWindow.has(profile.id)
                    ? `Open in Window ${occupiedByOtherWindow.get(profile.id)}`
                    : 'Switch to this profile — the sidebar will filter to show only its workspaces. Credentials and runtime managers are shared across all profiles in this install.'
                "
                @click="handleActivate(profile.id)"
              >
                {{ activatingProfileId === profile.id ? "Switching…" : "Activate" }}
              </button>
              <button
                v-if="!isRemote && localProfiles.length > 1"
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
              v-if="!isRemote && profile.id === activeProfileId"
              type="color"
              :value="profile.color || '#ffa424'"
              class="profile-color-input"
              title="Pick the profile's accent colour — used for the profile bar and the workspace card border so you can spot which profile a workspace belongs to at a glance."
              @input="(e) => onProfileColorChange(profile, (e.target as HTMLInputElement).value)"
            />
          </div>
        </article>
      </div>
      <div v-if="!isRemote" class="add-profile-row">
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
import { ref, reactive, computed, onMounted, useAttrs } from "vue";

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
  /** True when rendered inside the remote web client. */
  isRemote?: boolean;
  /** profileId → 1-based desktop window index (used for badge in remote mode). */
  desktopOccupancy?: Map<string, number>;
}

const props = withDefaults(defineProps<Props>(), {
  profiles: () => [],
  activeProfileId: "default",
  workspaces: () => [],
  windowSlots: () => [],
  isRemote: false,
  desktopOccupancy: () => new Map(),
});

// Profiles occupied by another desktop window (not this viewer's active profile).
// Maps profileId → 1-based window index.  Used differently in Electron vs remote:
//   Electron → disable the Activate button
//   Remote   → show "Open on desktop Window N" badge; button stays enabled
const occupiedByOtherWindow = computed<Map<string, number>>(() => {
  // In remote mode we get occupancy from the desktopOccupancy prop directly.
  if (props.isRemote) return props.desktopOccupancy || new Map();
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
const activatingProfileId = ref<string | null>(null);

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
  activatingProfileId.value = profileId;
  try {
    await (attrs.onActivate as ((id: string) => Promise<void>) | undefined)?.(profileId);
  } catch (err) {
    handleError(err);
  } finally {
    activatingProfileId.value = null;
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

// --- Keyboard navigation ----------------------------------------------------
// The dialog opts out of DialogOverlay's auto-focus (data-no-autofocus on the
// root) because focusing the rename input on open looks like a rename in
// progress. Instead we focus the first "Activate" button so the user can
// switch profiles with arrow keys + Enter without grabbing the mouse.

const profileListRef = ref<HTMLElement | null>(null);

function focusableButtonsInCard(card: HTMLElement): HTMLButtonElement[] {
  return Array.from(card.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
}

function getProfileCards(): HTMLElement[] {
  return Array.from(profileListRef.value?.querySelectorAll<HTMLElement>(".profile-card") || []);
}

function findActiveCardIndex(): number {
  const cards = getProfileCards();
  const active = document.activeElement as HTMLElement | null;
  if (!active) return -1;
  return cards.findIndex((card) => card.contains(active));
}

function focusCardAt(index: number): void {
  const cards = getProfileCards();
  if (cards.length === 0) return;
  const safe = Math.max(0, Math.min(cards.length - 1, index));
  const card = cards[safe];
  if (!card) return;
  // Prefer the Activate button (the primary action); fall back to whatever
  // is focusable in the card if Activate isn't there (e.g. the active card).
  const activateBtn = card.querySelector<HTMLButtonElement>("button:not(:disabled)");
  const target = activateBtn || focusableButtonsInCard(card)[0];
  target?.focus({ preventScroll: false });
}

function onProfileListKeydown(event: KeyboardEvent): void {
  // Don't hijack arrow keys inside inputs / colour picker — those want them
  // for native text navigation.
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Home" && event.key !== "End") return;
  const cards = getProfileCards();
  if (cards.length === 0) return;
  event.preventDefault();
  const current = findActiveCardIndex();
  if (event.key === "ArrowDown") focusCardAt(current < 0 ? 0 : current + 1);
  else if (event.key === "ArrowUp") focusCardAt(current < 0 ? cards.length - 1 : current - 1);
  else if (event.key === "Home") focusCardAt(0);
  else if (event.key === "End") focusCardAt(cards.length - 1);
}

onMounted(() => {
  // Defer until DialogOverlay's focus retry loop has finished (it bails early
  // on data-no-autofocus, but the rAF cadence still matters) so we don't race
  // against it.
  requestAnimationFrame(() => {
    if (!profileListRef.value) return;
    // Prefer the first non-active profile's Activate button — that's the
    // most common destination ("switch to another profile"). Fall back to
    // the first focusable button anywhere in the list.
    const firstActivate = profileListRef.value.querySelector<HTMLButtonElement>(
      ".profile-card__actions button:not(:disabled)",
    );
    if (firstActivate) {
      firstActivate.focus({ preventScroll: true });
      return;
    }
    // No actionable profile — focus the "+ Add" input so the user can type
    // immediately. Falls back to nothing if !isRemote prevents the row.
    const addInput = document.querySelector<HTMLInputElement>(".add-profile-input");
    addInput?.focus({ preventScroll: true });
  });
});
</script>

<style scoped>
.profiles-form {
  margin-top: 14px;
  min-width: 0;
}
.profiles-description {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.35;
}
.profile-list {
  display: grid;
  gap: 8px;
  min-width: 0;
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
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.profile-card__footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.profile-card__actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  min-width: 0;
}
.profile-name-input {
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
/* Visible focus ring for keyboard nav between cards — without this, the
   arrow-key handler moves focus invisibly and the user has no idea which
   card is selected. */
.profile-card__actions button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent), transparent 60%);
}
.profile-name-display {
  min-width: 0;
  padding: 2px 6px;
  font: inherit;
  font-weight: 700;
  color: var(--text);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-active-badge {
  color: var(--accent);
  font-size: 11px;
  justify-self: start;
}
.profile-desktop-badge {
  color: var(--muted);
  font-size: 11px;
  font-style: italic;
  justify-self: start;
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

@media (max-width: 520px) {
  .profiles-form {
    margin-top: 10px;
    gap: 8px;
  }

  .profile-card {
    padding: 8px;
  }

  .profile-card__header {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }

  .profile-card__actions {
    justify-content: stretch;
  }

  .profile-card__actions .button {
    flex: 1 1 0;
    min-width: 0;
  }

  .profile-name-input {
    padding-left: 0;
  }

  .profile-active-badge,
  .profile-desktop-badge {
    grid-row: 2;
  }
}
</style>
