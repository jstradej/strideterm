<template>
  <div class="mdp">
    <div v-if="!hideLabels" class="mdp__labels">
      <div class="mdp__label-pane mdp__label-pane--left">
        <span class="mdp__label-tag">old</span>
        {{ payload?.leftLabel || "" }}
        <span v-if="payload?.leftMissing" class="mdp__label-missing">(does not exist)</span>
      </div>
      <div class="mdp__label-pane mdp__label-pane--right">
        <span class="mdp__label-tag">new</span>
        {{ payload?.rightLabel || "" }}
        <span v-if="payload?.rightMissing" class="mdp__label-missing">(does not exist)</span>
      </div>
    </div>

    <div v-if="!hideToolbar" class="mdp__toolbar">
      <div class="mdp__nav">
        <button
          type="button"
          class="mdp__btn"
          :disabled="!changeCount"
          title="Jump the diff cursor to the previous changed hunk and scroll it into view. Keyboard shortcut: Shift+F7."
          @click="goToChange(-1)"
        >
          ◀
        </button>
        <span class="mdp__nav-counter" :class="{ 'mdp__nav-counter--empty': !changeCount }">
          <template v-if="changeCount">{{ currentChangeIndex + 1 }} / {{ changeCount }}</template>
          <template v-else>no changes</template>
        </span>
        <button
          type="button"
          class="mdp__btn"
          :disabled="!changeCount"
          title="Jump the diff cursor to the next changed hunk and scroll it into view. Keyboard shortcut: F7."
          @click="goToChange(1)"
        >
          ▶
        </button>
      </div>
      <div class="mdp__layout-toggle">
        <button
          type="button"
          :class="['mdp__btn', sideBySide && 'mdp__btn--active']"
          title="Show the diff in two side-by-side panes — old on the left, new on the right. Best for wide screens."
          @click="sideBySide = true"
        >
          Side-by-side
        </button>
        <button
          type="button"
          :class="['mdp__btn', !sideBySide && 'mdp__btn--active']"
          title="Show the diff inline in a single column with red / green markers — better for narrow viewports and easier to read line-by-line."
          @click="sideBySide = false"
        >
          Inline
        </button>
        <button
          v-if="canPopout"
          type="button"
          class="mdp__btn mdp__btn--popout"
          :title="`Pop this diff out into its own window (great for parking on a second monitor): ${popoutTitle}`"
          @click="handlePopout"
        >
          ↗ Pop out
        </button>
      </div>
    </div>

    <div
      v-if="visibleFileAnnotations.length"
      class="mdp__file-annotations"
      aria-label="Comments without a visible line anchor"
    >
      <article
        v-for="annotation in visibleFileAnnotations"
        :key="annotation.id"
        :class="[
          'mdp__review-card',
          'mdp__review-card--file',
          annotation.id === selectedAnnotationId && 'mdp__review-card--selected',
        ]"
      >
        <div class="mdp__review-card-head">
          <strong>{{ annotation.title }}</strong>
          <span class="mdp__review-status">{{
            annotation.fallbackLabel || (annotation.stale ? "Older context" : "No line anchor")
          }}</span>
          <div v-if="annotationActionsEnabled && headerActions(annotation).length" class="mdp__review-actions">
            <button
              v-for="action in headerActions(annotation)"
              :key="action.label"
              type="button"
              :class="['button', 'button--ghost', action.destructive && 'button--danger']"
              :disabled="action.disabled"
              :title="action.title"
              @click="action.run()"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
        <div v-for="(entry, index) in annotation.entries" :key="index" class="mdp__review-entry">
          <div class="mdp__review-entry-head">
            <strong>{{ entry.author || "Unknown author" }}</strong>
            <span v-if="entry.draft" class="mdp__review-status">{{ entry.status || "Draft" }}</span>
          </div>
          <div class="mdp__review-body">{{ entry.body }}</div>
          <div
            v-if="annotationActionsEnabled && entryActions(annotation, entry, index).length"
            class="mdp__review-actions"
          >
            <button
              v-for="action in entryActions(annotation, entry, index)"
              :key="action.label"
              type="button"
              :class="['button', 'button--ghost', action.destructive && 'button--danger']"
              :disabled="action.disabled"
              :title="action.title"
              @click="action.run()"
            >
              {{ action.label }}
            </button>
          </div>
        </div>
      </article>
    </div>

    <div ref="bodyRef" class="mdp__body">
      <div v-if="loading" class="mdp__overlay">Loading diff…</div>
      <div v-else-if="errorMessage" class="mdp__overlay mdp__overlay--error">{{ errorMessage }}</div>
      <div v-else-if="!payload" class="mdp__overlay mdp__overlay--muted">No diff selected</div>
      <div
        ref="containerRef"
        class="mdp__monaco"
        :class="{
          'mdp__monaco--hidden': loading,
          'mdp__monaco--review-interactive': hasInteractiveReviewAnnotations,
          'mdp__monaco--allow-inline-comments': allowInlineComments,
        }"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import "../../app/monaco-setup.js";
