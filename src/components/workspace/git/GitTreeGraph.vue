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
              <path :d="edge.d" :stroke="edge.color" :stroke-width="EDGE_WIDTH" fill="none" stroke-linecap="round" />
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
              <circle
                :cx="laneX(node.lane)"
                :cy="node.y + ROW_HEIGHT / 2"
                :r="node.isMerge ? DOT_RADIUS - 0.5 : DOT_RADIUS"
                :fill="node.isMerge ? 'var(--surface, #1d2026)' : laneColor(node.lane)"
                :stroke="laneColor(node.lane)"
                stroke-width="1.6"
              />
            </g>
          </svg>

          <div
            v-for="node in nodes"
            :key="`row:${node.hash}`"
            :class="['git-tree__row', { 'git-tree__row--selected': node.hash === selectedHash }]"
            :style="{
              top: `${node.y}px`,
              height: `${ROW_HEIGHT}px`,
              paddingLeft: `${graphWidth + 4}px`,
              borderLeftColor: node.hash === selectedHash ? laneColor(node.lane) : 'transparent',
            }"
            role="treeitem"
            :aria-selected="node.hash === selectedHash ? 'true' : 'false'"
            :title="rowTooltip(node)"
            @click="select(node)"
            @dblclick="onDoubleClick(node)"
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
    loading?: boolean;
    error?: string;
    compact?: boolean;
  }>(),
  {
    commits: () => [],
    head: "",
    refs: () => ({}),
    selectedHash: "",
    loading: false,
    error: "",
    compact: false,
  },
);

const emit = defineEmits<{ (e: "select", hash: string): void; (e: "open", hash: string): void }>();

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
function buildLayout(commits: RawCommit[], head: string): LayoutResult {
  if (!commits.length) return { nodes: [], edges: [], width: 40 };

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
        // Curve from the lane's position one row up down into the dot.
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
      maxLane = Math.max(maxLane, newLane);
    }

    if (i + 1 < commits.length) {
      const yNext = (i + 1) * ROW_HEIGHT;
      const yMid = y + ROW_HEIGHT / 2;
      const yMidNext = yNext + ROW_HEIGHT / 2;
      for (let l = 0; l < lanes.length; l++) {
        const lane = lanes[l];
        if (!lane) continue;
        if (l === homeLane) {
          // straight line from THIS dot to next row's vertical center
          edges.push({
            id: `s:${commit.hash}:${l}`,
            d: `M ${laneX(l)} ${yMid} L ${laneX(l)} ${yMidNext}`,
            color: laneColor(lane.color),
          });
        } else {
          // vertical from top of this row to mid of next (line passes
          // *through* this row without a dot — that's by design, this
          // lane is just passing by)
          edges.push({
            id: `v:${commit.hash}:${l}`,
            d: `M ${laneX(l)} ${y} L ${laneX(l)} ${yMidNext}`,
            color: laneColor(lane.color),
          });
        }
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

function laneMergePath(fromLane: number, toLane: number, y: number): string {
  // Curve coming in from a previously-active lane (drawn one row above)
  // into the dot of the current row.
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  const yTop = y - ROW_HEIGHT / 2;
  const yMid = y + ROW_HEIGHT / 2;
  const cY1 = yTop + (yMid - yTop) * 0.55;
  const cY2 = yTop + (yMid - yTop) * 0.45;
  return `M ${x1} ${yTop} C ${x1} ${cY1} ${x2} ${cY2} ${x2} ${yMid}`;
}

function laneBranchPath(fromLane: number, toLane: number, y: number): string {
  // Branch-out from current dot to a new lane on the row below.
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  const yMid = y + ROW_HEIGHT / 2;
  const yBot = y + ROW_HEIGHT + ROW_HEIGHT / 2;
  const cY1 = yMid + (yBot - yMid) * 0.45;
  const cY2 = yMid + (yBot - yMid) * 0.55;
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

const layout = computed(() => buildLayout(props.commits || [], props.head || ""));
const nodes = computed(() => layout.value.nodes);
const edges = computed(() => layout.value.edges);
const graphWidth = computed(() => layout.value.width);

const scrollRef = ref<HTMLElement | null>(null);

function rowTooltip(node: GraphNode): string {
  return `${node.shortHash} — ${node.subject}\n${node.author} • ${node.relativeDate}${
    node.refs.length ? `\n${node.refs.map((r) => r.label).join(", ")}` : ""
  }`;
}

function select(node: GraphNode) {
  if (props.selectedHash !== node.hash) emit("select", node.hash);
}

function onDoubleClick(node: GraphNode) {
  emit("open", node.hash);
}

function copyHash(hash: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  navigator.clipboard.writeText(hash).catch(() => {
    // best-effort, no toast — clipboard rejection is harmless here
  });
}

function onKeydown(event: KeyboardEvent) {
  if (!nodes.value.length) return;
  const cur = nodes.value.findIndex((n) => n.hash === props.selectedHash);
  if (event.key === "ArrowDown" || event.key === "j") {
    event.preventDefault();
    const next = nodes.value[Math.min(nodes.value.length - 1, cur < 0 ? 0 : cur + 1)];
    if (next) emit("select", next.hash);
  } else if (event.key === "ArrowUp" || event.key === "k") {
    event.preventDefault();
    const next = nodes.value[Math.max(0, cur < 0 ? 0 : cur - 1)];
    if (next) emit("select", next.hash);
  } else if (event.key === "Enter") {
    if (cur >= 0) emit("open", nodes.value[cur].hash);
  } else if (event.key === "Home") {
    event.preventDefault();
    emit("select", nodes.value[0].hash);
  } else if (event.key === "End") {
    event.preventDefault();
    emit("select", nodes.value[nodes.value.length - 1].hash);
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
  grid-template-columns: var(--graph-col, 60px) minmax(160px, 1fr) minmax(80px, max-content) minmax(
      60px,
      max-content
    ) minmax(50px, max-content);
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
