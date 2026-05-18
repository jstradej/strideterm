<template>
  <div class="vol-browse">
    <div class="vol-browse__crumbs" role="navigation" aria-label="Volume path">
      <button
        type="button"
        class="vol-browse__crumb vol-browse__crumb--root"
        title="Go to volume root"
        @click="goTo('/')"
      >
        / {{ volumeName }}
      </button>
      <template v-for="(seg, idx) in segments" :key="idx">
        <span class="vol-browse__sep">/</span>
        <button type="button" class="vol-browse__crumb" @click="goTo(pathUpTo(idx))">{{ seg }}</button>
      </template>
      <button
        type="button"
        class="button button--ghost button--sm vol-browse__reload"
        :disabled="loading"
        @click="load"
      >
        {{ loading ? "Loading…" : "Reload" }}
      </button>
    </div>

    <div class="vol-browse__body">
      <div v-if="loading && entries.length === 0" class="vol-browse__loading">
        <Spinner size="md" />
        <span>Reading {{ currentPath }}…</span>
      </div>
      <div v-else-if="error" class="vol-browse__error" role="alert">
        <strong>Failed to browse volume.</strong>
        <pre>{{ error }}</pre>
        <small>The helper image (busybox) must be pullable from the active context for browsing to work.</small>
      </div>
      <div v-else-if="entries.length === 0" class="vol-browse__empty">Empty directory.</div>
      <table v-else class="vol-browse__table">
        <thead>
          <tr>
            <th class="vol-browse__col-name">Name</th>
            <th class="vol-browse__col-size">Size</th>
            <th class="vol-browse__col-perm">Permissions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in entries"
            :key="e.name"
            :class="['vol-browse__row', `vol-browse__row--${e.type}`]"
            @click="onClick(e)"
            @keydown.enter="onClick(e)"
            tabindex="0"
          >
            <td class="vol-browse__name">
              <span class="vol-browse__icon">{{ e.type === "dir" ? "📁" : e.type === "link" ? "↪" : "·" }}</span>
              {{ e.name }}<span v-if="e.linkTarget" class="vol-browse__link"> → {{ e.linkTarget }}</span>
            </td>
            <td class="vol-browse__size">{{ e.type === "file" ? formatBytes(e.size) : "—" }}</td>
            <td class="vol-browse__perm">{{ e.perm }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- File preview overlay -->
    <teleport to="body">
      <div v-if="previewOpen" class="vol-browse__overlay" @click.self="closePreview">
        <div class="vol-browse__preview" role="dialog" :aria-label="`Preview ${previewPath}`">
          <header class="vol-browse__preview-head">
            <span class="vol-browse__preview-title">{{ previewPath }}</span>
            <button type="button" class="button button--ghost button--sm" @click="closePreview">Close</button>
          </header>
          <div class="vol-browse__preview-body">
            <div v-if="previewLoading" class="vol-browse__loading">
              <Spinner size="md" />
              <span>Reading {{ previewPath }}…</span>
            </div>
            <pre v-else>{{ previewContent }}</pre>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import Spinner from "../../common/Spinner.vue";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";

interface Entry {
  name: string;
  type: "dir" | "file" | "link" | "other";
  size: number;
  perm: string;
  linkTarget?: string;
}

const props = defineProps<{
  volumeName: string;
  backendId: string;
  contextName: string;
  /** Test hook — when set, render this raw `ls -la` output instead of fetching. */
  mockListing?: string;
}>();

const appStore = useAppStore();
const notifications = useNotificationStore();

const currentPath = ref("/");
const entries = ref<Entry[]>([]);
const loading = ref(false);
const error = ref("");

const previewOpen = ref(false);
const previewPath = ref("");
const previewContent = ref("");
const previewLoading = ref(false);

const segments = computed(() => currentPath.value.split("/").filter(Boolean));

function pathUpTo(idx: number): string {
  return "/" + segments.value.slice(0, idx + 1).join("/");
}

function joinPath(base: string, name: string): string {
  if (base === "/") return `/${name}`;
  return `${base}/${name}`;
}

async function load(): Promise<void> {
  if (props.mockListing !== undefined) {
    parseAndSet(props.mockListing);
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const raw = await appStore.dockerVolumeList(
      props.volumeName,
      props.backendId,
      props.contextName,
      currentPath.value,
    );
    parseAndSet(raw);
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    error.value = msg;
    entries.value = [];
    notifications.showError("Volume browse failed", `${props.volumeName}: ${msg}`);
  } finally {
    loading.value = false;
  }
}

function parseAndSet(raw: string): void {
  // Detect `ls: …: No such file or directory` style stderr lines
  const lower = raw.toLowerCase();
  if (lower.includes("no such file") || lower.includes("not found")) {
    error.value = raw.trim();
    entries.value = [];
    return;
  }
  entries.value = parseLs(raw).filter((e) => e.name !== "." && e.name !== "..");
  // sort: dirs first, then files, alphabetic
  entries.value.sort((a, b) => {
    if (a.type !== b.type) {
      if (a.type === "dir") return -1;
      if (b.type === "dir") return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Parse busybox `ls -la` output. Format per row (8 fields + name + optional link):
 *   drwxr-xr-x    2 root root  4096 Jan  1 12:34 dirname
 *   lrwxrwxrwx    1 root root     5 Jan  1 12:34 linkname -> target
 *   -rw-r--r--    1 root root  1234 Jan  1 12:34 file with spaces.txt
 * The first line ("total N") is skipped.
 */
function parseLs(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^total\s+\d+/i.test(line)) continue;
    // Match 7 leading whitespace-separated fields, then the rest as name.
    // owner/group can contain digits-only (numeric) or names.
    const m = line.match(/^([dlrwx\-stST?]{10,11})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.*)$/);
    if (!m) continue;
    const [, perm, , , , sizeStr, , rest] = m;
    let name = rest;
    let linkTarget: string | undefined;
    if (perm.startsWith("l")) {
      const arrow = rest.indexOf(" -> ");
      if (arrow > 0) {
        name = rest.slice(0, arrow);
        linkTarget = rest.slice(arrow + 4);
      }
    }
    const type: Entry["type"] = perm.startsWith("d")
      ? "dir"
      : perm.startsWith("l")
        ? "link"
        : perm.startsWith("-")
          ? "file"
          : "other";
    out.push({ name, type, size: parseInt(sizeStr, 10) || 0, perm, linkTarget });
  }
  return out;
}

async function onClick(e: Entry): Promise<void> {
  if (e.type === "dir") {
    goTo(joinPath(currentPath.value, e.name));
  } else if (e.type === "file") {
    await openPreview(joinPath(currentPath.value, e.name));
  }
  // links: ignore in v1; following them would require resolving symlinks
  // inside the container, which is doable but out of scope for the MVP browse.
}

function goTo(path: string): void {
  currentPath.value = path;
  load();
}

async function openPreview(path: string): Promise<void> {
  previewPath.value = path;
  previewContent.value = "";
  previewLoading.value = true;
  previewOpen.value = true;
  try {
    const raw = await appStore.dockerVolumeRead(props.volumeName, props.backendId, props.contextName, path);
    previewContent.value = raw;
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    previewContent.value = `Failed to read file:\n${msg}`;
    notifications.showError("Volume read failed", `${path}: ${msg}`);
  } finally {
    previewLoading.value = false;
  }
}

function closePreview(): void {
  previewOpen.value = false;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

onMounted(load);
watch(
  () => [props.volumeName, props.backendId, props.contextName, props.mockListing],
  () => {
    currentPath.value = "/";
    load();
  },
);
</script>

<style scoped>
.vol-browse {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #141416;
}

.vol-browse__crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.06));
  flex-shrink: 0;
  flex-wrap: wrap;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
}