import * as monaco from "monaco-editor";

const emit = defineEmits<{
  "request-comment": [location: { line: number; side: "old" | "new" }];
}>();

interface DiffPayload {
  leftLabel?: string;
  rightLabel?: string;
  leftMissing?: boolean;
  rightMissing?: boolean;
  leftContent?: string;
  rightContent?: string;
  language?: string;
  ok?: boolean;
  leftError?: string;
}

interface Props {
  payload?: DiffPayload | null;
  loading?: boolean;
  hideLabels?: boolean;
  hideToolbar?: boolean;
  // When set, the toolbar shows a "Pop out" button that opens this diff in
  // a separate Electron window. The string becomes the window title and
  // the popout's headline (e.g. "src/foo.ts @ 1a2b3c4"). No button shown
  // when blank or when the Electron popout bridge isn't reachable
  // (remote / web clients).
  popoutTitle?: string;
  targetLine?: number;
  targetSide?: "old" | "new";
  targetStale?: boolean;
  lineAnnotations?: InlineReviewAnnotation[];
  fileAnnotations?: InlineReviewAnnotation[];
  selectedAnnotationId?: string;
  annotationActionsEnabled?: boolean;
  allowInlineComments?: boolean;
}

interface InlineReviewAnnotation {
  id: string;
  line: number | null;
  side: "old" | "new";
  title: string;
  stale?: boolean;
  fallbackLabel?: string;
  actions?: InlineReviewAction[];
  entries: Array<{ author: string; body: string; draft?: boolean; status?: string; actions?: InlineReviewAction[] }>;
}

interface InlineReviewAction {
  label: string;
  title: string;
  disabled?: boolean;
  placement?: "entry";
  destructive?: boolean;
  run: () => void | Promise<void>;
}

function headerActions(annotation: InlineReviewAnnotation) {
  return annotation.actions?.filter((action) => action.placement !== "entry") || [];
}

function entryActions(
  annotation: InlineReviewAnnotation,
  entry: InlineReviewAnnotation["entries"][number],
  index: number,
) {
  const parentActions = index === 0 ? annotation.actions?.filter((action) => action.placement === "entry") || [] : [];
  return [...(entry.actions || []), ...parentActions];
}

const props = withDefaults(defineProps<Props>(), {
  payload: null,
  loading: false,
  hideLabels: false,
  hideToolbar: false,
  popoutTitle: "",
  targetLine: -1,
  targetSide: "new",
  targetStale: false,
  lineAnnotations: () => [],
  fileAnnotations: () => [],
  selectedAnnotationId: "",
  annotationActionsEnabled: false,
  allowInlineComments: false,
});

// Electron exposes `window.strideterm.openDiffPopout` via preload. In remote
// web clients the bridge is undefined and the button stays hidden.
const canPopout = computed(() => {
  if (!props.popoutTitle) return false;
  if (!props.payload) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge = (typeof window !== "undefined" ? (window as any).strideterm : null) as {
    openDiffPopout?: (p: unknown) => Promise<unknown>;
  } | null;
  return typeof bridge?.openDiffPopout === "function";
});

