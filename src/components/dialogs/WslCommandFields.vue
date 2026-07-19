<template>
  <!-- Launch mode: plain shell vs. WSL helper. The WSL helper builds the
       `wsl -- bash -lic "cd … && …; exec bash"` boilerplate from structured
       fields so users don't have to remember the quoting. Shared by
       EditTabDialog (new/edit tab) and PanelEditor (per-panel command) —
       extracted so the two editors can't drift (code review 2026-07 §3.5). -->
  <div class="segmented" :class="{ 'segmented--compact': compact }" role="tablist" aria-label="Launch mode">
    <button
      type="button"
      role="tab"
      :aria-selected="launchMode === 'shell'"
      :class="['segmented__btn', { 'segmented__btn--active': launchMode === 'shell' }]"
      title="Run the command directly in your default shell. Standard single-line command field."
      @click="setLaunchMode('shell')"
    >
      💻 Shell
    </button>
    <button
      type="button"
      role="tab"
      :aria-selected="launchMode === 'wsl'"
      :class="['segmented__btn', { 'segmented__btn--active': launchMode === 'wsl' }]"
      title="Wrap your command in `wsl -- bash -lic '…'` with optional distro, working directory, and keep-shell-open flag — strIDEterm builds the full command for you."
      @click="setLaunchMode('wsl')"
    >
      🐧 WSL
    </button>
  </div>

  <template v-if="launchMode === 'shell'">
    <label class="field">
      <span>Command</span>
      <input v-model="localCommand" placeholder="optional boot command" maxlength="500" />
    </label>
  </template>
  <template v-else>
    <div class="wsl-grid">
      <label class="field">
        <span>Distro (optional)</span>
        <input
          v-model="wsl.distro"
          placeholder="e.g. Ubuntu-22.04 — leave blank for default"
          maxlength="60"
          title="Optional WSL distribution name (passed as `wsl -d <distro>`). Leave blank to use your configured default distro."
        />
      </label>
      <label class="field">
        <span>Working directory (optional)</span>
        <input
          v-model="wsl.cwd"
          placeholder="/home/you"
          maxlength="500"
          title="Optional `cd <path>` to run before your command. Use a Linux-style path inside the WSL distro."
        />
      </label>
    </div>
    <label class="field">
      <span>Command</span>
      <input
        v-model="wsl.command"
        placeholder="claude --dangerously-skip-permissions"
        maxlength="500"
        title="The actual command to run inside the WSL shell — no quoting needed, strIDEterm handles it."
      />
    </label>
    <label class="wsl-keep-open">
      <input v-model="wsl.keepOpen" type="checkbox" />
      <span>
        Keep shell open after the command exits
        <small>Appends `; exec bash` so the WSL terminal stays open instead of closing on exit.</small>
      </span>
    </label>
    <div
      class="wsl-preview"
      title="The actual command strIDEterm will run. The structured fields above are just a helper — you can edit this directly for anything they don't cover (e.g. extra wsl flags)."
    >
      <span class="wsl-preview__label">Generated command</span>
      <input
        v-model="generatedWslCommand"
        class="wsl-preview__code wsl-preview__code--input"
        placeholder="(empty — nothing will run)"
        maxlength="500"
        spellcheck="false"
      />
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { buildWslCommand, parseWslCommand, type WslState } from "./wsl-launcher.js";

interface Props {
  command: string;
  /** Tighter padding/font-size for the segmented control — used by PanelEditor
   *  where several panel cards stack vertically and the roomier default
   *  (EditTabDialog's) sizing looks oversized. */
  compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  compact: false,
});

const emit = defineEmits<{
  "update:command": [command: string];
}>();

const launchMode = ref<"shell" | "wsl">("shell");
const localCommand = ref(props.command || "");
const wsl = reactive<WslState>({ distro: "", cwd: "", command: "", keepOpen: true });

// The generated command is normally derived from the structured fields, but
// the user can also type into it directly — necessary for edge cases the
// structured editor can't express (extra wsl flags, custom shell, …). We
// track manual edits in `generatedWslOverride`; any subsequent change to a
// structured field invalidates the override so the computed re-derives from
// `buildWslCommand(wsl)`. Last-edit-wins.
const generatedWslOverride = ref<string | null>(null);
const generatedWslCommand = computed<string>({
  get: () => generatedWslOverride.value ?? buildWslCommand(wsl),
  set: (val) => {
    generatedWslOverride.value = val;
  },
});
watch([() => wsl.distro, () => wsl.cwd, () => wsl.command, () => wsl.keepOpen], () => {
  generatedWslOverride.value = null;
});

function isWslLike(cmd: string): boolean {
  return /^wsl(\s|$)/i.test((cmd || "").trim());
}

