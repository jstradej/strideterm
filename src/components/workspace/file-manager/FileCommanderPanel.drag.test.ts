import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FileCommanderPanel from "./FileCommanderPanel.vue";
import { useFileManagerStore } from "../../../stores/file-manager.js";
import { useAppStore } from "../../../stores/app.js";
import { PATHS_MIME } from "../../../lib/terminal-path-drop.js";

const entry = (relativePath: string, kind: "file" | "directory" = "file") => ({
  name: relativePath.split("/").pop() as string,
  relativePath,
  kind,
  size: 1,
  modifiedAt: "2026-10-10T12:00:00.000Z",
  extension: "",
  isHidden: false,
});

function dragstart(row: Element) {
  const store = new Map<string, string>();
  const event = new Event("dragstart", { bubbles: true }) as Event & { dataTransfer: unknown };
  event.dataTransfer = { effectAllowed: "", setData: (t: string, v: string) => store.set(t, v) };
  row.dispatchEvent(event);
  return store;
}

describe("FileCommanderPanel drag", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useFileManagerStore().rootPath = "/repo";
    useAppStore().payload = { meta: { platform: "linux" } } as never;
  });

  function mountPanel(marked: string[]) {
    const rows = [
      { key: "..", parent: true, entry: null },
      { key: "a b.txt", parent: false, entry: entry("a b.txt") },
      { key: "src", parent: false, entry: entry("src", "directory") },
      { key: "c.txt", parent: false, entry: entry("c.txt") },
    ];
    return mount(FileCommanderPanel, {
      props: {
        rows,
        cursor: 1,
        marked: new Set(marked),
        active: true,
        side: "left",
        path: "",
        rootName: "repo",
        sortBy: "name",
        sortAsc: true,
        loading: false,
        error: "",
      },
    });
  }

  it("does not make the parent row draggable", () => {
    const rows = mountPanel([]).findAll(".fcp__row");
    expect(rows[0].attributes("draggable")).toBe("false");
    expect(rows[1].attributes("draggable")).toBe("true");
  });

  it("drags the single row's absolute path", () => {
    const rows = mountPanel([]).findAll(".fcp__row");
    const data = dragstart(rows[1].element);
    expect(JSON.parse(data.get(PATHS_MIME)!)).toEqual(["/repo/a b.txt"]);
    expect(data.get("text/plain")).toBe("/repo/a b.txt");
  });

  it("drags every marked row when the dragged row is marked", () => {
    const rows = mountPanel(["a b.txt", "src"]).findAll(".fcp__row");
    const data = dragstart(rows[1].element);
    expect(JSON.parse(data.get(PATHS_MIME)!)).toEqual(["/repo/a b.txt", "/repo/src"]);
  });

  it("drags only the row itself when it is not among the marked ones", () => {
    const rows = mountPanel(["a b.txt"]).findAll(".fcp__row");
    const data = dragstart(rows[3].element);
    expect(JSON.parse(data.get(PATHS_MIME)!)).toEqual(["/repo/c.txt"]);
  });
});