async function handlePopout() {
  if (!canPopout.value) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge = (window as any).strideterm as { openDiffPopout: (p: unknown) => Promise<unknown> };
  try {
    await bridge.openDiffPopout({
      title: props.popoutTitle,
      filePath: props.popoutTitle,
      ...(props.payload as Record<string, unknown>),
    });
  } catch {
    // Popout is a best-effort UX feature — if the IPC fails the host UI
    // still has the diff visible.
  }
}

function revealTargetLine() {
  const line = Number(props.targetLine);
  if (!diffEditor || props.targetStale || !Number.isInteger(line) || line < 0) return;
  const editor = props.targetSide === "old" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
  if (!sideBySide.value && props.targetSide === "old") {
    sideBySide.value = true;
    return;
  }
  const model = editor.getModel();
  if (!model) return;
  // Never redirect an old comment to an unrelated line at EOF when its
  // stored location no longer fits the current file.
  if (line > model.getLineCount()) return;
  if (line === 0) {
    editor.revealLine(1);
  } else {
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }
  editor.focus();
}

const containerRef = ref<HTMLDivElement | null>(null);
const bodyRef = ref<HTMLDivElement | null>(null);
const sideBySide = ref(true);
const visibleFileAnnotations = computed(() => [
  ...props.fileAnnotations,
  ...(!sideBySide.value
    ? props.lineAnnotations
        .filter((annotation) => annotation.side === "old")
        .map((annotation) => ({
          ...annotation,
          title: `${annotation.title} · original line ${annotation.line}`,
          fallbackLabel: `Original side · line ${annotation.line}`,
        }))
    : []),
]);
const hasInteractiveReviewAnnotations = computed(
  () =>
    props.annotationActionsEnabled &&
    props.lineAnnotations.some(
      (annotation) => annotation.actions?.length || annotation.entries.some((entry) => entry.actions?.length),
    ),
);
const changes = ref<monaco.editor.ILineChange[]>([]);
const currentChangeIndex = ref(-1);
const changeCount = computed(() => changes.value.length);
const errorMessage = computed(() => {
  const p = props.payload;
  if (!p) return "";
  if (p.ok === false && p.leftError) return p.leftError;
  return "";
});

let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
let resizeObserver: ResizeObserver | null = null;
let updateDiffDisposable: monaco.IDisposable | null = null;
const inlineCommentDisposables: monaco.IDisposable[] = [];
const inlineCommentContextKeys: monaco.editor.IContextKey<boolean>[] = [];
const contextMenuLines: Record<"old" | "new", number> = { old: 0, new: 0 };
let keyListener: ((event: KeyboardEvent) => void) | null = null;
type LiveReviewZone = {
  editor: monaco.editor.IStandaloneCodeEditor;
  id: string;
  zone: monaco.editor.IViewZone;
  host: HTMLElement;
  card: HTMLElement;
  observer: ResizeObserver | null;
  frame: number | null;
};
const reviewZones: LiveReviewZone[] = [];

function clearReviewZones() {
  const editors = new Set(reviewZones.map((zone) => zone.editor));
  for (const editor of editors) {
    const ids = reviewZones.filter((zone) => zone.editor === editor).map((zone) => zone.id);
    editor.changeViewZones((accessor) => ids.forEach((id) => accessor.removeZone(id)));
  }
  for (const zone of reviewZones) {
    zone.observer?.disconnect();
    if (zone.frame != null) cancelAnimationFrame(zone.frame);
  }
  reviewZones.length = 0;
}

