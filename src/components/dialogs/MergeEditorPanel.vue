<template>
  <div class="mep" :class="{ 'mep--narrow': isNarrow }">
    <!-- Toolbar -->
    <div class="mep__toolbar">
      <span class="mep__file" :title="filePath">{{ shortName }}</span>
      <div class="mep__toolbar-center">
        <button
          type="button"
          class="button button--ghost button--small"
          title="Auto-resolve every chunk that was changed on only one side — only real conflicts remain"
          :disabled="!hasNonConflicting"
          @click="applyAllNonConflicting"
        >
          ⚡ Apply non-conflicting
        </button>
        <div class="mep__nav">
          <button
            type="button"
            class="mep__nav-btn"
            title="Jump to the previous unresolved conflict"
            :disabled="totalConflicts === 0"
            @click="prevConflict"
          >
            ◀
          </button>
          <span class="mep__nav-count" :class="{ 'mep__nav-count--done': totalConflicts === 0 }">
            {{ totalConflicts === 0 ? "no conflicts" : `${currentConflictIdx + 1} / ${totalConflicts}` }}
          </span>
          <button
            type="button"
            class="mep__nav-btn"
            title="Jump to the next unresolved conflict"
            :disabled="totalConflicts === 0"
            @click="nextConflict"
          >
            ▶
          </button>
        </div>
        <template v-if="currentConflict">
          <button
            type="button"
            class="button button--ghost button--small"
            :title="`Insert ${oursLabel}'s version (left pane) into the Result`"
            @click="applyOurs"
          >
            {{ oursLabel }} ▶
          </button>
          <button
            type="button"
            class="button button--ghost button--small"
            :title="`Insert ${theirsLabel}'s version (right pane) into the Result`"
            @click="applyTheirs"
          >
            ◀ {{ theirsLabel }}
          </button>
        </template>
      </div>
    </div>

    <!-- Mobile tab selector -->
    <div v-if="isNarrow" class="mep__tabs">
      <button
        v-for="tab in ['ours', 'result', 'theirs'] as const"
        :key="tab"
        type="button"
        :class="['mep__tab', { 'mep__tab--active': activeTab === tab }]"
        :title="
          tab === 'ours'
            ? `Show ${oursLabel}'s version (read-only)`
            : tab === 'theirs'
              ? `Show ${theirsLabel}'s version (read-only)`
              : 'Show the editable merged result'
        "
        @click="activeTab = tab"
      >
        {{ tab === "ours" ? oursLabel : tab === "theirs" ? theirsLabel : "Result" }}
      </button>
    </div>

    <!-- Pane labels (desktop) -->
    <div v-if="!isNarrow" class="mep__pane-labels">
      <div class="mep__pane-label">{{ oursLabel }} <span class="mep__pane-tag">ours</span></div>
      <div class="mep__pane-label mep__pane-label--result">Result</div>
      <div class="mep__pane-label">{{ theirsLabel }} <span class="mep__pane-tag">theirs</span></div>
    </div>

    <!-- Loading / error -->
    <div v-if="loading" class="mep__overlay">Loading conflict detail…</div>
    <div v-else-if="loadError" class="mep__overlay mep__overlay--error">{{ loadError }}</div>

    <!-- Three editors (desktop: side by side, narrow: single tab) -->
    <div v-else class="mep__editors">
      <div v-if="!isNarrow || activeTab === 'ours'" :class="['mep__pane', isNarrow && 'mep__pane--full']">
        <div ref="oursContainer" class="mep__editor-host"></div>
      </div>
      <div
        v-if="!isNarrow || activeTab === 'result'"
        :class="['mep__pane', 'mep__pane--result', isNarrow && 'mep__pane--full']"
      >
        <div ref="resultContainer" class="mep__editor-host"></div>
      </div>
      <div v-if="!isNarrow || activeTab === 'theirs'" :class="['mep__pane', isNarrow && 'mep__pane--full']">
        <div ref="theirsContainer" class="mep__editor-host"></div>
      </div>
    </div>

    <!-- Footer -->
    <div class="mep__footer">
      <span class="mep__conflict-count">
        <template v-if="totalConflicts > 0">⚠ {{ totalConflicts }} remaining</template>
        <template v-else-if="markerCount > 0">⚠ conflict markers remain</template>
        <template v-else>✓ All resolved</template>
      </span>
      <div class="mep__footer-actions">
        <button
          type="button"
          class="button button--ghost"
          title="Discard the edits in Result and go back to the conflict list"
          @click="onCancel"
        >
          Cancel
        </button>
        <button
          type="button"
          class="button"
          :disabled="markerCount > 0 || busy"
          :title="
            markerCount > 0
              ? 'Remove all conflict markers (<<<<<<< ======= >>>>>>>) before applying'
              : 'Save the Result as the file content and mark the conflict resolved'
          "
          @click="onApply"
        >
          {{ busy ? "Applying…" : "Apply" }}
        </button>
      </div>
    </div>
  </div>

  <!-- Dirty-cancel confirm -->
  <Teleport to="body">
    <div v-if="confirmCancel" class="mep-backdrop" @mousedown.self="confirmCancel = false">
      <div class="mep-confirm">
        <p>Discard unsaved changes to the Result?</p>
        <div class="mep-confirm__actions">
          <button
            type="button"
            class="button button--ghost"
            title="Stay in the merge editor and keep the changes"
            @click="confirmCancel = false"
          >
            Keep editing
          </button>
          <button
            type="button"
            class="button"
            style="background: var(--danger)"
            title="Throw away the edits to Result and return to the conflict list"
            @click="emit('cancel')"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import "../../app/monaco-setup.js";
