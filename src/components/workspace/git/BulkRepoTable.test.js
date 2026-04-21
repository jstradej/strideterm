import { describe, expect, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import BulkRepoTable from "./BulkRepoTable.vue";

const snapshots = [
  { rootPath: "/repo/a", branch: "main", aheadCount: 0, behindCount: 1, dirty: false, available: true, dirtyCount: 0 },
  {
    rootPath: "/repo/b",
    branch: "feature",
    aheadCount: 2,
    behindCount: 0,
    dirty: true,
    available: true,
    dirtyCount: 3,
  },
];

function mountTable(props = {}) {
  return mount(BulkRepoTable, {
    props: {
      workspaceId: "ws-test",
      rootsSnapshots: snapshots,
      ...props,
    },
  });
}

describe("BulkRepoTable", () => {
  test("renders repository name (basename) and branch for each row", () => {
    const wrapper = mountTable();
    const rows = wrapper.findAll("tbody tr");
    // Two data rows (no empty-row fallback since snapshots is non-empty)
    expect(rows).toHaveLength(2);

    // First row: /repo/a → basename "a", branch "main"
    expect(rows[0].find(".bulk-repo-table__repo").text()).toBe("a");
    expect(rows[0].find(".bulk-repo-table__branch").text()).toBe("main");

    // Second row: /repo/b → basename "b", branch "feature"
    expect(rows[1].find(".bulk-repo-table__repo").text()).toBe("b");
    expect(rows[1].find(".bulk-repo-table__branch").text()).toBe("feature");
  });

  test("Pull all button is disabled when any repo is dirty", () => {
    const wrapper = mountTable();
    const pullAllBtn = wrapper.findAll(".bulk-btn")[1]; // second toolbar button = "Pull all"
    expect(pullAllBtn.attributes("disabled")).toBeDefined();
  });

  test("Pull all button is enabled when no repo is dirty", () => {
    const cleanSnapshots = snapshots.map((s) => ({ ...s, dirty: false }));
    const wrapper = mountTable({ rootsSnapshots: cleanSnapshots });
    const pullAllBtn = wrapper.findAll(".bulk-btn")[1];
    expect(pullAllBtn.attributes("disabled")).toBeUndefined();
  });

  test("per-row pull button is disabled when that row is dirty", () => {
    const wrapper = mountTable();
    const rows = wrapper.findAll("tbody tr");
    // Second row (/repo/b) is dirty — its pull row-btn is the second .row-btn
    const dirtyRowBtns = rows[1].findAll(".row-btn");
    // Buttons: Refresh (index 0), Pull (index 1), Reveal (index 2)
    const pullBtn = dirtyRowBtns[1];
    expect(pullBtn.attributes("disabled")).toBeDefined();
  });

  test("per-row pull button is enabled when that row is clean", () => {
    const wrapper = mountTable();
    const rows = wrapper.findAll("tbody tr");
    // First row (/repo/a) is clean
    const cleanRowBtns = rows[0].findAll(".row-btn");
    const pullBtn = cleanRowBtns[1];
    expect(pullBtn.attributes("disabled")).toBeUndefined();
  });

  test("emits fetch-all event when Fetch all button is clicked and no onFetchAll prop", async () => {
    const wrapper = mountTable({ onFetchAll: null });
    const fetchAllBtn = wrapper.findAll(".bulk-btn")[0];
    await fetchAllBtn.trigger("click");
    expect(wrapper.emitted("fetch-all")).toBeTruthy();
    expect(wrapper.emitted("fetch-all")).toHaveLength(1);
  });

  test("calls onFetchAll prop instead of emitting when provided", async () => {
    const onFetchAll = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountTable({ onFetchAll });
    const fetchAllBtn = wrapper.findAll(".bulk-btn")[0];
    await fetchAllBtn.trigger("click");
    expect(onFetchAll).toHaveBeenCalledTimes(1);
    // No event emitted when prop is used
    expect(wrapper.emitted("fetch-all")).toBeFalsy();
  });

  test("calls onPullRoot callback with the correct rootPath when per-row pull is clicked", async () => {
    const onPullRoot = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountTable({ onPullRoot });
    const rows = wrapper.findAll("tbody tr");
    // Click pull on the first (clean) row
    const pullBtn = rows[0].findAll(".row-btn")[1];
    await pullBtn.trigger("click");
    expect(onPullRoot).toHaveBeenCalledWith("/repo/a");
  });

  test("shows .row-result--ok indicator after per-row pull action completes", async () => {
    const onPullRoot = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountTable({ onPullRoot });
    const rows = wrapper.findAll("tbody tr");
    // Pull on the first (clean) row
    const pullBtn = rows[0].findAll(".row-btn")[1];
    await pullBtn.trigger("click");
    // Await the async action + Vue DOM update
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(rows[0].find(".row-result--ok").exists()).toBe(true);
  });

  test("shows .row-result--error indicator when per-row pull action throws", async () => {
    const onPullRoot = vi.fn().mockRejectedValue(new Error("pull failed"));
    const wrapper = mountTable({ onPullRoot });
    const rows = wrapper.findAll("tbody tr");
    const pullBtn = rows[0].findAll(".row-btn")[1];
    await pullBtn.trigger("click");
    await wrapper.vm.$nextTick();
    await new Promise((r) => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(rows[0].find(".row-result--error").exists()).toBe(true);
  });

  test("shows empty-row message when rootsSnapshots is empty", () => {
    const wrapper = mountTable({ rootsSnapshots: [] });
    expect(wrapper.find(".bulk-repo-table__empty").exists()).toBe(true);
    expect(wrapper.find(".bulk-repo-table__empty").text()).toBe("No repositories");
  });
});