function makeReviewZone(annotation: InlineReviewAnnotation): { host: HTMLElement; card: HTMLElement } {
  const host = document.createElement("div");
  host.className = "mdp__review-zone-host";
  const card = document.createElement("section");
  card.className = `mdp__review-card mdp__review-card--zone${annotation.line === 0 ? " mdp__review-card--line-zero" : ""}${annotation.id === props.selectedAnnotationId ? " mdp__review-card--selected" : ""}`;
  card.setAttribute("aria-label", annotation.title);

  const header = document.createElement("div");
  header.className = "mdp__review-card-head";
  const title = document.createElement("strong");
  title.textContent = annotation.title;
  header.append(title);
  if (props.annotationActionsEnabled) appendReviewActions(header, headerActions(annotation));
  card.append(header);

  for (const entry of annotation.entries) {
    const row = document.createElement("article");
    row.className = "mdp__review-entry";
    const meta = document.createElement("div");
    meta.className = "mdp__review-entry-head";
    const author = document.createElement("strong");
    author.textContent = entry.author || "Unknown author";
    meta.append(author);
    if (entry.draft) {
      const status = document.createElement("span");
      status.className = "mdp__review-status";
      status.textContent = entry.status || "Draft";
      meta.append(status);
    }
    const body = document.createElement("div");
    body.className = "mdp__review-body";
    body.textContent = entry.body;
    row.append(meta, body);
    if (props.annotationActionsEnabled)
      appendReviewActions(row, entryActions(annotation, entry, card.childElementCount - 1));
    card.append(row);
  }
  host.append(card);
  return { host, card };
}

function appendReviewActions(container: HTMLElement, actions?: InlineReviewAction[]) {
  if (!actions?.length) return;
  const group = document.createElement("div");
  group.className = "mdp__review-actions";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `button button--ghost${action.destructive ? " button--danger" : ""}`;
    button.textContent = action.label;
    button.title = action.title;
    button.disabled = !!action.disabled;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void action.run();
    });
    group.append(button);
  }
  container.append(group);
}

function measureReviewZone(zone: LiveReviewZone) {
  if (!reviewZones.includes(zone)) return;
  const styles = getComputedStyle(zone.host);
  const hostPadding = Number.parseFloat(styles.paddingTop || "0") + Number.parseFloat(styles.paddingBottom || "0");
  const measured = Math.ceil(Math.max(zone.card.scrollHeight, zone.card.getBoundingClientRect().height) + hostPadding);
  const previous = Number(zone.zone.heightInPx || 0);
  if (!measured || Math.abs(measured - previous) < 2) return;
  zone.zone.heightInPx = measured;
  zone.editor.changeViewZones((accessor) => accessor.layoutZone(zone.id));
}

function renderReviewZones() {
  if (!diffEditor) return;
  clearReviewZones();
  for (const annotation of props.lineAnnotations) {
    if (!sideBySide.value && annotation.side === "old") continue;
    if (annotation.line == null || !Number.isInteger(annotation.line) || annotation.line < 0) continue;
    const editor = annotation.side === "old" ? diffEditor.getOriginalEditor() : diffEditor.getModifiedEditor();
    const model = editor.getModel();
    if (!model || annotation.line > model.getLineCount()) continue;
    const rendered = makeReviewZone(annotation);
    const line = annotation.line;
    const zone: monaco.editor.IViewZone = {
      afterLineNumber: line,
      heightInPx: 48,
      suppressMouseDown: false,
      domNode: rendered.host,
    };
    editor.changeViewZones((accessor) => {
      const id = accessor.addZone(zone);
      const liveZone: LiveReviewZone = {
        editor,
        id,
        zone,
        host: rendered.host,
        card: rendered.card,
        observer: null,
        frame: null,
      };
      if (typeof ResizeObserver !== "undefined") {
        liveZone.observer = new ResizeObserver(() => measureReviewZone(liveZone));
        liveZone.observer.observe(rendered.card);
      }
      liveZone.frame = requestAnimationFrame(() => {
        liveZone.frame = null;
        measureReviewZone(liveZone);
      });
      reviewZones.push(liveZone);
    });
  }
}