import * as monaco from "monaco-editor";
import { merge3, applyNonConflicting } from "../../lib/merge3.js";
import type { Chunk } from "../../lib/merge3.js";
import { useAppStore } from "../../stores/app.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import { guessLanguageFromPath } from "../../../config/language-map.js";

const props = defineProps<{
  filePath: string;
  conflictType: string;
  workspaceId: string;
  rootPath: string;
  sides: { ours: string; theirs: string } | null;
}>();

const emit = defineEmits<{
  (e: "apply"): void;
  (e: "cancel"): void;
}>();

const appStore = useAppStore();
const { isNarrow } = useIsNarrow();

const activeTab = ref<"ours" | "result" | "theirs">("result");
const loading = ref(true);
const loadError = ref("");
const busy = ref(false);
const confirmCancel = ref(false);

const oursLabel = computed(() => props.sides?.ours || "Ours");
const theirsLabel = computed(() => props.sides?.theirs || "Theirs");

const shortName = computed(() => props.filePath.split("/").pop() || props.filePath);
const language = computed(() => guessLanguageFromPath(props.filePath));

// ---- Content from backend ----
const baseContent = ref("");
const oursContent = ref("");
const theirsContent = ref("");
const initialResultText = ref("");

// ---- Monaco refs ----
const oursContainer = ref<HTMLDivElement | null>(null);
const resultContainer = ref<HTMLDivElement | null>(null);
const theirsContainer = ref<HTMLDivElement | null>(null);

let oursEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let resultEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let theirsEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let resizeObs: ResizeObserver | null = null;

// CodeLens ("✓ Ours | ✓ Theirs | Both" above each conflict block) lifecycle
let lensProvider: monaco.IDisposable | null = null;
let lensProviderObj: monaco.languages.CodeLensProvider | null = null;
// Monaco types onDidChange as IEvent<CodeLensProvider> (it re-emits the provider);
// the payload is ignored, so we just fire the provider object back.
let lensEmitter: monaco.Emitter<monaco.languages.CodeLensProvider> | null = null;
let acceptCommandId = "";

// ---- Conflict model: inline git-style markers (<<<<<<< ======= >>>>>>>) ----
// The Result editor holds the auto-merged text with each remaining conflict
// written inline using standard git conflict markers. Resolution = remove the
// markers (keep whichever side(s) you want), exactly like `git mergetool` or
// VS Code. Conflict positions are derived by re-scanning the buffer on every
// edit — no sticky decorations to keep in sync, so any manual edit (delete a
// side, accept via CodeLens, free-type) stays consistent automatically.

