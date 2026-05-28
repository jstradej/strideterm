<template>
  <div v-if="open" class="term-search" role="search" @mousedown.stop @touchstart.stop>
    <input
      ref="inputRef"
      type="text"
      class="term-search__input"
      :placeholder="placeholder"
      :value="query"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
    />
    <span class="term-search__count" :class="{ 'term-search__count--empty': hasNoResults }">
      {{ countLabel }}
    </span>
    <button
      type="button"
      class="term-search__toggle"
      :class="{ 'term-search__toggle--on': caseSensitive }"
      title="Match case"
      :aria-pressed="caseSensitive"
      @click="toggleCase"
    >
      Aa
    </button>
    <button
      type="button"
      class="term-search__toggle"
      :class="{ 'term-search__toggle--on': wholeWord }"
      title="Match whole word"
      :aria-pressed="wholeWord"
      @click="toggleWholeWord"
    >
      ab|
    </button>
    <button
      type="button"
      class="term-search__toggle"
      :class="{ 'term-search__toggle--on': regex }"
      title="Use regular expression"
      :aria-pressed="regex"
      @click="toggleRegex"
    >
      .*
    </button>
    <button
      type="button"
      class="term-search__nav"
      title="Previous match (Shift+Enter)"
      :disabled="!query"
      @click="findPrev"
    >
      ▲
    </button>
    <button type="button" class="term-search__nav" title="Next match (Enter)" :disabled="!query" @click="findNext">
      ▼
    </button>
    <button type="button" class="term-search__close" title="Close (Esc)" @click="close">×</button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from "vue";
import { useTerminalStore } from "../../stores/terminal.js";

const props = defineProps<{ sessionId: string }>();

const termStore = useTerminalStore();
const open = ref(false);
const query = ref("");
const caseSensitive = ref(false);
const wholeWord = ref(false);
const regex = ref(false);
const resultIndex = ref(-1);
const resultCount = ref(0);
// Truth-source for "did the last find call hit anything". The addon's
// onDidChangeResults event reports a stale resultCount when the buffer is
// being rewritten continuously (Claude Code redrawing its status bar fires
// onWriteParsed multiple times per second, and the addon's internal
// 200 ms re-search debounce keeps emitting count=0 in between). findNext /
// findPrevious return synchronously based on the engine's actual find, so
// we use that as the authoritative "any match found" signal and only fall
// back to the event count for the "X of Y" position display.
const lastFoundAny = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
// Last query value the addon was asked to search for. Used by
// rerunFromTyping to tell "extending the query by one char" (use the
// addon's incremental fast path going forward) from "fresh / shortened /
// diverged query" (re-anchor with findPrevious so the initial match is
// the most recent occurrence at the bottom of the buffer, matching the
// iTerm2-style terminal search behaviour).
let prevQuery = "";
let unsubscribeResults: { dispose: () => void } | null = null;

const hasNoResults = computed(() => query.value.length > 0 && !lastFoundAny.value && resultCount.value === 0);
const placeholder = computed(() => "Find");
const countLabel = computed(() => {
  if (!query.value) return "";
  if (!lastFoundAny.value && resultCount.value === 0) return "No results";
  // Prefer the event-driven "X of Y" position when the addon has emitted
  // a non-zero count. When the count is stale (zero) but the engine just
  // found a match, fall back to a positionless "Match" label so the user
  // doesn't see a false "No results".
  if (resultCount.value === 0) return "Match";
  if (resultIndex.value < 0) return `${resultCount.value} ${resultCount.value === 1 ? "match" : "matches"}`;
  return `${resultIndex.value + 1} of ${resultCount.value}`;
});