function ensureEditor() {
  if (!containerRef.value || diffEditor) return;
  diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
    theme: "vs-dark",
    readOnly: true,
    renderSideBySide: sideBySide.value,
    enableSplitViewResizing: true,
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    fontSize: 12,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
    scrollBeyondLastLine: false,
    renderOverviewRuler: true,
    diffWordWrap: "off",
    wordWrap: "off",
    renderWhitespace: "boundary",
    ignoreTrimWhitespace: false,
    diffAlgorithm: "advanced",
  });
  resizeObserver = new ResizeObserver(() => layoutEditor());
  if (bodyRef.value) resizeObserver.observe(bodyRef.value);
  layoutEditor();
  updateDiffDisposable = diffEditor.onDidUpdateDiff(() => refreshChangeList());
  installInlineCommentActions();
}

function installInlineCommentActions() {
  if (!diffEditor || !props.allowInlineComments || inlineCommentDisposables.length) return;
  for (const [side, editor] of [
    ["old", diffEditor.getOriginalEditor()],
    ["new", diffEditor.getModifiedEditor()],
  ] as const) {
    const available = editor.createContextKey("reviewCanAddInlineComment", false);
    inlineCommentContextKeys.push(available);
    const contextMenuDisposable = editor.onContextMenu((event) => {
      contextMenuLines[side] = event.target.position?.lineNumber || 0;
    });
    inlineCommentDisposables.push(
      contextMenuDisposable,
      editor.addAction({
        id: `review.addDraftComment.${side}`,
        label: "Add draft comment",
        precondition: "reviewCanAddInlineComment",
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => {
          const line = contextMenuLines[side];
          if (!available.get() || !Number.isInteger(line) || line < 1) return;
          emit("request-comment", { line, side });
        },
      }),
    );
  }
  updateInlineCommentActionAvailability();
}

function updateInlineCommentActionAvailability() {
  const canAdd = !!diffEditor?.getModel() && !!props.allowInlineComments && !props.loading && !!props.payload;
  inlineCommentContextKeys.forEach((key) => key.set(canAdd));
}

watch(() => [props.allowInlineComments, props.loading, props.payload] as const, updateInlineCommentActionAvailability);

function layoutEditor() {
  if (!diffEditor || !bodyRef.value) return;
  const rect = bodyRef.value.getBoundingClientRect();
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w <= 0 || h <= 0) return;
  diffEditor.layout({ width: w, height: h });
}

function applyDiffModels() {
  if (!diffEditor) return;
  clearReviewZones();
  const payload = props.payload;
  if (!payload || (payload.ok === false && !payload.leftContent && !payload.rightContent)) {
    const previous = diffEditor.getModel();
    diffEditor.setModel(null);
    if (previous?.original) previous.original.dispose();
    if (previous?.modified) previous.modified.dispose();
    changes.value = [];
    currentChangeIndex.value = -1;
    renderReviewZones();
    updateInlineCommentActionAvailability();
    return;
  }
  const oldModel = monaco.editor.createModel(payload.leftContent || "", payload.language || "plaintext");
  const newModel = monaco.editor.createModel(payload.rightContent || "", payload.language || "plaintext");
  const previous = diffEditor.getModel();
  diffEditor.setModel({ original: oldModel, modified: newModel });
  if (previous?.original) previous.original.dispose();
  if (previous?.modified) previous.modified.dispose();
  renderReviewZones();
  updateInlineCommentActionAvailability();
  if (inlineCommentDisposables.length === 0) installInlineCommentActions();
}

function refreshChangeList() {
  if (!diffEditor) {
    changes.value = [];
    currentChangeIndex.value = -1;
    return;
  }
  const list = diffEditor.getLineChanges() || [];
  changes.value = list;
  currentChangeIndex.value = list.length ? 0 : -1;
}

function goToChange(direction: number) {
  if (!diffEditor || !changes.value.length) return;
  const total = changes.value.length;
  const next = (currentChangeIndex.value + direction + total) % total;
  currentChangeIndex.value = next;
  const change = changes.value[next];
  const targetLine =
    change.modifiedStartLineNumber > 0 ? change.modifiedStartLineNumber : change.originalStartLineNumber;
  const modifiedEditor = diffEditor.getModifiedEditor();
  modifiedEditor.revealLineInCenter(targetLine);
  modifiedEditor.setPosition({ lineNumber: targetLine, column: 1 });
}