const MARK_OURS = "<<<<<<<";
const MARK_SEP = "=======";
const MARK_THEIRS = ">>>>>>>";

interface ConflictBlock {
  startLine: number; // line of <<<<<<<  (1-based)
  sepLine: number; // line of =======
  endLine: number; // line of >>>>>>>
  oursLines: string[];
  theirsLines: string[];
}

// Where each conflict lives in the FULL ours/theirs files (1-based, inclusive).
// Derived once from the merge3 chunks at load — the side files never change, so
// these stay valid for the whole session and drive the read-only side highlights.
interface SideRegion {
  oursStart: number;
  oursEnd: number; // < oursStart means the ours side is empty here
  theirsStart: number;
  theirsEnd: number;
  key: string; // ours+theirs content — maps a live Result block back to its region
}

// Module-level mutable state — Monaco operations are synchronous
let allChunksData: Chunk[] = [];
let resultDecColl: monaco.editor.IEditorDecorationsCollection | null = null;
let oursDecColl: monaco.editor.IEditorDecorationsCollection | null = null;
let theirsDecColl: monaco.editor.IEditorDecorationsCollection | null = null;
let conflictRegions: SideRegion[] = [];
const regionByKey = new Map<string, SideRegion>();

const blocks = ref<ConflictBlock[]>([]);
// Count of <<<<<<< / >>>>>>> lines remaining anywhere in the buffer. These two
// sentinels are vanishingly unlikely in real content (unlike a bare =======,
// which markdown setext headings use), so they gate Apply: zero left = clean.
const markerCount = ref(0);
const currentConflictIdx = ref(0);

const totalConflicts = computed(() => blocks.value.length);
const currentConflict = computed(() => blocks.value[currentConflictIdx.value] ?? null);
// Non-conflicting = ours/theirs chunks where only one side changed
const hasNonConflicting = computed(() => allChunksData.some((c) => c.kind === "ours" || c.kind === "theirs"));

// ---- Map each conflict to its line range in the full ours/theirs files ----
// Concatenating every chunk's oursLines reconstructs the full ours file (same
// for theirs), so accumulating line counts gives each conflict's position.
function regionKey(oursLines: string[], theirsLines: string[]): string {
  return oursLines.join("\n") + " " + theirsLines.join("\n");
}

function computeConflictRegions(chunks: Chunk[]): SideRegion[] {
  const regions: SideRegion[] = [];
  let oursOff = 0;
  let theirsOff = 0;
  for (const c of chunks) {
    if (c.kind === "conflict") {
      regions.push({
        oursStart: oursOff + 1,
        oursEnd: oursOff + c.oursLines.length,
        theirsStart: theirsOff + 1,
        theirsEnd: theirsOff + c.theirsLines.length,
        key: regionKey(c.oursLines, c.theirsLines),
      });
    }
    oursOff += c.oursLines.length;
    theirsOff += c.theirsLines.length;
  }
  return regions;
}

// The side region matching the current Result block (by content — survives
// resolving other conflicts; only fails once the user edits this block's text).
function currentRegion(): SideRegion | null {
  const b = currentConflict.value;
  if (!b) return null;
  return regionByKey.get(regionKey(b.oursLines, b.theirsLines)) ?? null;
}

// ---- Highlight conflict regions in the read-only ours/theirs panes ----
function renderSideDecorations() {
  if (!oursDecColl || !theirsDecColl) return;
  const active = currentRegion();
  const oursDecs: monaco.editor.IModelDeltaDecoration[] = [];
  const theirsDecs: monaco.editor.IModelDeltaDecoration[] = [];
  for (const r of conflictRegions) {
    const isActive = r === active;
    if (r.oursEnd >= r.oursStart) {
      oursDecs.push({
        range: new monaco.Range(r.oursStart, 1, r.oursEnd, 1),
        options: {
          isWholeLine: true,
          className: isActive ? "mep-sidepane-ours-active" : "mep-sidepane-ours",
          overviewRuler: {
            color: isActive ? "rgba(60,200,100,1)" : "rgba(60,180,90,0.7)",
            position: monaco.editor.OverviewRulerLane.Full,
          },
        },
      });
    }
    if (r.theirsEnd >= r.theirsStart) {
      theirsDecs.push({
        range: new monaco.Range(r.theirsStart, 1, r.theirsEnd, 1),
        options: {
          isWholeLine: true,
          className: isActive ? "mep-sidepane-theirs-active" : "mep-sidepane-theirs",
          overviewRuler: {
            color: isActive ? "rgba(80,160,255,1)" : "rgba(64,140,255,0.7)",
            position: monaco.editor.OverviewRulerLane.Full,
          },
        },
      });
    }
  }
  oursDecColl.set(oursDecs);
  theirsDecColl.set(theirsDecs);
}

