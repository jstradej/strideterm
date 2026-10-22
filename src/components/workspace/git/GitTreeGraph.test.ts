import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import GitTreeGraph from "./GitTreeGraph.vue";
import Spinner from "../../common/Spinner.vue";

/**
 * Linear commit chain with a single merge:
 *
 *   A ── B ── C ── D    (main)
 *         \
 *          E            (feature, merged into C)
 *
 * Topology: D → C → (B, E) ; E → B ; B → A.
 */
const linearCommits = [
  {
    hash: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    shortHash: "DDDDDDD",
    parents: ["CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"],
    subject: "tip on main",
    author: "Alice",
    relativeDate: "5 minutes ago",
    isoDate: "2026-05-20T10:00:00Z",
    refs: ["HEAD", "main"],
  },
  {
    hash: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    shortHash: "CCCCCCC",
    parents: ["BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"],
    subject: "merge feature into main",
    author: "Alice",
    relativeDate: "1 hour ago",
    isoDate: "2026-05-20T09:00:00Z",
    refs: [],
  },
  {
    hash: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    shortHash: "EEEEEEE",
    parents: ["BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
    subject: "feature work",
    author: "Bob",
    relativeDate: "2 hours ago",
    isoDate: "2026-05-20T08:00:00Z",
    refs: ["feature"],
  },
  {
    hash: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    shortHash: "BBBBBBB",
    parents: ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    subject: "second commit",
    author: "Alice",
    relativeDate: "3 hours ago",
    isoDate: "2026-05-20T07:00:00Z",
    refs: [],
  },
  {
    hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    shortHash: "AAAAAAA",
    parents: [],
    subject: "initial commit",
    author: "Alice",
    relativeDate: "1 day ago",
    isoDate: "2026-05-19T10:00:00Z",
    refs: ["origin/main", "tag:v0.1"],
  },
];

function mountGraph(props: Record<string, unknown> = {}) {
  return mount(GitTreeGraph, {
    props: {
      commits: linearCommits,
      head: linearCommits[0].hash,
      selectedHash: "",
      ...props,
    },
  });
}

describe("GitTreeGraph", () => {
  test("shows a spinner placeholder while the first graph loads", () => {
    const wrapper = mountGraph({ commits: [], loading: true });
    const placeholder = wrapper.get(".git-tree__placeholder");
    expect(placeholder.findComponent(Spinner).exists()).toBe(true);
    expect(placeholder.text()).toContain("Loading commit graph…");
  });

  test("renders one row per commit", () => {
    const wrapper = mountGraph();
    const rows = wrapper.findAll(".git-tree__row");
    expect(rows.length).toBe(linearCommits.length);
  });

  test("first row carries HEAD / main badges in the refs column", () => {
    const wrapper = mountGraph();
    const firstRow = wrapper.find(".git-tree__row");
    expect(firstRow.html()).toContain("HEAD");
    expect(firstRow.html()).toContain("main");
  });

  test("renders refs in a separate column before the aligned subject column", () => {
    const wrapper = mountGraph();
    const headers = wrapper.findAll(".git-tree__header .git-tree__hcell");
    expect(headers.map((header) => header.text())).toEqual(["", "Refs", "Subject", "Author", "Date", "Hash"]);

    const firstRow = wrapper.find(".git-tree__row");
    expect(firstRow.find(".git-tree__cell--refs").text()).toContain("HEAD");
    expect(firstRow.find(".git-tree__cell--subject").text()).toContain("tip on main");
    expect(firstRow.findAll(".git-tree__cell").map((cell) => cell.classes())).toEqual([
      ["git-tree__cell", "git-tree__cell--refs"],
      ["git-tree__cell", "git-tree__cell--subject"],
      ["git-tree__cell", "git-tree__cell--author"],
      ["git-tree__cell", "git-tree__cell--date"],
      ["git-tree__cell", "git-tree__cell--hash"],
    ]);
  });

  test("merge commit row gets the --merge subject styling", () => {
    const wrapper = mountGraph();
    const mergeSubject = wrapper.findAll(".git-tree__subject--merge");
    // Exactly one of the 5 commits has 2+ parents (commit C).
    expect(mergeSubject.length).toBe(1);
    expect(mergeSubject[0].text()).toContain("merge feature into main");
  });

  test("tag ref gets the tag pill kind", () => {
    const wrapper = mountGraph();
    const tagBadges = wrapper.findAll(".git-tree__ref--tag");
    expect(tagBadges.length).toBe(1);
    expect(tagBadges[0].text()).toContain("v0.1");
  });

  test("renders the column header on desktop, hides it in compact mode", () => {
    const desktop = mountGraph();
    expect(desktop.findAll(".git-tree__header").length).toBe(1);
    const mobile = mountGraph({ compact: true });
    // CSS hides header in compact mode; the DOM element is still emitted
    // but a quick presence check would be ambiguous. Instead check that
    // hash/author columns aren't rendered per row (compact strips them).
    expect(mobile.findAll(".git-tree__cell--hash").length).toBe(0);
    expect(mobile.findAll(".git-tree__cell--author").length).toBe(0);
  });

  test("clicking a row emits select with its full hash and no modifiers", async () => {
    const wrapper = mountGraph();
    const rows = wrapper.findAll(".git-tree__row");
    await rows[2].trigger("click"); // commit E
    const emitted = wrapper.emitted("select");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([linearCommits[2].hash, { ctrl: false, shift: false }]);
  });

  test("Ctrl/Shift+click emit their modifier flags", async () => {
    const wrapper = mountGraph();
    const rows = wrapper.findAll(".git-tree__row");
    await rows[1].trigger("click", { ctrlKey: true });
    await rows[3].trigger("click", { shiftKey: true });
    const emitted = wrapper.emitted("select");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([linearCommits[1].hash, { ctrl: true, shift: false }]);
    expect(emitted![1]).toEqual([linearCommits[3].hash, { ctrl: false, shift: true }]);
  });

  test("selectedHashes highlights every commit in the multi-selection", () => {
    const wrapper = mountGraph({
      selectedHash: linearCommits[0].hash,
      selectedHashes: [linearCommits[0].hash, linearCommits[1].hash],
    });
    const selected = wrapper.findAll(".git-tree__row--selected");
    expect(selected.length).toBe(2);
  });

  test("right-click inside the multi-selection keeps the selection intact", async () => {
    const wrapper = mountGraph({
      selectedHash: linearCommits[0].hash,
      selectedHashes: [linearCommits[0].hash, linearCommits[1].hash],
    });
    const rows = wrapper.findAll(".git-tree__row");
    await rows[1].trigger("contextmenu");
    // No re-select: the menu should act on the whole selection.
    expect(wrapper.emitted("select")).toBeFalsy();
    expect(wrapper.emitted("contextmenu")).toBeTruthy();
  });

  test("double-click emits open", async () => {
    const wrapper = mountGraph();
    const rows = wrapper.findAll(".git-tree__row");
    await rows[0].trigger("dblclick");
    const emitted = wrapper.emitted("open");
    expect(emitted).toBeTruthy();
    expect(emitted![0]).toEqual([linearCommits[0].hash]);
  });

  test("empty commit list renders the No-commits placeholder", () => {
    const wrapper = mountGraph({ commits: [] });
    expect(wrapper.text()).toContain("No commits");
  });

  test("error string renders in the error placeholder", () => {
    const wrapper = mountGraph({ commits: [], error: "boom" });
    const ph = wrapper.find(".git-tree__placeholder--error");
    expect(ph.exists()).toBe(true);
    expect(ph.text()).toContain("boom");
  });

  test("legacy rows keep the header and a separate refs cell", () => {
    const wrapper = mountGraph({ history: false });
    expect(wrapper.classes()).not.toContain("git-tree--history");
    expect(wrapper.find(".git-tree__header").exists()).toBe(true);
    expect(wrapper.find(".git-tree__row .git-tree__cell--refs").exists()).toBe(true);
    expect(wrapper.find(".git-tree__cell--subject .git-tree__ref").exists()).toBe(false);
  });

  test("history rows drop the header and put refs inside the subject cell", () => {
    const refs = ["HEAD", "main", "origin/pveselka/MSP-90906", "tag:v1"];
    const wrapper = mountGraph({
      history: true,
      commits: [{ ...linearCommits[0], refs }],
    });
    expect(wrapper.classes()).toContain("git-tree--history");
    expect(wrapper.find(".git-tree__header").exists()).toBe(false);
    expect(wrapper.find(".git-tree__cell--refs").exists()).toBe(false);
    const chips = wrapper.findAll(".git-tree__cell--subject .git-tree__ref");
    expect(chips).toHaveLength(3);
    expect(chips[2].text()).toBe("+2");
    expect(chips[2].attributes("title")).toBe("origin/pveselka/MSP-90906\nv1");
    expect(chips[0].find(".git-tree__ref-label").text()).toBe("HEAD");

    const full = mountGraph({
      history: true,
      commits: [{ ...linearCommits[0], refs: ["origin/pveselka/MSP-90906"] }],
    });
    const chip = full.find(".git-tree__cell--subject .git-tree__ref");
    expect(chip.find(".git-tree__ref-label").text()).toBe("origin/pveselka/MSP-90906");
    expect(chip.attributes("title")).toBe("Remote-tracking ref origin/pveselka/MSP-90906");
  });

  describe("history markers", () => {
    const mk = (n: number, parents: string[], refs: string[] = []) => ({
      hash: `h${n}`,
      shortHash: `h${n}`,
      parents,
      subject: `commit ${n}`,
      author: "Alice",
      relativeDate: "today",
      isoDate: "2026-05-19T10:00:00Z",
      refs,
    });
    const chain = (refs: Record<number, string[]> = {}) => [
      mk(1, ["h2"], refs[1]),
      mk(2, ["h3"], refs[2]),
      mk(3, ["h4"], refs[3] ?? ["origin/feature"]),
      mk(4, ["h5"], refs[4]),
      mk(5, [], refs[5]),
    ];
    const rowsOf = (w: ReturnType<typeof mountGraph>) => w.findAll(".git-tree__row");

    test("local-only commits get hollow dots and the first pushed row gets the boundary", () => {
      const w = mountGraph({ history: true, commits: chain(), head: "h1" });
      const rows = rowsOf(w);
      expect(rows.map((r) => r.classes().includes("git-tree__row--local"))).toEqual([true, true, false, false, false]);
      expect(rows.map((r) => r.classes().includes("git-tree__row--push-boundary"))).toEqual([
        false,
        false,
        true,
        false,
        false,
      ]);
      expect(rows[0].attributes("title")).toContain("Not on any remote yet");
      expect(rows[2].attributes("title")).not.toContain("Not on any remote yet");
      const dots = w.findAll("svg circle").filter((c) => c.attributes("r") !== "8.2");
      expect(dots[0].attributes("fill")).toBe("var(--panel)");
      expect(dots[1].attributes("fill")).toBe("var(--panel)");
      expect(dots[2].attributes("fill")).not.toBe("var(--panel)");
    });

    test("marks nothing local when no remote-tracking ref is loaded", () => {
      const w = mountGraph({
        history: true,
        commits: chain({ 3: [] }),
        head: "h1",
      });
      expect(w.find(".git-tree__row--local").exists()).toBe(false);
      expect(w.find(".git-tree__row--push-boundary").exists()).toBe(false);
    });

    test("dims commits already on the range base and keeps the branch's own work full", () => {
      const w = mountGraph({
        history: true,
        rangeBase: "develop",
        commits: chain({ 4: ["origin/develop"] }),
        head: "h1",
      });
      const rows = rowsOf(w);
      expect(rows.map((r) => r.classes().includes("git-tree__row--on-base"))).toEqual([
        false,
        false,
        false,
        true,
        true,
      ]);
      expect(rows[3].attributes("title")).toContain("Already on develop");
      expect(rows[0].attributes("title")).not.toContain("Already on");

      const none = mountGraph({ history: true, rangeBase: "develop", commits: chain(), head: "h1" });
      expect(none.find(".git-tree__row--on-base").exists()).toBe(false);
    });

    test("origin/HEAD folds into the sibling remote chip as a default suffix", () => {
      const w = mountGraph({
        history: true,
        commits: [mk(1, [], ["origin/HEAD", "origin/develop"])],
        head: "",
      });
      const chips = w.findAll(".git-tree__history-refs .git-tree__ref");
      expect(chips).toHaveLength(1);
      expect(chips[0].find(".git-tree__ref-label").text()).toBe("origin/develop");
      expect(chips[0].find(".git-tree__ref-default").text()).toBe("default");
      expect(chips[0].attributes("title")).toContain(" · default");

      const alone = mountGraph({ history: true, commits: [mk(1, [], ["origin/HEAD"])], head: "" });
      expect(alone.findAll(".git-tree__history-refs .git-tree__ref")).toHaveLength(1);
      expect(alone.find(".git-tree__ref-default").exists()).toBe(false);
    });

    test("HEAD and the current branch are filled, the base outlined, and they are never the collapsed ones", () => {
      const w = mountGraph({
        history: true,
        rangeBase: "origin/develop",
        head: "h1",
        commits: [mk(1, [], ["tag:v1", "origin/x", "origin/develop", "main", "HEAD"])],
      });
      const chips = w.findAll(".git-tree__history-refs .git-tree__ref");
      expect(chips.map((c) => c.find(".git-tree__ref-label").text() || c.text())).toEqual(["HEAD", "main", "+3"]);
      expect(chips[0].classes()).toContain("git-tree__ref--filled");
      expect(chips[1].classes()).toContain("git-tree__ref--filled");

      const base = mountGraph({
        history: true,
        rangeBase: "origin/develop",
        head: "",
        commits: [mk(1, [], ["origin/x", "origin/develop"])],
      });
      const baseChips = base.findAll(".git-tree__history-refs .git-tree__ref");
      expect(baseChips[0].find(".git-tree__ref-label").text()).toBe("origin/develop");
      expect(baseChips[0].classes()).toContain("git-tree__ref--outlined");
      expect(baseChips[1].classes()).not.toContain("git-tree__ref--outlined");
    });

    test("legacy mode renders none of the new classes", () => {
      const w = mountGraph({
        history: false,
        rangeBase: "develop",
        commits: chain({ 4: ["origin/develop"] }),
        head: "h1",
      });
      for (const cls of ["--local", "--push-boundary", "--on-base"]) {
        expect(w.find(`.git-tree__row${cls}`).exists()).toBe(false);
      }
      expect(w.find(".git-tree__ref--filled").exists()).toBe(false);
      expect(w.findAll("svg circle").every((c) => c.attributes("fill") !== "var(--panel)")).toBe(true);
    });
  });
});