.vol-browse__crumb {
  background: transparent;
  border: 0;
  padding: 2px 4px;
  color: var(--accent, #63b3ed);
  cursor: pointer;
  border-radius: 3px;
}
.vol-browse__crumb:hover {
  background: rgba(99, 179, 237, 0.12);
}
.vol-browse__crumb--root {
  color: var(--text-primary, #d8e4f5);
  font-weight: 600;
}

.vol-browse__sep {
  color: var(--text-dim, #666);
  user-select: none;
}

.vol-browse__reload {
  margin-left: auto;
  font-size: 11px;
}

.vol-browse__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.vol-browse__loading,
.vol-browse__empty,
.vol-browse__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 30px;
  color: var(--text-dim, #888);
  font-size: 13px;
}

.vol-browse__error {
  color: var(--color-error, #fc8181);
}
.vol-browse__error pre {
  font-size: 11px;
  color: var(--text-primary, #d8e4f5);
  background: rgba(255, 255, 255, 0.03);
  padding: 8px;
  border-radius: 4px;
  max-width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.vol-browse__error small {
  color: var(--text-dim, #888);
  font-style: italic;
}

.vol-browse__table {
  width: 100%;
  border-collapse: collapse;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
}

.vol-browse__table th {
  position: sticky;
  top: 0;
  background: #1a1a1d;
  text-align: left;
  font-weight: 600;
  color: var(--text-dim, #aaa);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.vol-browse__col-size {
  width: 100px;
  text-align: right;
}
.vol-browse__col-perm {
  width: 120px;
}

.vol-browse__row {
  cursor: default;
  outline: none;
}
.vol-browse__row:nth-child(odd) {
  background: rgba(255, 255, 255, 0.025);
}
.vol-browse__row:hover {
  background: rgba(99, 179, 237, 0.08);
}
.vol-browse__row:focus-visible {
  outline: 1px solid var(--accent, #63b3ed);
  outline-offset: -2px;
}
.vol-browse__row--dir,
.vol-browse__row--file {
  cursor: pointer;
}

.vol-browse__row td {
  padding: 4px 10px;
  vertical-align: top;
}

.vol-browse__name {
  color: #d8e4f5;
}
.vol-browse__row--dir .vol-browse__name {
  color: #79c0ff;
}
.vol-browse__row--link .vol-browse__name {
  color: #d2a8ff;
}

.vol-browse__icon {
  display: inline-block;
  width: 1.4em;
  text-align: center;
}

.vol-browse__link {
  color: var(--text-dim, #888);
  font-style: italic;
}

.vol-browse__size {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim, #aaa);
}

.vol-browse__perm {
  color: var(--text-dim, #888);
}

/* Preview overlay */
.vol-browse__overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 24px;
}

.vol-browse__preview {
  background: #141416;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  width: min(900px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.vol-browse__preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.vol-browse__preview-title {
  flex: 1;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
  color: #79c0ff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vol-browse__preview-body {
  flex: 1 1 auto;
  overflow: auto;
  padding: 12px;
}
.vol-browse__preview-body pre {
  margin: 0;
  font-family: "JetBrainsMono NFM", "CaskaydiaCove NFM", "Fira Code", "Consolas", monospace;
  font-size: 12px;
  color: #d8e4f5;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 600px) {
  .vol-browse__col-perm {
    display: none;
  }
  .vol-browse__col-size {
    width: 80px;
  }
  .vol-browse__row td:nth-child(3) {
    display: none;
  }
  .vol-browse__row td {
    padding: 8px 10px;
  }
}
</style>