// ---- Build the Result buffer: auto-merged text + inline conflict markers ----
function buildResultText(appliedChunks: Chunk[]): string {
  const lines: string[] = [];
  for (const chunk of appliedChunks) {
    if (chunk.kind === "conflict") {
      lines.push(`${MARK_OURS} ${oursLabel.value}`);
      lines.push(...chunk.oursLines);
      lines.push(MARK_SEP);
      lines.push(...chunk.theirsLines);
      lines.push(`${MARK_THEIRS} ${theirsLabel.value}`);
    } else {
      lines.push(...chunk.resultLines);
    }
  }
  return lines.join("\n");
}

// ---- Parse conflict markers out of the live buffer ----
function parseConflicts(model: monaco.editor.ITextModel): { blocks: ConflictBlock[]; markerCount: number } {
  const total = model.getLineCount();
  const out: ConflictBlock[] = [];
  let markers = 0;
  let i = 1;
  while (i <= total) {
    const line = model.getLineContent(i);
    if (line.startsWith(MARK_OURS) || line.startsWith(MARK_THEIRS)) markers++;
    if (line.startsWith(MARK_OURS)) {
      let sep = -1;
      let end = -1;
      for (let j = i + 1; j <= total; j++) {
        const lj = model.getLineContent(j);
        if (lj.startsWith(MARK_OURS)) break; // unterminated block — bail, rescan from here
        if (sep === -1 && lj.startsWith(MARK_SEP)) {
          sep = j;
        } else if (sep !== -1 && lj.startsWith(MARK_THEIRS)) {
          end = j;
          break;
        }
      }
      if (sep !== -1 && end !== -1) {
        const oursLines: string[] = [];
        for (let k = i + 1; k < sep; k++) oursLines.push(model.getLineContent(k));
        const theirsLines: string[] = [];
        for (let k = sep + 1; k < end; k++) theirsLines.push(model.getLineContent(k));
        out.push({ startLine: i, sepLine: sep, endLine: end, oursLines, theirsLines });
        markers++; // the closing >>>>>>> we skip past below (opening <<< already counted)
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return { blocks: out, markerCount: markers };
}

// ---- Re-scan the buffer and refresh reactive state + decorations + lenses ----
function reparse() {
  const model = resultEditor?.getModel();
  if (!model) {
    blocks.value = [];
    markerCount.value = 0;
    return;
  }
  const r = parseConflicts(model);
  blocks.value = r.blocks;
  markerCount.value = r.markerCount;
  if (currentConflictIdx.value >= blocks.value.length) {
    currentConflictIdx.value = Math.max(0, blocks.value.length - 1);
  }
  updateDecorations();
  renderSideDecorations();
  if (lensProviderObj) lensEmitter?.fire(lensProviderObj);
}

// ---- Decorations: tint ours/theirs regions, mark current block (visual only) ----
function updateDecorations() {
  if (!resultEditor || !resultDecColl) return;
  const decs: monaco.editor.IModelDeltaDecoration[] = [];
  blocks.value.forEach((b, i) => {
    const isCurrent = i === currentConflictIdx.value;
    decs.push({
      range: new monaco.Range(b.startLine, 1, b.startLine, 1),
      options: { isWholeLine: true, className: "mep-marker mep-marker-ours" },
    });
    decs.push({
      range: new monaco.Range(b.sepLine, 1, b.sepLine, 1),
      options: { isWholeLine: true, className: "mep-marker mep-marker-sep" },
    });
    decs.push({
      range: new monaco.Range(b.endLine, 1, b.endLine, 1),
      options: { isWholeLine: true, className: "mep-marker mep-marker-theirs" },
    });
    if (b.sepLine > b.startLine + 1)
      decs.push({
        range: new monaco.Range(b.startLine + 1, 1, b.sepLine - 1, 1),
        options: { isWholeLine: true, className: "mep-side-ours" },
      });
    if (b.endLine > b.sepLine + 1)
      decs.push({
        range: new monaco.Range(b.sepLine + 1, 1, b.endLine - 1, 1),
        options: { isWholeLine: true, className: "mep-side-theirs" },
      });
    decs.push({
      range: new monaco.Range(b.startLine, 1, b.endLine, 1),
      options: {
        isWholeLine: true,
        className: isCurrent ? "mep-block-active" : "mep-block",
        overviewRuler: {
          color: isCurrent ? "rgba(255,165,0,1)" : "rgba(255,120,0,0.7)",
          position: monaco.editor.OverviewRulerLane.Right,
        },
      },
    });
  });
  resultDecColl.set(decs);
}

// ---- Navigation ----
// Scrolls all three panes to the current conflict at once. The syncingScroll
// guard stops the cross-pane scroll sync from yanking the panes back to a
// shared top while we line them up on their own regions.
function revealCurrentConflict() {
  const b = currentConflict.value;
  if (!b) return;
  syncingScroll = true;
  resultEditor?.revealLineInCenter(b.startLine);
  const r = currentRegion();
  if (r) {
    if (r.oursEnd >= r.oursStart) oursEditor?.revealLineInCenter(r.oursStart);
    if (r.theirsEnd >= r.theirsStart) theirsEditor?.revealLineInCenter(r.theirsStart);
  }
  syncingScroll = false;
}

function nextConflict() {
  const n = blocks.value.length;
  if (!n) return;
  currentConflictIdx.value = (currentConflictIdx.value + 1) % n;
  updateDecorations();
  renderSideDecorations();
  revealCurrentConflict();
}

function prevConflict() {
  const n = blocks.value.length;
  if (!n) return;
  currentConflictIdx.value = (currentConflictIdx.value - 1 + n) % n;
  updateDecorations();
  renderSideDecorations();
  revealCurrentConflict();
}

// ---- Accept a side: replace the whole marker block with the chosen content ----
function sideText(b: ConflictBlock, side: "ours" | "theirs" | "both"): string {
  if (side === "ours") return b.oursLines.join("\n");
  if (side === "theirs") return b.theirsLines.join("\n");
  return [...b.oursLines, ...b.theirsLines].join("\n");
}

function replaceBlock(b: ConflictBlock, side: "ours" | "theirs" | "both") {
  const model = resultEditor?.getModel();
  if (!model) return;
  const text = sideText(b, side);
  const lineCount = model.getLineCount();
  let range: monaco.Range;
  let editText: string;
  if (b.endLine < lineCount) {
    // Consume the trailing newline so an empty chosen side removes the lines cleanly.
    range = new monaco.Range(b.startLine, 1, b.endLine + 1, 1);
    editText = text === "" ? "" : text + "\n";
  } else if (text === "" && b.startLine > 1) {
    // Block ends at EOF and the chosen side is empty: also drop the preceding newline.
    range = new monaco.Range(
      b.startLine - 1,
      model.getLineMaxColumn(b.startLine - 1),
      b.endLine,
      model.getLineMaxColumn(b.endLine),
    );
    editText = "";
  } else {
    range = new monaco.Range(b.startLine, 1, b.endLine, model.getLineMaxColumn(b.endLine));
    editText = text;
  }
  model.pushEditOperations([], [{ range, text: editText }], () => null);
  // onDidChangeModelContent → reparse() refreshes blocks / decorations / lenses
}

function applyOurs() {
  if (currentConflict.value) replaceBlock(currentConflict.value, "ours");
}

function applyTheirs() {
  if (currentConflict.value) replaceBlock(currentConflict.value, "theirs");
}

// ---- Apply all non-conflicting changes ----
// Rebuilds the result from the original merge3 chunks, resetting to the initial
// auto-merged state. Non-conflicting ours/theirs changes are re-applied; conflict
// blocks (with markers) are restored. Always works regardless of manual edits.
function applyAllNonConflicting() {
  const model = resultEditor?.getModel();
  if (!model || !allChunksData.length) return;
  const applied = applyNonConflicting(allChunksData);
  const text = buildResultText(applied);
  model.setValue(text);
  initialResultText.value = text;
  currentConflictIdx.value = 0;
  reparse();
  revealCurrentConflict();
}

// ---- Scroll sync ----
let syncingScroll = false;

function syncScrollFrom(source: monaco.editor.IStandaloneCodeEditor) {
  if (syncingScroll) return;
  syncingScroll = true;
  const top = source.getScrollTop();
  for (const ed of [oursEditor, resultEditor, theirsEditor]) {
    if (ed && ed !== source) ed.setScrollTop(top);
  }
  syncingScroll = false;
}

// ---- Editor lifecycle ----
const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: "vs-dark",
  fontSize: 12,
  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
  lineNumbers: "on",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: "off",
  renderWhitespace: "boundary",
  automaticLayout: false,
};

function createEditors() {
  if (!oursContainer.value || !resultContainer.value || !theirsContainer.value) return;
  const lang = language.value;

  oursEditor = monaco.editor.create(oursContainer.value, {
    ...EDITOR_OPTIONS,
    value: oursContent.value,
    language: lang,
    readOnly: true,
  });
  resultEditor = monaco.editor.create(resultContainer.value, {
    ...EDITOR_OPTIONS,
    value: "",
    language: lang,
    readOnly: false,
  });
  theirsEditor = monaco.editor.create(theirsContainer.value, {
    ...EDITOR_OPTIONS,
    value: theirsContent.value,
    language: lang,
    readOnly: true,
  });

  resultDecColl = resultEditor.createDecorationsCollection([]);
  oursDecColl = oursEditor.createDecorationsCollection([]);
  theirsDecColl = theirsEditor.createDecorationsCollection([]);

  // CodeLens "✓ Ours | ✓ Theirs | Both" above each conflict block. The command
  // re-parses on click (buffer may have shifted since the lens was computed) and
  // resolves the block by its <<<<<<< line.
  lensEmitter = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  acceptCommandId =
    resultEditor.addCommand(
      0,
      (_accessor: unknown, startLine: number, side: "ours" | "theirs" | "both") => {
        const model = resultEditor?.getModel();
        if (!model) return;
        const found = parseConflicts(model).blocks.find((b) => b.startLine === startLine);
        if (found) replaceBlock(found, side);
      },
      "",
    ) ?? "";

  const langId = resultEditor.getModel()?.getLanguageId() ?? "plaintext";
  lensProviderObj = {
    onDidChange: lensEmitter.event,
    provideCodeLenses: (model) => {
      // Same language id is shared with the read-only panes — only lens the Result model.
      if (model !== resultEditor?.getModel()) return { lenses: [], dispose: () => {} };
      const lenses: monaco.languages.CodeLens[] = [];
      for (const b of parseConflicts(model).blocks) {
        const range = { startLineNumber: b.startLine, startColumn: 1, endLineNumber: b.startLine, endColumn: 1 };
        lenses.push({
          range,
          command: { id: acceptCommandId, title: `✓ ${oursLabel.value}`, arguments: [b.startLine, "ours"] },
        });
        lenses.push({
          range,
          command: { id: acceptCommandId, title: `✓ ${theirsLabel.value}`, arguments: [b.startLine, "theirs"] },
        });
        lenses.push({ range, command: { id: acceptCommandId, title: "Both", arguments: [b.startLine, "both"] } });
      }
      return { lenses, dispose: () => {} };
    },
  };
  lensProvider = monaco.languages.registerCodeLensProvider(langId, lensProviderObj);

  oursEditor.onDidScrollChange(() => syncScrollFrom(oursEditor!));
  resultEditor.onDidScrollChange(() => syncScrollFrom(resultEditor!));
  theirsEditor.onDidScrollChange(() => syncScrollFrom(theirsEditor!));

  // After each user edit, re-scan the buffer for remaining conflict markers
  resultEditor.onDidChangeModelContent(() => {
    reparse();
  });

  resizeObs = new ResizeObserver(() => layoutEditors());
  if (resultContainer.value.parentElement) {
    resizeObs.observe(resultContainer.value.parentElement);
  }
  layoutEditors();
}

function layoutEditors() {
  for (const ed of [oursEditor, resultEditor, theirsEditor]) {
    if (ed) ed.layout();
  }
}

function disposeEditors() {
  // Tear down the CodeLens provider/emitter (registered globally for the language)
  lensProvider?.dispose();
  lensProvider = null;
  lensProviderObj = null;
  lensEmitter?.dispose();
  lensEmitter = null;
  resultDecColl?.clear();
  oursDecColl?.clear();
  theirsDecColl?.clear();
  blocks.value = [];
  markerCount.value = 0;

  for (const ed of [oursEditor, resultEditor, theirsEditor]) {
    if (ed) {
      ed.getModel()?.dispose();
      ed.dispose();
    }
  }
  oursEditor = null;
  resultEditor = null;
  theirsEditor = null;
  resultDecColl = null;
  oursDecColl = null;
  theirsDecColl = null;
  resizeObs?.disconnect();
  resizeObs = null;
}

// ---- Load conflict detail ----
async function loadDetail() {
  loading.value = true;
  loadError.value = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    const detail = (await api.gitConflictDetail({
      workspaceId: props.workspaceId,
      rootPath: props.rootPath,
      filePath: props.filePath,
    })) as Record<string, unknown>;

    baseContent.value = (detail.base as string) || "";
    oursContent.value = (detail.ours as string) || "";
    theirsContent.value = (detail.theirs as string) || "";

    const { chunks } = merge3(baseContent.value, oursContent.value, theirsContent.value);
    allChunksData = chunks;

    conflictRegions = computeConflictRegions(chunks);
    regionByKey.clear();
    for (const r of conflictRegions) if (!regionByKey.has(r.key)) regionByKey.set(r.key, r);

    const applied = applyNonConflicting(chunks);
    const text = buildResultText(applied);
    initialResultText.value = text;

    loading.value = false;
    await nextTick();
    createEditors();
    resultEditor?.getModel()?.setValue(text);
    currentConflictIdx.value = 0;
    reparse();
    revealCurrentConflict();
  } catch (err) {
    loadError.value = (err as Error)?.message || "Failed to load conflict detail.";
    loading.value = false;
  }
}

// ---- Apply & Cancel ----
async function onApply() {
  if (!resultEditor || markerCount.value > 0) return;
  busy.value = true;
  try {
    const content = resultEditor.getModel()?.getValue() ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = appStore.getApi() as any;
    await api.gitResolveConflict({
      workspaceId: props.workspaceId,
      rootPath: props.rootPath,
      filePath: props.filePath,
      mode: "manual",
      content,
    });
    emit("apply");
  } catch (err) {
    loadError.value = (err as Error)?.message || "Failed to apply resolution.";
  } finally {
    busy.value = false;
  }
}

function isDirty(): boolean {
  const current = resultEditor?.getModel()?.getValue() ?? "";
  return current !== initialResultText.value && current !== "";
}

function onCancel() {
  if (isDirty()) {
    confirmCancel.value = true;
  } else {
    emit("cancel");
  }
}

// Parent (Conflicts tab) checks this before navigating to another file so
// unsaved Result edits aren't silently dropped by a remount.
defineExpose({ isDirty });

// ---- Keyboard shortcuts (Phase 4) ----
// Scoped to focus within one of the editor panes so they never clobber
// global app/browser shortcuts when the merge editor is not in use.
//   F7 / Shift+F7        — next / prev conflict
//   Alt+ArrowLeft        — insert ours (left pane) into the current conflict
//   Alt+ArrowRight       — insert theirs (right pane) into the current conflict
//   Alt+A                — apply all non-conflicting changes
function onKeydown(e: KeyboardEvent) {
  if (
    !resultContainer.value?.contains(document.activeElement) &&
    !oursContainer.value?.contains(document.activeElement) &&
    !theirsContainer.value?.contains(document.activeElement)
  )
    return;
  if (e.key === "F7") {
    e.preventDefault();
    e.shiftKey ? prevConflict() : nextConflict();
  } else if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    applyOurs();
  } else if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    applyTheirs();
  } else if (e.altKey && (e.key === "a" || e.key === "A")) {
    if (!hasNonConflicting.value) return;
    e.preventDefault();
    applyAllNonConflicting();
  }
}

