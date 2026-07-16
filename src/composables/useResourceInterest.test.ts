/**
 * Component-level coverage for useResourceInterest — the slim-core detail
 * interest that mounted panes declare, driven through a structure that mirrors
 * the real renderer: a reactive grid (`WorkspaceGridStage`) renders one cell
 * (`WorkspaceCell` → `PaneStage`) per VISIBLE workspace, and each mounted
 * non-terminal pane declares interest via `useResourceInterest`. The visible set
 * is recomputed from the layout: a wide grid shows every cell at once; a narrow
 * / mobile layout collapses to the single focused cell.
 *
 * The tests drive real Vue mount/unmount by mutating the reactive layout (grid
 * enable, cell reassignment, responsive collapse) and assert BOTH the store's
 * ref-counted interest set AND the resulting WS interest set that is actually
 * pushed to the transport (`subscribeResources`) — i.e. what the server ends up
 * subscribing the socket to.
 *
 * useAppStore is mocked to a minimal remote store so the composable's
 * remote-only guard passes without booting the full app store/transport.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, nextTick, reactive, computed } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../stores/app.js", () => ({ useAppStore: () => ({ isRemoteTransport: true }) }));

import { useResourceInterest } from "./useResourceInterest.js";
import { useRemoteDetailsStore } from "../stores/remote-details.js";

/** A single mounted pane. Terminal panes declare NO detail interest; git/docker/
 *  review panes declare the resource key(s) they render — the review pane
 *  declares several at once (its PR detail + review-bridge context + the git
 *  snapshot behind it). Mirrors GitPane/DockerPane/AzureReviewPane. */
type PaneCell = { id: string; wsId: string; pane: "terminal" | "git" | "docker" | "review"; prKey?: string };

function resourceKeysFor(cell: PaneCell): string[] {
  switch (cell.pane) {
    case "git":
      return [`git:${cell.wsId}`];
    case "docker":
      return ["docker"];
    case "review":
      return [`azure-pr:${cell.prKey}`, `review-bridge:${cell.prKey}`, `git:${cell.wsId}`];
    default:
      return []; // terminal pane — no detail interest
  }
}

/** WorkspaceCell → PaneStage: mounts the visible pane and declares its interest. */
const WorkspaceCell = defineComponent({
  props: { cell: { type: Object as () => PaneCell, required: true } },
  setup(props) {
    useResourceInterest(() => resourceKeysFor(props.cell));
    return () => h("div", { class: "cell" });
  },
});

/** WorkspaceGridStage: renders one cell per VISIBLE workspace. The visible set
 *  follows the layout — a wide grid shows all cells, a mobile layout only the
 *  focused one. Keyed by workspace id so a reassignment remounts the cell. */
const GridStage = defineComponent({
  props: { layout: { type: Object as () => GridLayout, required: true } },
  setup(props) {
    const visible = computed(() =>
      props.layout.isMobile ? [props.layout.cells[props.layout.focused]].filter(Boolean) : props.layout.cells,
    );
    return () =>
      h(
        "div",
        { class: "grid" },
        visible.value.map((cell) => h(WorkspaceCell, { key: cell.id, cell })),
      );
  },
});

type GridLayout = { cells: PaneCell[]; isMobile: boolean; focused: number };

describe("useResourceInterest — grid / mobile / responsive interest", () => {
  let pinia: ReturnType<typeof createPinia>;
  let wsInterestSets: string[][];

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    wsInterestSets = [];
    const details = useRemoteDetailsStore();
    details._resetForTest(() => 0);
    // A remote transport whose subscribeResources we capture — this is the WS
    // resource:interest set the server ends up subscribing the socket to.
    details.init({
      isRemote: true,
      subscribeResources: (resources: string[]) => wsInterestSets.push([...resources].sort()),
      onResourceInvalidate: () => {},
      fetchResourceDetail: async () => null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  afterEach(() => {
    useRemoteDetailsStore()._resetForTest();
  });

  const interests = () => [...useRemoteDetailsStore()._interests].sort();
  const lastWsSet = () => wsInterestSets[wsInterestSets.length - 1] ?? [];

  it("a wide grid subscribes every visible cell's detail; collapsing to mobile drops the rest", async () => {
    // Wide 2x2 grid: a git pane, a docker pane, a review pane, and a terminal
    // (which declares NO interest). Two cells' git detail overlaps (ws1).
    const layout = reactive<GridLayout>({
      cells: [
        { id: "c1", wsId: "ws1", pane: "git" },
        { id: "c2", wsId: "ws2", pane: "docker" },
        { id: "c3", wsId: "ws3", pane: "review", prKey: "azure:pr1" },
        { id: "c4", wsId: "ws1", pane: "terminal" },
      ],
      isMobile: false,
      focused: 0,
    });
    const stage = mount(GridStage, { props: { layout }, global: { plugins: [pinia] } });
    await nextTick();

    const wide = ["azure-pr:azure:pr1", "docker", "git:ws1", "git:ws3", "review-bridge:azure:pr1"];
    expect(interests()).toEqual(wide);
    // The WS interest set actually pushed to the transport matches.
    expect(lastWsSet()).toEqual(wide);

    // Responsive collapse to a mobile single focused cell (the git pane on ws1):
    // every other cell unmounts, so their interests drop and the WS set shrinks.
    layout.isMobile = true;
    layout.focused = 0;
    await nextTick();
    expect(interests()).toEqual(["git:ws1"]);
    expect(lastWsSet()).toEqual(["git:ws1"]);

    // Mobile focus moves to the review cell — its three keys become the WS set.
    layout.focused = 2;
    await nextTick();
    expect(interests()).toEqual(["azure-pr:azure:pr1", "git:ws3", "review-bridge:azure:pr1"]);
    expect(lastWsSet()).toEqual(["azure-pr:azure:pr1", "git:ws3", "review-bridge:azure:pr1"]);

    stage.unmount();
    await nextTick();
    expect(interests()).toEqual([]);
    expect(lastWsSet()).toEqual([]);
  });

  it("ref-counts an overlapping resource across cells and follows a cell reassignment", async () => {
    // Two visible cells render the SAME workspace's git detail (a real wide-grid
    // case: a Git pane and a Review pane both backed by ws1).
    const layout = reactive<GridLayout>({
      cells: [
        { id: "c1", wsId: "ws1", pane: "git" },
        { id: "c2", wsId: "ws1", pane: "review", prKey: "azure:pr9" },
      ],
      isMobile: false,
      focused: 0,
    });
    mount(GridStage, { props: { layout }, global: { plugins: [pinia] } });
    await nextTick();
    expect(interests()).toEqual(["azure-pr:azure:pr9", "git:ws1", "review-bridge:azure:pr9"]);

    // Reassign the review cell to a different workspace's PR (grid cell swap):
    // git:ws1 stays interested because the git cell still holds it (ref-count>0).
    layout.cells[1] = { id: "c3", wsId: "ws2", pane: "review", prKey: "azure:pr2" };
    await nextTick();
    expect(interests()).toEqual(["azure-pr:azure:pr2", "git:ws1", "git:ws2", "review-bridge:azure:pr2"]);

    // Now change the git cell to a terminal (no interest) — git:ws1 is only held
    // by the review cell (ws2) now, so it drops.
    layout.cells[0] = { id: "c4", wsId: "ws1", pane: "terminal" };
    await nextTick();
    expect(interests()).toEqual(["azure-pr:azure:pr2", "git:ws2", "review-bridge:azure:pr2"]);
  });
});
