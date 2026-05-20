<template>
  <div class="git-tree" :class="{ 'git-tree--loading': loading }">
    <div v-if="loading && !nodes.length" class="git-tree__placeholder">Loading commit graph…</div>
    <div v-else-if="error" class="git-tree__placeholder git-tree__placeholder--error">{{ error }}</div>
    <div v-else-if="!nodes.length" class="git-tree__placeholder">No commits found.</div>
    <div
      v-else
      ref="scrollRef"
      class="git-tree__scroll"
      role="tree"
      aria-label="Commit graph"
      tabindex="0"
      @keydown="onKeydown"
    >
      <div
        class="git-tree__viewport"
        :style="{
          height: `${nodes.length * ROW_HEIGHT}px`,
          width: `${graphWidth + 600}px`,
        }"
      >
        <!-- SVG paints lanes + edges + dots; rows on top are normal DOM
             so we get text wrapping, hover/tooltip, native click targets,
             and selection styling. Same approach as JetBrains' VCS Log. -->
        <svg
          class="git-tree__svg"
          :width="graphWidth"
          :height="nodes.length * ROW_HEIGHT"
          :viewBox="`0 0 ${graphWidth} ${nodes.length * ROW_HEIGHT}`"
          aria-hidden="true"
        >
          <g v-for="edge in edges" :key="edge.id">
            <path :d="edge.d" :stroke="edge.color" stroke-width="1.6" fill="none" stroke-linecap="round" />
          </g>
          <g v-for="node in nodes" :key="`dot:${node.hash}`">
            <circle
              :cx="laneX(node.lane)"
              :cy="node.y + ROW_HEIGHT / 2"
              :r="node.isHead ? 5 : 4"
              :fill="laneColor(node.lane)"
              :stroke="node.isHead ? '#ffffff' : 'transparent'"
              stroke-width="1.5"
            />
            <circle
              v-if="node.isHead"
              :cx="laneX(node.lane)"
              :cy="node.y + ROW_HEIGHT / 2"
              r="8"
              fill="none"
              :stroke="laneColor(node.lane)"
              stroke-width="1.2"
              opacity="0.55"
            />
          </g>
        </svg>

        <div
          v-for="node in nodes"
          :key="`row:${node.hash}`"
          :class="['git-tree__row', { 'git-tree__row--selected': node.hash === selectedHash }]"
          :style="{ top: `${node.y}px`, height: `${ROW_HEIGHT}px`, paddingLeft: `${graphWidth + 6}px` }"
          role="treeitem"
          :aria-selected="node.hash === selectedHash ? 'true' : 'false'"
          :title="`${node.shortHash} — ${node.subject}\n${node.author} • ${node.relativeDate}`"
          @click="select(node)"
          @dblclick="onDoubleClick(node)"
        >
          <span class="git-tree__cell git-tree__cell--refs">
            <span
              v-for="ref in node.refs"
              :key="ref.label"
              :class="['git-tree__ref', `git-tree__ref--${ref.kind}`]"
              :title="ref.title"
            >
              <span class="git-tree__ref-icon" aria-hidden="true">{{ ref.icon }}</span>
              {{ ref.label }}
            </span>
          </span>
          <span class="git-tree__cell git-tree__cell--subject">{{ node.subject }}</span>
          <span class="git-tree__cell git-tree__cell--author">{{ node.author }}</span>
          <span class="git-tree__cell git-tree__cell--date">{{ node.relativeDate }}</span>
          <span class="git-tree__cell git-tree__cell--hash">{{ node.shortHash }}</span>
        </div>
      </div>
    </div>
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
  }>(),
  { commits: () => [], head: "", refs: () => ({}), selectedHash: "", loading: false, error: "" },
);

const emit = defineEmits<{ (e: "select", hash: string): void; (e: "open", hash: string): void }>();

const ROW_HEIGHT = 26;
const LANE_GAP = 16;
const LANE_START_X = 14;

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
  lane: number;
  y: number;
  isHead: boolean;
  refs: GraphRefBadge[];
}

interface GraphEdge {
  id: string;
  d: string;
  color: string;
}