// The single source of truth this component hands back to its parent via
// v-model:command — whichever mode is active, this is what actually ends up
// in the persisted command string.
const effectiveCommand = computed(() =>
  launchMode.value === "wsl" ? generatedWslCommand.value || localCommand.value : localCommand.value,
);
// flush: "sync" keeps the emit in lockstep with every keystroke/toggle so the
// parent's bound value (panel.command / commandInput) never lags a tick
// behind what's visible here — matching the old direct v-model wiring.
watch(effectiveCommand, (val) => emit("update:command", val), { immediate: true, flush: "sync" });

function setLaunchMode(mode: "shell" | "wsl"): void {
  if (launchMode.value === mode) return;
  if (mode === "wsl") {
    // Seed inner command from the current command if it's plain text (not
    // already a WSL wrapper) so the user doesn't lose what they typed when
    // toggling. Parsing the wrapper would also work but the typical case is
    // "user typed `claude`, clicked WSL" — preserve `claude`.
    const parsed = parseWslCommand(localCommand.value);
    if (parsed) {
      wsl.distro = parsed.distro;
      wsl.cwd = parsed.cwd;
      wsl.command = parsed.command;
      wsl.keepOpen = parsed.keepOpen;
    } else if (localCommand.value.trim() && !wsl.command) {
      wsl.command = localCommand.value.trim();
    }
  } else {
    // Switching back to Shell: surface the generated WSL command in the
    // single-line field so the user keeps something useful, but only if
    // their shell field is empty (don't clobber a manual edit). Use the
    // computed (override-aware) value so a manually-edited generated command
    // also rides along.
    const generated = generatedWslCommand.value;
    if (generated && !localCommand.value.trim()) {
      localCommand.value = generated;
    }
  }
  launchMode.value = mode;
}

// Auto-detect a previously-saved WSL launcher command so the editor opens
// with the structured fields pre-filled instead of the raw
// `wsl -- bash -lic "…"` string.
onMounted(async () => {
  const raw = props.command || "";
  const parsed = parseWslCommand(raw);
  if (parsed) {
    wsl.distro = parsed.distro;
    wsl.cwd = parsed.cwd;
    wsl.command = parsed.command;
    wsl.keepOpen = parsed.keepOpen;
    launchMode.value = "wsl";
  } else if (isWslLike(raw)) {
    // Bare `wsl` (from a tab template) or `wsl -d <distro>` — open the
    // structured editor with whatever distro flag we can extract, no inner
    // command yet. keepOpen=false so the derived "Generated command" stays
    // empty until the user fills something in; we then seed the override
    // with the original text so the editable preview shows what they had,
    // not a blank or an unrelated wrapper.
    const distroMatch = /^wsl\s+-d\s+(\S+)/i.exec(raw.trim());
    if (distroMatch) wsl.distro = distroMatch[1];
    wsl.keepOpen = false;
    launchMode.value = "wsl";
    // Wait for the wsl-field watcher to flush (it clears the override) so
    // our preserved value isn't immediately wiped.
    await nextTick();
    generatedWslOverride.value = raw.trim();
  }
});
</script>

<style scoped>
.field {
  margin: 0;
}

/* Segmented control — replaces ugly radio rows for binary toggles. */
.segmented {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
}
.segmented__btn {
  flex: 1;
  padding: 8px 14px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background 0.12s,
    color 0.12s;
}
.segmented--compact .segmented__btn {
  padding: 6px 10px;
  font-size: 12px;
}
.segmented__btn:hover:not(.segmented__btn--active) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
}
.segmented__btn--active {
  background: var(--accent);
  color: #000;
}

/* WSL launcher fields — two-column layout for distro + cwd, then full-width
   command, keep-open checkbox, and a read-only preview of the generated
   command so the user can see exactly what will end up in panel.command. */
.wsl-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 10px;
}
.wsl-keep-open {
  display: flex !important;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  cursor: pointer;
  padding: 6px 0;
}
.wsl-keep-open input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 2px 0 0 0;
  flex-shrink: 0;
  accent-color: var(--accent);
}
.wsl-keep-open span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text);
  font-weight: 500;
}
.wsl-keep-open small {
  color: var(--muted);
  font-size: 11px;
  font-weight: 400;
}
.wsl-preview {
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.02);
}
.wsl-preview__label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
}
.wsl-preview__code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text);
  word-break: break-all;
  white-space: pre-wrap;
}
/* Editable form of the preview — same monospace look, but a real input so
   the user can override anything the structured fields can't express. */
.wsl-preview__code--input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(var(--tint), 0.04);
  outline: none;
}
.wsl-preview__code--input:focus {
  border-color: var(--accent);
  background: rgba(var(--tint), 0.06);
}
</style>