watch(sideBySide, (value) => {
  if (diffEditor) diffEditor.updateOptions({ renderSideBySide: value });
  layoutEditor();
  renderReviewZones();
  if (value) nextTick(revealTargetLine);
});

watch(
  () => props.payload,
  () => {
    nextTick(() => {
      ensureEditor();
      applyDiffModels();
      layoutEditor();
      revealTargetLine();
    });
  },
);

watch(
  () => [props.targetLine, props.targetSide, props.payload, props.loading] as const,
  async () => {
    if (props.targetLine < 0 || props.loading || !props.payload) return;
    await nextTick();
    revealTargetLine();
  },
  { flush: "post" },
);

watch(
  () => [props.lineAnnotations, props.selectedAnnotationId, props.payload] as const,
  () => nextTick(renderReviewZones),
  { deep: true, flush: "post" },
);

onMounted(() => {
  nextTick(() => {
    ensureEditor();
    applyDiffModels();
    layoutEditor();
    revealTargetLine();
  });
  keyListener = (event) => {
    if (event.key !== "F7") return;
    // Only react if our editor element is in the focused subtree.
    const active = document.activeElement;
    if (!active || !bodyRef.value || !bodyRef.value.contains(active)) return;
    event.preventDefault();
    goToChange(event.shiftKey ? -1 : 1);
  };
  document.addEventListener("keydown", keyListener);
});

onBeforeUnmount(() => {
  if (keyListener) document.removeEventListener("keydown", keyListener);
  keyListener = null;
  for (const disposable of inlineCommentDisposables.splice(0)) disposable.dispose();
  inlineCommentContextKeys.splice(0);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (updateDiffDisposable) {
    updateDiffDisposable.dispose();
    updateDiffDisposable = null;
  }
  if (diffEditor) {
    clearReviewZones();
    const model = diffEditor.getModel();
    diffEditor.setModel(null);
    if (model?.original) model.original.dispose();
    if (model?.modified) model.modified.dispose();
    diffEditor.dispose();
    diffEditor = null;
  }
});

defineExpose({ goToChange });
</script>

<style scoped>
.mdp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.mdp__labels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  font-size: 11px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.mdp__label-pane {
  padding: 4px 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
}

.mdp__label-pane--left {
  border-right: 1px solid var(--border);
}

.mdp__label-tag {
  background: var(--border);
  color: var(--text);
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.mdp__label-missing {
  color: var(--fm-status-conflict, #e26b6b);
  font-weight: 600;
}

.mdp__toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  flex-shrink: 0;
}

.mdp__nav,
.mdp__layout-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mdp__layout-toggle {
  margin-left: auto;
}

.mdp__nav-counter {
  font-size: 11px;
  color: var(--text);
  min-width: 56px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.mdp__nav-counter--empty {
  color: var(--muted);
  font-style: italic;
}

.mdp__btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.mdp__btn:hover:not(:disabled) {
  background: var(--border);
  color: var(--text);
}

.mdp__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.mdp__btn--active {
  background: rgba(255, 164, 36, 0.15);
  color: var(--accent);
  border-color: var(--accent);
}

/* Popout is an "action" button, not a layout-mode toggle — separated with a
   small margin and styled with a subtle accent border so it reads as a
   distinct affordance. */
.mdp__btn--popout {
  margin-left: 8px;
  border-color: rgba(127, 188, 236, 0.35);
  color: #9ecdf3;
}
.mdp__btn--popout:hover:not(:disabled) {
  background: rgba(127, 188, 236, 0.12);
  border-color: rgba(127, 188, 236, 0.6);
}

.mdp__body {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.mdp__monaco {
  width: 100%;
  height: 100%;
}

.mdp__monaco--hidden {
  visibility: hidden;
}

.mdp__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 13px;
  z-index: 1;
  pointer-events: none;
  background: var(--panel);
}

.mdp__overlay--error {
  color: var(--fm-status-conflict, #e26b6b);
}

.mdp__overlay--muted {
  background: transparent;
  font-style: italic;
}
</style>