// Match highlight colors. The default gray decorations are barely visible
// against terminal output, so we paint matches in the app accent (orange).
// The active match gets a saturated fill + border; the rest are translucent
// so the active hit stays clearly distinct when you cycle through with
// Enter / Shift+Enter. Light mode uses the slightly darker accent token so
// the highlight still contrasts on the light background.
function matchDecorations() {
  const isLight = document.documentElement.dataset.theme === "light";
  const accent = isLight ? "#cc8520" : "#ffa424";
  return {
    matchBackground: isLight ? "rgba(204, 133, 32, 0.28)" : "rgba(255, 164, 36, 0.28)",
    matchBorder: isLight ? "rgba(204, 133, 32, 0.55)" : "rgba(255, 164, 36, 0.55)",
    matchOverviewRuler: accent,
    activeMatchBackground: accent,
    activeMatchBorder: isLight ? "#8a5a14" : "#ffd089",
    activeMatchColorOverviewRuler: accent,
  };
}

function searchOptions() {
  return {
    regex: regex.value,
    wholeWord: wholeWord.value,
    caseSensitive: caseSensitive.value,
    decorations: matchDecorations(),
  };
}

function attachAddonListener(): void {
  detachAddonListener();
  const addon = termStore.getSearchAddon(props.sessionId);
  if (!addon) return;
  unsubscribeResults = addon.onDidChangeResults((res) => {
    resultIndex.value = res.resultIndex;
    resultCount.value = res.resultCount;
  });
}

function detachAddonListener(): void {
  unsubscribeResults?.dispose();
  unsubscribeResults = null;
}

function clearDecorations(): void {
  const addon = termStore.getSearchAddon(props.sessionId);
  addon?.clearDecorations();
}

// Re-run search after a query/toggle change. We use findNext with
// incremental:true on plain typing so the active match stays as close as
// possible to where the user already was — same UX as VS Code's terminal
// search and most code editors.
function rerunFromTyping(): void {
  const addon = termStore.getSearchAddon(props.sessionId);
  if (!addon) return;
  if (!query.value) {
    addon.clearDecorations();
    resultIndex.value = -1;
    resultCount.value = 0;
    lastFoundAny.value = false;
    prevQuery = "";
    return;
  }
  // Terminal scrollback is time-ordered: oldest output at the top, newest
  // at the bottom — which is also where the user's eyes are. A naïve
  // findNext from no-selection starts at row 0 and scrolls the viewport to
  // the oldest match, dragging the user away from their context. We mirror
  // iTerm2's behaviour instead:
  //   - Fresh search (no prev query, or query shrank, or query diverged):
  //     findPrevious — xterm starts from the end of the buffer and walks
  //     backward, so the first match is the most recent occurrence.
  //   - User extends the query by one or more chars: findNext with
  //     incremental:true — the addon's selection-expanding fast path keeps
  //     the existing match anchored under the cursor instead of jumping.
  const extending = prevQuery !== "" && query.value.startsWith(prevQuery);
  if (extending) {
    lastFoundAny.value = addon.findNext(query.value, { ...searchOptions(), incremental: true });
  } else {
    lastFoundAny.value = addon.findPrevious(query.value, searchOptions());
  }
  prevQuery = query.value;
}

function findNext(): void {
  const addon = termStore.getSearchAddon(props.sessionId);
  if (!addon || !query.value) return;
  lastFoundAny.value = addon.findNext(query.value, searchOptions());
}

function findPrev(): void {
  const addon = termStore.getSearchAddon(props.sessionId);
  if (!addon || !query.value) return;
  lastFoundAny.value = addon.findPrevious(query.value, searchOptions());
}

function toggleCase(): void {
  caseSensitive.value = !caseSensitive.value;
  rerunFromTyping();
}

function toggleWholeWord(): void {
  wholeWord.value = !wholeWord.value;
  rerunFromTyping();
}

function toggleRegex(): void {
  regex.value = !regex.value;
  rerunFromTyping();
}

function onInput(event: Event): void {
  query.value = (event.target as HTMLInputElement).value;
  rerunFromTyping();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) findPrev();
    else findNext();
    return;
  }
}