// --- Graph layout (lane assignment + edge paths) -------------------------
//
// Algorithm (linearized "sand-pile" walk):
//   • Walk commits in input order (already date-ordered).
//   • Maintain a list of "active lanes" — each holding the next hash we
//     expect to see in that lane.
//   • For each commit C with hash h and parents [p1, p2, …]:
//       - Find existing lanes whose tip == h. The leftmost one becomes
//         C's home lane; any others merge into it (draw a converging edge
//         and free those lanes).
//       - If no lane was reserved for h (root commit, or a topo branch we
//         haven't entered yet), claim the leftmost free lane.
//       - Replace the home lane's tip with p1 (first parent — keeps the
//         "main" line straight); for each additional parent open a new
//         lane on its right.
//       - Carry over every other active lane to the next row at the same
//         column (vertical edge segment).
//
// Result: per-row node lane + a list of straight/curved edges for the SVG.
// Worst-case columns ≈ max concurrent open branches.

interface LaneState {
  tip: string; // hash this lane is currently expecting
  color: number; // color index (kept stable across the lane's life)
}

interface LayoutResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
}

function buildLayout(commits: RawCommit[], head: string): LayoutResult {
  if (!commits.length) return { nodes: [], edges: [], width: 60 };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const lanes: (LaneState | null)[] = [];
  let maxLane = 0;
  let nextColor = 0;

  // Reserve colors for known heads so the main branch keeps lane color
  // 0 (amber) even when the first commit we see isn't actually on it.
  // First commit in the list is treated as the most-recent point of the
  // graph, so amber will follow that lane.

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const y = i * ROW_HEIGHT;

    // 1) find existing lanes that resolve to this commit
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
      // close any duplicate lanes — draw their tail into homeLane
      for (let k = 1; k < reservingLanes.length; k++) {
        const closingLane = reservingLanes[k];
        const prevPos = lanes[closingLane]!;
        // edge from closingLane (at row i, top) merging into homeLane bottom
        edges.push({
          id: `m:${commit.hash}:${closingLane}->${homeLane}`,
          d: laneMergePath(closingLane, homeLane, y),
          color: laneColor(prevPos.color),
        });
        lanes[closingLane] = null;
      }
    } else {
      // no reservation — open a new lane to host this commit
      const free = lanes.findIndex((l) => l === null);
      homeLane = free >= 0 ? free : lanes.length;
      // For the very first iteration, force color 0 (head/main alignment).
      if (i === 0 && head && commit.hash === head) {
        homeColor = 0;
        nextColor = Math.max(nextColor, 1);
      } else {
        homeColor = nextColor++;
      }
      if (free >= 0) {
        lanes[free] = { tip: "", color: homeColor };
      } else {
        lanes.push({ tip: "", color: homeColor });
      }
    }

    maxLane = Math.max(maxLane, homeLane);

    // 2) draw the vertical "carry over" edges from every still-active lane
    //    into the next row (we'll close them next iteration if they hit).
    //    Skip homeLane — it will be redirected below to its first parent.

    // 3) replace homeLane.tip with first parent (keeps the line straight)
    //    and open new lanes for additional parents.
    const parents = commit.parents || [];
    const firstParent = parents[0] || "";
    if (firstParent) {
      lanes[homeLane] = { tip: firstParent, color: homeColor };
    } else {
      // root commit — close the lane
      lanes[homeLane] = null;
    }

    for (let p = 1; p < parents.length; p++) {
      const parentHash = parents[p];
      // open a fresh lane to the right of homeLane for this parent
      const free = lanes.findIndex((l) => l === null);
      const newLane = free >= 0 ? free : lanes.length;
      const newColor = nextColor++;
      if (free >= 0) {
        lanes[free] = { tip: parentHash, color: newColor };
      } else {
        lanes.push({ tip: parentHash, color: newColor });
      }
      // edge from commit dot diagonally out to newLane
      edges.push({
        id: `b:${commit.hash}->${parentHash}:${newLane}`,
        d: laneBranchPath(homeLane, newLane, y),
        color: laneColor(newColor),
      });
      maxLane = Math.max(maxLane, newLane);
    }

    // 4) After updating lanes for this row, draw vertical/curved continuation
    //    edges from this row's tops down to the next row's bottom for every
    //    active lane (including homeLane). We don't know yet which ones will
    //    merge in row i+1 — those will draw additional merge segments next
    //    iteration. The straight carry-over still looks correct.
    if (i + 1 < commits.length) {
      const yNext = (i + 1) * ROW_HEIGHT;
      for (let l = 0; l < lanes.length; l++) {
        const lane = lanes[l];
        if (!lane) continue;
        // Don't double-draw the homeLane-first-parent vertical when the
        // parent is the next commit in the list — it produces a cleaner
        // line than two overlapping segments.
        if (l === homeLane) {
          // straight down from commit dot to next row bottom
          edges.push({
            id: `s:${commit.hash}:${l}`,
            d: `M ${laneX(l)} ${y + ROW_HEIGHT / 2} L ${laneX(l)} ${yNext + ROW_HEIGHT / 2}`,
            color: laneColor(lane.color),
          });
        } else {
          // vertical from top of this row through bottom of next
          edges.push({
            id: `v:${commit.hash}:${l}`,
            d: `M ${laneX(l)} ${y} L ${laneX(l)} ${yNext + ROW_HEIGHT / 2}`,
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
      lane: homeLane,
      y,
      isHead: head === commit.hash,
      refs: classifyRefs(commit.refs || []),
    });
  }

  // Trim trailing nulls so width is accurate
  while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
  const widthLanes = Math.max(maxLane + 1, 1);
  return { nodes, edges, width: LANE_START_X + widthLanes * LANE_GAP + 10 };
}

function laneMergePath(fromLane: number, toLane: number, y: number): string {
  // diagonal merge into the dot at (toLane, y + ROW_HEIGHT/2)
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  const yTop = y - ROW_HEIGHT / 2;
  const yMid = y + ROW_HEIGHT / 2;
  const midY = (yTop + yMid) / 2;
  return `M ${x1} ${yTop} C ${x1} ${midY} ${x2} ${midY} ${x2} ${yMid}`;
}

function laneBranchPath(fromLane: number, toLane: number, y: number): string {
  // diagonal branch-out from commit dot to the new lane below
  const x1 = laneX(fromLane);
  const x2 = laneX(toLane);
  const yMid = y + ROW_HEIGHT / 2;
  const yBot = y + ROW_HEIGHT + ROW_HEIGHT / 2;
  const midY = (yMid + yBot) / 2;
  return `M ${x1} ${yMid} C ${x1} ${midY} ${x2} ${midY} ${x2} ${yBot}`;
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
  // Always lead with HEAD so the eye finds the active commit instantly
  out.sort((a, b) => (a.kind === "head" ? -1 : b.kind === "head" ? 1 : 0));
  return out;
}

const layout = computed(() => buildLayout(props.commits || [], props.head || ""));
const nodes = computed(() => layout.value.nodes);
const edges = computed(() => layout.value.edges);
const graphWidth = computed(() => layout.value.width);

const scrollRef = ref<HTMLElement | null>(null);

function select(node: GraphNode) {
  if (props.selectedHash !== node.hash) {
    emit("select", node.hash);
  }
}

function onDoubleClick(node: GraphNode) {
  emit("open", node.hash);
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
  }
}

// Auto-scroll the selected row into view when selection changes from outside.
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
  grid-template-columns: minmax(110px, max-content) minmax(120px, 1fr) minmax(100px, max-content) minmax(70px, max-content) minmax(60px, max-content);
  gap: 10px;
  align-items: center;
  padding-right: 10px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
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
}

.git-tree__cell--subject {
  color: var(--text);
}

.git-tree__cell--author,
.git-tree__cell--date {
  color: var(--muted);
  font-size: 11px;
}

.git-tree__cell--hash {
  color: var(--accent);
  font-family: var(--font-mono, ui-monospace, "SF Mono", monospace);
  font-weight: 600;
}

.git-tree__cell--refs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  overflow-x: hidden;
}

.git-tree__ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  text-transform: none;
  letter-spacing: 0;
  font-weight: 600;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-tree__ref-icon {
  font-size: 10px;
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
