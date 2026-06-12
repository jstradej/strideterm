<template>
  <div class="git-tree" :class="{ 'git-tree--loading': loading, 'git-tree--compact': compact }">
    <div v-if="loading && !nodes.length" class="git-tree__placeholder">Loading commit graph…</div>
    <div v-else-if="error" class="git-tree__placeholder git-tree__placeholder--error">{{ error }}</div>
    <div v-else-if="!nodes.length" class="git-tree__placeholder">No commits found.</div>
    <template v-else>
      <!-- Column header. Hidden in compact (mobile) mode where there's only one
           text column anyway. Sticky so it stays visible during long scrolls. -->
      <div v-if="!compact" class="git-tree__header">
        <span class="git-tree__hcell git-tree__hcell--graph" :style="{ width: `${graphWidth}px` }"></span>
        <span class="git-tree__hcell git-tree__hcell--subject">Subject</span>
        <span class="git-tree__hcell git-tree__hcell--author">Author</span>
        <span class="git-tree__hcell git-tree__hcell--date">Date</span>
        <span class="git-tree__hcell git-tree__hcell--hash">Hash</span>
      </div>
      <div
        ref="scrollRef"
        class="git-tree__scroll"
        role="tree"
        aria-label="Commit graph"
        tabindex="0"
        @keydown="onKeydown"
      >
        <!-- The viewport holds the row container; the SVG is absolutely
             positioned over the leftmost column so lines align with each
             row's vertical center. -->
        <div class="git-tree__viewport" :style="{ minHeight: `${nodes.length * ROW_HEIGHT}px` }">
          <!--
            SVG paints lanes + edges + dots; rows on top are normal DOM
            so we get text wrapping, hover/tooltip, native click targets,
            and selection styling. Same approach as JetBrains' VCS Log.

            Off-the-shelf options evaluated and rejected:
              - @gitgraph/js / @gitgraph/react: renders synthetic in-memory
                history only (no `git log` input), no Vue binding, no
                virtualization. Wrong shape for our IPC-driven data.
              - vue-git-graph / git-graph-vue: unmaintained (last release
                3+ years ago), no TS types, no keyboard nav, would still
                force us to write the lane algorithm.
              - gitgraph.js (1.x): deprecated by upstream in favor of
                @gitgraph/* family above.
            Our SVG renderer is type-safe, virtualization-ready, matches
            our theme tokens, and ships zero new dependencies.
          -->
          <svg
            class="git-tree__svg"
            :width="graphWidth"
            :height="nodes.length * ROW_HEIGHT"
            :viewBox="`0 0 ${graphWidth} ${nodes.length * ROW_HEIGHT}`"
            aria-hidden="true"
          >
            <g v-for="edge in edges" :key="edge.id">
              <path
                :d="edge.d"
                :stroke="edge.color"
                :stroke-width="EDGE_WIDTH"
                fill="none"
                stroke-linecap="round"
                :stroke-dasharray="edge.dashed ? '3 3' : undefined"
                :opacity="edge.dashed ? 0.55 : 1"
              />
            </g>
            <g v-for="node in nodes" :key="`dot:${node.hash}`">
              <circle
                v-if="node.isHead"
                :cx="laneX(node.lane)"
                :cy="node.y + ROW_HEIGHT / 2"
                :r="DOT_RADIUS + 4"
                fill="none"
                :stroke="laneColor(node.lane)"
                stroke-width="1.2"
                opacity="0.55"
              />
              <!-- Filled dot for every commit, merge or not. Earlier draft
                   used a hollow ring for merges, which stacks into a column
                   of donuts when many merges live next to each other (very
                   common with feature-branch workflows). JetBrains' VCS Log
                   also uses identical filled dots — topology conveys merge,
                   not the dot's interior. -->
              <circle
                :cx="laneX(node.lane)"
                :cy="node.y + ROW_HEIGHT / 2"
                :r="DOT_RADIUS"
                :fill="laneColor(node.lane)"
                :stroke="laneColor(node.lane)"
                stroke-width="1"
              />
            </g>
          </svg>

          <div
            v-for="node in nodes"
            :key="`row:${node.hash}`"
            :class="['git-tree__row', { 'git-tree__row--selected': isSelected(node.hash) }]"
            :style="{
              top: `${node.y}px`,
              height: `${ROW_HEIGHT}px`,
              paddingLeft: `${graphWidth + 4}px`,
              borderLeftColor: node.hash === selectedHash ? laneColor(node.lane) : 'transparent',
            }"
            role="treeitem"
            :aria-selected="isSelected(node.hash) ? 'true' : 'false'"
            :title="rowTooltip(node)"
            @click="select(node, $event)"
            @dblclick="onDoubleClick(node)"
            @contextmenu="onContextMenu($event, node)"
          >
            <span class="git-tree__cell git-tree__cell--subject">
              <span
                v-for="ref in node.refs"
                :key="ref.label"
                :class="['git-tree__ref', `git-tree__ref--${ref.kind}`]"
                :title="ref.title"
              >
                <span class="git-tree__ref-icon" aria-hidden="true">{{ ref.icon }}</span>
                <span class="git-tree__ref-label">{{ ref.label }}</span>
              </span>
              <span class="git-tree__subject" :class="{ 'git-tree__subject--merge': node.isMerge }">{{
                node.subject
              }}</span>
            </span>
            <span v-if="!compact" class="git-tree__cell git-tree__cell--author">{{ node.author }}</span>
            <span v-if="!compact" class="git-tree__cell git-tree__cell--date" :title="node.isoDate">{{
              node.relativeDate
            }}</span>
            <span
              v-if="!compact"
              class="git-tree__cell git-tree__cell--hash"
              :title="`Click to copy ${node.hash}`"
              @click.stop="copyHash(node.hash)"
              >{{ node.shortHash }}</span
            >
            <span
              v-if="compact"
              class="git-tree__cell git-tree__cell--mobile-meta"
              :title="`${node.author} • ${node.isoDate}`"
              >{{ node.relativeDate }}</span
            >
          </div>
        </div>
      </div>
    </template>
    <div v-if="loading && nodes.length" class="git-tree__refresh-overlay" aria-hidden="true">refreshing…</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

interface RawCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  relativeDate: string;
  isoDate: string;
  refs: string[];
}

const props = withDefaults(
  defineProps<{
    commits?: RawCommit[];
    head?: string;
    refs?: Record<string, string>;
    selectedHash?: string;
    // Multi-selection (Ctrl/Shift+click) owned by the parent. When non-empty
    // it drives row highlighting; `selectedHash` stays the primary commit
    // that feeds the diff pane.
    selectedHashes?: string[];
    loading?: boolean;
    error?: string;
    compact?: boolean;
    // Render everything in a single column with straight verticals. Used when
    // an author / path filter has been applied — the parent chain is broken
    // by the filter so the topological lane layout would be misleading. This
    // mirrors what JetBrains' Log shows under User filter.
    flat?: boolean;
  }>(),
  {
    commits: () => [],
    head: "",
    refs: () => ({}),
    selectedHash: "",
    selectedHashes: () => [],
    loading: false,
    error: "",
    compact: false,
    flat: false,
  },
);

const emit = defineEmits<{
  (e: "select", hash: string, mods: { ctrl: boolean; shift: boolean }): void;
  (e: "open", hash: string): void;
  (e: "contextmenu", payload: { hash: string; x: number; y: number }): void;
}>();

// Layout constants — tightened (vs the earlier draft) to match JetBrains'
// VCS Log row density. ROW_HEIGHT=22 fits ~26 rows in a 600px viewport
// without feeling cramped; LANE_GAP=14 keeps multi-branch graphs readable.
const ROW_HEIGHT = 22;
const LANE_GAP = 14;
const LANE_START_X = 12;
const DOT_RADIUS = 4.2;
const EDGE_WIDTH = 1.7;

// Branch lane colors — picked for high contrast against both light and dark
// backgrounds. Cycled by index, just like IDEA / Wappler / gitkraken.
const LANE_COLORS = [
  "#e8a838", // amber (HEAD-ish)
  "#5fb3f8", // sky
  "#6cc070", // green
  "#e07b8e", // pink
  "#b48ce0", // lavender
  "#f0b54a", // mustard
  "#7ec3c3", // teal
  "#d99a6c", // copper
  "#9ec569", // lime
  "#c08bd0", // plum
  "#5cbcb0", // sea
  "#e6a86d", // peach
];

function laneColor(lane: number): string {
  return LANE_COLORS[((lane % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
}
function laneX(lane: number): number {
  return LANE_START_X + lane * LANE_GAP;
}

interface GraphRefBadge {
  label: string;
  kind: "head" | "branch" | "remote" | "tag";
  icon: string;
  title: string;
}

interface GraphNode {
  hash: string;
  shortHash: string;
  parents: string[];
  subject: string;
  author: string;
  relativeDate: string;
  isoDate: string;
  lane: number;
  y: number;
  isHead: boolean;
  isMerge: boolean;
  refs: GraphRefBadge[];
}

interface GraphEdge {
  id: string;
  d: string;
  color: string;
  // Dashed signals "this segment crosses commits hidden by the active filter"
  // — used only in flat mode where the parent chain is interrupted.
  dashed?: boolean;
}

interface LaneState {
  tip: string;
  color: number;
}

interface LayoutResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
}

// Build lane assignment + edge paths.
//
// We walk commits in date order (newest first). Each "active lane" remembers
// the hash it is currently expecting. For commit C:
//   1. find lanes whose tip == C.hash — leftmost becomes C's home lane.
//      Other matching lanes merge into it (one curve drawn per merger).
//   2. if no lane was waiting for C, claim the leftmost free lane.
//   3. replace home lane's tip with C's first parent (keeps the line
//      straight); for each additional parent, open a new lane on the
//      right and draw a branch-out curve.
//   4. continue every other still-active lane straight to the next row.
//
// Width = (max active lane + 1) × LANE_GAP + padding.
function buildLayout(commits: RawCommit[], head: string, flat: boolean): LayoutResult {
  if (!commits.length) return { nodes: [], edges: [], width: 40 };

  // Filtered view (User / Path) breaks the parent chain — lanes derived from
  // partial history would scatter into orphan verticals (see image #17). In
  // flat mode we render every commit on lane 0 with a single connecting line,
  // matching JetBrains' Log under filter (image #18). On top of the plain
  // column we add two topology hints so the result is more than a flat list:
  //   - chain-break segments render dashed (parent of Ci isn't Ci+1 → some
  //     filtered-out commits sit between them in the real graph)
  //   - merge commits get a small right-side stub indicating a secondary
  //     parent that lives off-canvas (analogous to the partial fragments
  //     JetBrains paints under a User filter — image #20)
  if (flat) {
    const nodes: GraphNode[] = commits.map((commit, i) => ({
      hash: commit.hash,
      shortHash: commit.shortHash,
      parents: commit.parents || [],
      subject: commit.subject,
      author: commit.author,
      relativeDate: commit.relativeDate,
      isoDate: commit.isoDate,
      lane: 0,
      y: i * ROW_HEIGHT,
      isHead: head === commit.hash,
      isMerge: (commit.parents || []).length >= 2,
      refs: classifyRefs(commit.refs || []),
    }));
    const edges: GraphEdge[] = [];
    const lane0X = laneX(0);
    const stubX = lane0X + LANE_GAP * 0.9; // tail end of the merge-stub arc
    for (let i = 0; i < commits.length; i++) {
      const yMid = i * ROW_HEIGHT + ROW_HEIGHT / 2;
      // Merge-parent stub: a tiny arc emerging from the dot to the right,
      // signalling that this commit has another parent we can't show because
      // it was dropped by the filter. Only rendered for merge commits.
      if ((commits[i].parents || []).length >= 2) {
        const stubY = yMid - ROW_HEIGHT * 0.35;
        edges.push({
          id: `flat-merge:${commits[i].hash}`,
          d: `M ${lane0X} ${yMid} C ${lane0X} ${stubY} ${stubX} ${stubY} ${stubX} ${stubY - 2}`,
          color: laneColor(1),
        });
      }
      if (i + 1 >= commits.length) continue;
      const yMidNext = (i + 1) * ROW_HEIGHT + ROW_HEIGHT / 2;
      const chainIntact = (commits[i].parents || []).includes(commits[i + 1].hash);
      edges.push({
        id: `flat:${commits[i].hash}->${commits[i + 1].hash}`,
        d: `M ${lane0X} ${yMid} L ${lane0X} ${yMidNext}`,
        color: laneColor(0),
        dashed: !chainIntact,
      });
    }
    return { nodes, edges, width: LANE_START_X + LANE_GAP * 2 };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const lanes: (LaneState | null)[] = [];
  let maxLane = 0;
  let nextColor = 0;

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const y = i * ROW_HEIGHT;

    const reservingLanes: number[] = [];
    for (let l = 0; l < lanes.length; l++) {
      const lane = lanes[l];
      if (lane && lane.tip === commit.hash) reservingLanes.push(l);
    }

    let homeLane: number;
    let homeColor: number;
    if (reservingLanes.length) {
      homeLane = reservingLanes[0];
      homeColor = lanes[homeLane]!.color;
      for (let k = 1; k < reservingLanes.length; k++) {
        const closingLane = reservingLanes[k];
        const closingColor = lanes[closingLane]!.color;
        // Curve from the closing lane's mid-of-previous-row down into the
        // current commit's dot. The straight pass-through above this point
        // is owned by the *previous* row's outgoing edges (see below).
        edges.push({
          id: `m:${commit.hash}:${closingLane}->${homeLane}`,
          d: laneMergePath(closingLane, homeLane, y),
          color: laneColor(closingColor),
        });
        lanes[closingLane] = null;
      }
    } else {
      const free = lanes.findIndex((l) => l === null);
      homeLane = free >= 0 ? free : lanes.length;
      if (i === 0 && head && commit.hash === head) {
        homeColor = 0;
        nextColor = Math.max(nextColor, 1);
      } else {
        homeColor = nextColor++;
      }
      if (free >= 0) lanes[free] = { tip: "", color: homeColor };
      else lanes.push({ tip: "", color: homeColor });
    }

    maxLane = Math.max(maxLane, homeLane);

    const parents = commit.parents || [];
    const firstParent = parents[0] || "";
    if (firstParent) lanes[homeLane] = { tip: firstParent, color: homeColor };
    else lanes[homeLane] = null;

    // Track lanes opened by this iteration's branch-out curves so the
    // inter-row pass-through doesn't double-draw their segment.
    const newlyOpened = new Set<number>();

    for (let p = 1; p < parents.length; p++) {
      const parentHash = parents[p];
      const free = lanes.findIndex((l) => l === null);
      const newLane = free >= 0 ? free : lanes.length;
      const newColor = nextColor++;
      if (free >= 0) lanes[free] = { tip: parentHash, color: newColor };
      else lanes.push({ tip: parentHash, color: newColor });
      edges.push({
        id: `b:${commit.hash}->${parentHash}:${newLane}`,
        d: laneBranchPath(homeLane, newLane, y),
        color: laneColor(newColor),
      });
      newlyOpened.add(newLane);
      maxLane = Math.max(maxLane, newLane);
    }

    // Per-interval pass-through edges from THIS row's mid to NEXT row's mid.
    // Each row interval (i mid → i+1 mid) gets exactly one segment per lane.
    // We skip:
    //   - newlyOpened lanes — the branch curve already owns this interval
    //   - "futureClosers": lanes that will be merge-curve sources at i+1
    //     (any lane reserving the next hash except the future home; that
    //     includes the CURRENT home lane when multiple lanes reserve)
    // Without futureClosers handling, the straight pass-through and the next
    // row's merge curve both paint the same interval → the visible "ghost
    // verticals" you see next to short-lived feature branches.
    if (i + 1 < commits.length) {
      const yNext = (i + 1) * ROW_HEIGHT;
      const yMid = y + ROW_HEIGHT / 2;
      const yMidNext = yNext + ROW_HEIGHT / 2;
      const nextHash = commits[i + 1].hash;
      let futureHome = -1;
      const futureClosers = new Set<number>();
      for (let l = 0; l < lanes.length; l++) {
        if (lanes[l]?.tip === nextHash) {
          if (futureHome < 0) futureHome = l;
          else futureClosers.add(l);
        }
      }
      for (let l = 0; l < lanes.length; l++) {
        const lane = lanes[l];
        if (!lane) continue;
        if (newlyOpened.has(l)) continue;
        if (futureClosers.has(l)) continue;
        edges.push({
          id: `s:${commit.hash}:${l}`,
          d: `M ${laneX(l)} ${yMid} L ${laneX(l)} ${yMidNext}`,
          color: laneColor(lane.color),
        });
      }
    }

    nodes.push({
      hash: commit.hash,
      shortHash: commit.shortHash,
      parents: commit.parents || [],
      subject: commit.subject,
      author: commit.author,
      relativeDate: commit.relativeDate,
      isoDate: commit.isoDate,
      lane: homeLane,
      y,
      isHead: head === commit.hash,
      isMerge: (commit.parents || []).length >= 2,
      refs: classifyRefs(commit.refs || []),
    });
  }

  while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  const widthLanes = Math.max(maxLane + 1, 1);
  return { nodes, edges, width: LANE_START_X + widthLanes * LANE_GAP + 6 };
}

// Control-point offset (fraction of the interval). 0.5 is a true smooth S
// with a horizontal midsection — too "bouncy" at our row height. Tighter
// values (0.3–0.4) produce a near-diagonal that matches JetBrains' style.
const CURVE_TIGHTEN = 0.38;

function laneMergePath(fromLane: number, toLane: number, y: number): string {
  // Curve from the closing lane's mid-of-previous-row into the current
  // commit's dot. Tight control points keep the line close to a diagonal
  // while preserving vertical tangents at both endpoints.
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  const yTop = y - ROW_HEIGHT / 2;
  const yMid = y + ROW_HEIGHT / 2;
  const span = yMid - yTop;
  const cY1 = yTop + span * CURVE_TIGHTEN;
  const cY2 = yMid - span * CURVE_TIGHTEN;
  return `M ${x1} ${yTop} C ${x1} ${cY1} ${x2} ${cY2} ${x2} ${yMid}`;
}

function laneBranchPath(fromLane: number, toLane: number, y: number): string {
  // Branch-out from current dot to the new lane's dot on the row below.
  // Symmetric to laneMergePath.
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  const yMid = y + ROW_HEIGHT / 2;
  const yBot = y + ROW_HEIGHT + ROW_HEIGHT / 2;
  const span = yBot - yMid;
  const cY1 = yMid + span * CURVE_TIGHTEN;
  const cY2 = yBot - span * CURVE_TIGHTEN;
  return `M ${x1} ${yMid} C ${x1} ${cY1} ${x2} ${cY2} ${x2} ${yBot}`;
}

function classifyRefs(refs: string[]): GraphRefBadge[] {
  const out: GraphRefBadge[] = [];
  for (const ref of refs) {
    if (ref === "HEAD") {
      out.push({ label: "HEAD", kind: "head", icon: "★", title: "Currently checked-out commit." });
    } else if (ref.startsWith("tag:")) {
      const name = ref.slice(4);
      out.push({ label: name, kind: "tag", icon: "🏷", title: `Tag ${name}` });
    } else if (ref.includes("/")) {
      out.push({ label: ref, kind: "remote", icon: "☁", title: `Remote-tracking ref ${ref}` });
    } else {
      out.push({ label: ref, kind: "branch", icon: "⎇", title: `Local branch ${ref}` });
    }
  }
  out.sort((a, b) => (a.kind === "head" ? -1 : b.kind === "head" ? 1 : 0));
  return out;
}

const layout = computed(() => buildLayout(props.commits || [], props.head || "", !!props.flat));
const nodes = computed(() => layout.value.nodes);
const edges = computed(() => layout.value.edges);
const graphWidth = computed(() => layout.value.width);

const scrollRef = ref<HTMLElement | null>(null);

function rowTooltip(node: GraphNode): string {
  return `${node.shortHash} — ${node.subject}\n${node.author} • ${node.relativeDate}${
    node.refs.length ? `\n${node.refs.map((r) => r.label).join(", ")}` : ""
  }`;
}

const selectedSet = computed(() => {
  if (props.selectedHashes?.length) return new Set(props.selectedHashes);
  return new Set(props.selectedHash ? [props.selectedHash] : []);
});

function isSelected(hash: string): boolean {
  return selectedSet.value.has(hash);
}

function select(node: GraphNode, event?: MouseEvent) {
  const mods = { ctrl: !!(event?.ctrlKey || event?.metaKey), shift: !!event?.shiftKey };
  if (!mods.ctrl && !mods.shift && props.selectedHash === node.hash && selectedSet.value.size <= 1) return;
  emit("select", node.hash, mods);
}

function onDoubleClick(node: GraphNode) {
  emit("open", node.hash);
}

function onContextMenu(event: MouseEvent, node: GraphNode) {
  event.preventDefault();
  // Select the commit under the cursor so the menu's actions clearly target
  // the right row — unless it's already part of the current (multi-)selection,
  // which the menu should act on as a whole.
  if (!selectedSet.value.has(node.hash)) emit("select", node.hash, { ctrl: false, shift: false });
  emit("contextmenu", { hash: node.hash, x: event.clientX, y: event.clientY });
}

function copyHash(hash: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  navigator.clipboard.writeText(hash).catch(() => {
    // best-effort, no toast — clipboard rejection is harmless here
  });
}

function onKeydown(event: KeyboardEvent) {
  if (!nodes.value.length) return;
  const noMods = { ctrl: false, shift: false };
  const cur = nodes.value.findIndex((n) => n.hash === props.selectedHash);
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    const next = nodes.value[Math.min(nodes.value.length - 1, cur < 0 ? 0 : cur + 1)];
    if (next) emit("select", next.hash, noMods);
  } else if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    const next = nodes.value[Math.max(0, cur < 0 ? 0 : cur - 1)];
    if (next) emit("select", next.hash, noMods);
  } else if (event.key === "Enter") {
    if (cur >= 0) emit("open", nodes.value[cur].hash);
  } else if (event.key === "Home") {
    event.preventDefault();
    emit("select", nodes.value[0].hash, noMods);
  } else if (event.key === "End") {
    event.preventDefault();
    emit("select", nodes.value[nodes.value.length - 1].hash, noMods);
  }
}

watch(
  () => props.selectedHash,
  (hash) => {
    if (!hash || !scrollRef.value) return;
    const idx = nodes.value.findIndex((n) => n.hash === hash);
    if (idx < 0) return;
    const top = idx * ROW_HEIGHT;
    const el = scrollRef.value;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - ROW_HEIGHT * 3), behavior: "smooth" });
    }
  },
);
</script>

<style scoped>
.git-tree {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface, rgba(0, 0, 0, 0.15));
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
}

.git-tree__header {
  display: grid;
  grid-template-columns:
    var(--graph-col, 60px) minmax(160px, 1fr) minmax(80px, max-content) minmax(60px, max-content)
    minmax(50px, max-content);
  gap: 10px;
  padding: 4px 10px 4px 4px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 600;
  flex: 0 0 auto;
}

.git-tree--compact .git-tree__header {
  display: none;
}

.git-tree__hcell--graph {
  /* spacer — actual width set inline so it matches the SVG */
  display: inline-block;
}