function openOverlay(): void {
  if (open.value) {
    inputRef.value?.focus();
    inputRef.value?.select();
    return;
  }
  open.value = true;
  attachAddonListener();
  // Wait for the input to mount before focusing. If a query is left over
  // from a previous open (we keep state across re-opens within the same
  // pane lifetime — see comments on close()), select it so the user can
  // type a fresh term immediately.
  void nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
    if (query.value) rerunFromTyping();
  });
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  prevQuery = "";
  clearDecorations();
  detachAddonListener();
  // Hand focus back to the terminal so the user can keep typing without
  // a manual click. termStore.focusActiveTerminal does the right thing
  // even when an overlay is up (it checks getOverlay() — but that's the
  // app-level dialog overlay, not our search bar).
  termStore.focusActiveTerminal();
}

function onWindowSearchRequest(event: Event): void {
  const detail = (event as CustomEvent).detail;
  if (!detail || detail.sessionId !== props.sessionId) return;
  openOverlay();
}

onMounted(() => {
  window.addEventListener("strideterm:terminal-search", onWindowSearchRequest);
});

onBeforeUnmount(() => {
  window.removeEventListener("strideterm:terminal-search", onWindowSearchRequest);
  detachAddonListener();
  clearDecorations();
});

// When the pane is reused for a different session (the sessionId prop
// changes — happens during a tab swap in a split), close the overlay so
// the user doesn't end up searching the wrong terminal. The previous
// pane's addon is gone with the previous session, so we just reset state
// without trying to clear anything on it.
watch(
  () => props.sessionId,
  () => {
    open.value = false;
    query.value = "";
    resultIndex.value = -1;
    resultCount.value = 0;
    lastFoundAny.value = false;
    prevQuery = "";
    detachAddonListener();
  },
);
</script>

<style scoped>
.term-search {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--panel-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow);
  font-family: Inter, "Segoe UI", system-ui, sans-serif;
  font-size: 12px;
  color: var(--text);
  max-width: calc(100% - 12px);
}

.term-search__input {
  flex: 1 1 180px;
  min-width: 100px;
  background: rgba(var(--tint), 0.04);
  border: 1px solid rgba(var(--tint), 0.1);
  border-radius: 4px;
  padding: 4px 8px;
  color: var(--text);
  font: inherit;
  outline: none;
}

.term-search__input:focus {
  border-color: var(--accent);
}

.term-search__count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted);
  min-width: 56px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.term-search__count--empty {
  color: var(--danger);
}

.term-search__toggle,
.term-search__nav,
.term-search__close {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(var(--tint), 0.08);
  border-radius: 4px;
  background: rgba(var(--tint), 0.04);
  color: var(--text);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.term-search__toggle:hover,
.term-search__nav:hover,
.term-search__close:hover {
  background: rgba(var(--tint), 0.12);
  border-color: rgba(var(--tint), 0.18);
}

.term-search__toggle--on {
  background: color-mix(in srgb, var(--accent), transparent 75%);
  border-color: color-mix(in srgb, var(--accent), transparent 40%);
  color: var(--accent);
}

.term-search__nav:disabled,
.term-search__nav:disabled:hover {
  cursor: default;
  background: rgba(var(--tint), 0.04);
  color: var(--muted);
  border-color: rgba(var(--tint), 0.08);
}

.term-search__close {
  margin-left: 2px;
}

/* Mobile / narrow pane: drop the input min-width so the bar fits, keep
   toggles small. Container query against the pane body matches the rest
   of the pane responsive rules. */
@container (max-width: 420px) {
  .term-search {
    gap: 2px;
    padding: 3px 4px;
    left: 6px;
    max-width: calc(100% - 12px);
  }

  .term-search__input {
    flex: 1 1 60px;
    min-width: 60px;
  }

  .term-search__count {
    min-width: 0;
    font-size: 10px;
  }
}

@container (max-width: 320px) {
  .term-search__toggle {
    display: none;
  }
}
</style>