// On layout change, reload from scratch (persisting partial edits across layout
// switches is not worth the complexity; user can re-apply their choices)
watch(isNarrow, async () => {
  disposeEditors();
  await nextTick();
  if (!loading.value) void loadDetail();
});

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
  void loadDetail();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  disposeEditors();
});
</script>

<style scoped>
.mep {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.mep__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.mep__file {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.mep__toolbar-center {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mep__nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mep__nav-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
}

.mep__nav-btn:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.mep__nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mep__nav-count {
  font-size: 11px;
  color: var(--text);
  min-width: 64px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.mep__nav-count--done {
  color: var(--ok, #0b6);
  font-style: italic;
}

/* Narrow (mobile) tabs */
.mep__tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.mep__tab {
  flex: 1;
  padding: 6px 12px;
  font-size: 12px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--muted);
}

.mep__tab--active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* Pane labels row */
.mep__pane-labels {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}

.mep__pane-label {
  padding: 3px 10px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.mep__pane-label:not(:last-child) {
  border-right: 1px solid var(--border);
}

.mep__pane-label--result {
  font-weight: 600;
  color: var(--text);
}

.mep__pane-tag {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--border);
  padding: 1px 5px;
  border-radius: 3px;
}

/* Overlay (loading / error) */
.mep__overlay {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--muted);
  padding: 20px;
}

.mep__overlay--error {
  color: var(--danger, #e44);
}

/* Editors area */
.mep__editors {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.mep__pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.mep__pane:not(:last-child) {
  border-right: 1px solid var(--border);
}

.mep__pane--result {
  flex: 1.2; /* result pane slightly wider */
}

.mep__pane--full {
  flex: 1;
}

.mep__editor-host {
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
}

/* Footer */
.mep__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  gap: 8px;
}

.mep__conflict-count {
  font-size: 12px;
  color: var(--muted);
}

.mep__footer-actions {
  display: flex;
  gap: 8px;
}

/* Dirty-cancel confirm */
.mep-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.mep-confirm {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  min-width: 280px;
  box-shadow: var(--shadow);
}

.mep-confirm p {
  margin: 0 0 12px;
  font-size: 13px;
}

.mep-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

<style>
/* Global styles for Monaco conflict decorations (cannot be scoped).
   Ours side = green tint, Theirs side = blue tint (VS Code convention);
   marker lines are bold; the current block carries an orange left border. */
.mep-marker {
  font-weight: 700 !important;
}

.mep-marker-ours,
.mep-side-ours {
  background: rgba(60, 180, 90, 0.16) !important;
}

.mep-marker-theirs,
.mep-side-theirs {
  background: rgba(64, 140, 255, 0.16) !important;
}

.mep-marker-sep {
  background: rgba(160, 160, 160, 0.18) !important;
}

.mep-block {
  border-left: 3px solid rgba(255, 120, 0, 0.5) !important;
}

.mep-block-active {
  border-left: 3px solid rgba(255, 165, 0, 0.95) !important;
}

/* Read-only ours/theirs panes: show which lines the conflict spans, with the
   current conflict's region emphasized. */
.mep-sidepane-ours {
  background: rgba(60, 180, 90, 0.12) !important;
  border-left: 2px solid rgba(60, 180, 90, 0.45) !important;
}

.mep-sidepane-ours-active {
  background: rgba(60, 180, 90, 0.28) !important;
  border-left: 3px solid rgba(60, 200, 100, 0.95) !important;
}

.mep-sidepane-theirs {
  background: rgba(64, 140, 255, 0.12) !important;
  border-left: 2px solid rgba(64, 140, 255, 0.45) !important;
}

.mep-sidepane-theirs-active {
  background: rgba(64, 140, 255, 0.28) !important;
  border-left: 3px solid rgba(80, 160, 255, 0.95) !important;
}
</style>
