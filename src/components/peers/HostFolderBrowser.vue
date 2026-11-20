<template>
  <div class="dialog host-folders" data-testid="host-folders">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Browse</p>
        <h2 data-testid="host-folders-title">Choose a folder on {{ hostLabel }}</h2>
      </div>
    </div>

    <div class="host-folders__body">
      <div class="host-folders__roots" data-testid="host-folders-roots">
        <button
          v-for="(root, index) in roots"
          :key="root"
          type="button"
          class="button button--ghost"
          :title="root"
          data-testid="host-folders-root"
          @click="load(root)"
        >
          {{ index === 0 ? "Home" : root }}
        </button>
      </div>

      <form class="host-folders__path" @submit.prevent="goToTyped">
        <button
          type="button"
          class="button button--ghost"
          data-testid="host-folders-up"
          :disabled="!listing?.parent"
          @click="goUp"
        >
          Up
        </button>
        <input
          v-model="pathInput"
          class="settings-input"
          data-testid="host-folders-path"
          type="text"
          autocomplete="off"
          spellcheck="false"
          aria-label="Folder path on the other computer"
        />
      </form>
      <p v-if="error" class="inline-error" role="alert" data-testid="host-folders-error">{{ error }}</p>

      <input
        v-model="filter"
        class="settings-input"
        data-testid="host-folders-filter"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Filter folders"
        aria-label="Filter folders"
        @keydown.esc.stop="filter = ''"
      />

      <div
        class="host-folders__list"
        role="listbox"
        tabindex="0"
        aria-label="Folders"
        :aria-busy="loading ? 'true' : undefined"
        data-testid="host-folders-list"
        @keydown="onListKeydown"
      >
        <p v-if="loading && !listing" class="host-folders__note" data-testid="host-folders-loading">
          <Spinner size="sm" label="Loading folders" aria-hidden="true" />
          Loading…
        </p>
        <template v-else>
          <button
            v-for="entry in visible"
            :key="entry.name"
            type="button"
            role="option"
            tabindex="-1"
            class="host-folders__row"
            :class="{ 'host-folders__row--selected': entry.name === selected }"
            :aria-selected="entry.name === selected"
            data-testid="host-folders-row"
            @click="selected = entry.name"
            @dblclick="open(entry.name)"
          >
            <span aria-hidden="true">📁</span>
            <span class="host-folders__name">{{ entry.name }}</span>
          </button>
          <p v-if="!visible.length && !loading" class="host-folders__note" data-testid="host-folders-empty">
            {{ filter ? "No folders match." : "No folders here." }}
          </p>
        </template>
      </div>
      <p v-if="loading && listing" class="host-folders__note" data-testid="host-folders-loading">
        <Spinner size="sm" label="Loading folders" aria-hidden="true" />
        Loading…
      </p>
      <p v-if="listing?.truncated" class="host-folders__note" data-testid="host-folders-truncated">
        Showing the first 2000 folders — type a path to go deeper.
      </p>
    </div>

    <footer class="dialog__footer">
      <button type="button" class="button button--ghost" data-testid="host-folders-cancel" @click="emit('cancel')">
        Cancel
      </button>
      <button
        type="button"
        class="button button--primary"
        data-testid="host-folders-use"
        :disabled="!listing"
        @click="use"
      >
        {{ selected ? `Use ${selected}` : "Use this folder" }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, ref } from "vue";
import { apiKey } from "../../types/keys.js";
import type { Transport } from "../../transport.js";
import type { PeerDirectoryListing } from "../../../electron/shared/peers.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { rlog } from "../../lib/renderer-log.js";
import Spinner from "../common/Spinner.vue";

const props = defineProps<{ hostLabel: string; initialPath?: string }>();
const emit = defineEmits<{ select: [path: string]; cancel: [] }>();

const api = inject<Transport>(apiKey);

const listing = ref<PeerDirectoryListing | null>(null);
const loading = ref(true);
const error = ref("");
const pathInput = ref("");
const selected = ref<string | null>(null);
const filter = ref("");
let sequence = 0;

const roots = computed(() => listing.value?.roots ?? []);
const visible = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const entries = listing.value?.entries ?? [];
  return needle ? entries.filter((entry) => entry.name.toLowerCase().includes(needle)) : entries;
});

function joinPath(base: string, name: string, separator: string): string {
  return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
}

/** Resolves true when this listing was applied; a newer load makes an older answer a no-op. */
async function load(path: string, quiet = false): Promise<boolean> {
  const token = ++sequence;
  loading.value = true;
  try {
    const list = api?.listHostDirectories;
    if (!list) throw new Error("Folders on the other computer cannot be listed from this window.");
    const result = await list({ path });
    if (token !== sequence) return false;
    listing.value = result;
    pathInput.value = result.path;
    selected.value = null;
    filter.value = "";
    error.value = "";
    return true;
  } catch (err) {
    if (token !== sequence) return false;
    if (quiet) {
      rlog("debug", "[host-folders] initial folder not listed, using home", { error: userFacingMessage(err, "") });
      return false;
    }
    error.value = userFacingMessage(err, "Could not list this folder.");
    pathInput.value = listing.value?.path ?? path;
    rlog("warn", "[host-folders] listing failed", { error: error.value });
    return false;
  } finally {
    if (token === sequence) loading.value = false;
  }
}

async function start(): Promise<void> {
  const initial = props.initialPath?.trim() ?? "";
  if (!initial) {
    await load("");
    return;
  }
  if (await load(initial, true)) return;
  if (!listing.value) await load("");
}

function goUp(): void {
  if (listing.value?.parent) void load(listing.value.parent);
}

function goToTyped(): void {
  const typed = pathInput.value.trim();
  if (typed) void load(typed);
}

function open(name: string): void {
  if (!listing.value) return;
  void load(joinPath(listing.value.path, name, listing.value.separator));
}

function use(): void {
  if (!listing.value) return;
  emit(
    "select",
    selected.value ? joinPath(listing.value.path, selected.value, listing.value.separator) : listing.value.path,
  );
}

function onListKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const names = visible.value.map((entry) => entry.name);
  const index = selected.value ? names.indexOf(selected.value) : -1;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!names.length) return;
    const next = event.key === "ArrowDown" ? Math.min(index + 1, names.length - 1) : Math.max(index - 1, 0);
    selected.value = names[next] ?? null;
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (selected.value) open(selected.value);
  } else if (event.key === "Backspace") {
    event.preventDefault();
    if (filter.value) filter.value = filter.value.slice(0, -1);
    else goUp();
  } else if (event.key.length === 1 && event.key !== " ") {
    event.preventDefault();
    filter.value += event.key;
  }
}

onMounted(() => void start());
</script>

<style scoped>
.host-folders__body {
  margin-top: 12px;
  display: grid;
  gap: 8px;
  min-width: 0;
}
.host-folders__roots {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.host-folders__path {
  display: flex;
  gap: 6px;
  align-items: stretch;
}
.host-folders__path input {
  flex: 1;
  min-width: 0;
}
.host-folders__list {
  height: 280px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
}
.host-folders__list:focus-visible {
  outline: 1px solid var(--accent);
}
.host-folders__row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 10px;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  font: inherit;
  cursor: default;
}
.host-folders__row:hover {
  background: rgba(var(--tint), 0.06);
}
.host-folders__row--selected,
.host-folders__row--selected:hover {
  background: rgba(var(--tint), 0.14);
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.host-folders__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.host-folders__note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  color: var(--muted);
  font-size: 13px;
}
</style>