.git-tree__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
  outline: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.git-tree__scroll:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.git-tree__viewport {
  position: relative;
  min-width: 100%;
}

.git-tree__svg {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.git-tree__row {
  position: absolute;
  left: 0;
  right: 0;
  display: grid;
  grid-template-columns: minmax(200px, 1fr) minmax(80px, max-content) minmax(60px, max-content) minmax(
      50px,
      max-content
    );
  gap: 10px;
  align-items: center;
  padding-right: 10px;
  cursor: pointer;
  user-select: none; /* Shift+click extends the selection — don't highlight text */
  white-space: nowrap;
  border-left: 2px solid transparent;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.git-tree--compact .git-tree__row {
  grid-template-columns: 1fr minmax(60px, max-content);
}

.git-tree__row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.git-tree__row--selected {
  background: rgba(255, 164, 36, 0.12);
}

.git-tree__cell {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.git-tree__cell--subject {
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
}

.git-tree__subject {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-tree__subject--merge {
  color: var(--muted);
  font-style: italic;
}

.git-tree__cell--author,
.git-tree__cell--date,
.git-tree__cell--mobile-meta {
  color: var(--muted);
  font-size: 11px;
}

.git-tree__cell--hash {
  color: var(--accent);
  font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
  font-weight: 600;
  cursor: copy;
}

.git-tree__cell--hash:hover {
  text-decoration: underline;
}

.git-tree__ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  font-weight: 600;
  max-width: 180px;
  flex: 0 0 auto;
  line-height: 1.4;
}

.git-tree__ref-icon {
  font-size: 9px;
  flex: 0 0 auto;
}

.git-tree__ref-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-tree__ref--head {
  background: rgba(255, 164, 36, 0.22);
  color: var(--accent);
}

.git-tree__ref--branch {
  background: rgba(76, 175, 80, 0.18);
  color: #6dc070;
}

.git-tree__ref--remote {
  background: rgba(76, 110, 175, 0.18);
  color: #80a8e0;
}

.git-tree__ref--tag {
  background: rgba(170, 95, 200, 0.22);
  color: #d09fd9;
}

.git-tree__placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-style: italic;
  font-size: 12px;
  padding: 16px;
  text-align: center;
}

.git-tree__placeholder--error {
  color: #e07b8e;
}

.git-tree__refresh-overlay {
  position: absolute;
  bottom: 6px;
  right: 10px;
  font-size: 10px;
  color: var(--muted);
  background: rgba(0, 0, 0, 0.4);
  padding: 2px 6px;
  border-radius: 3px;
  pointer-events: none;
}
</style>
