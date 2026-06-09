/**
 * Focused test for the drag-to-resize logic of DockerResourceTable.
 *
 * jsdom reports offsetWidth=0, so the component starts in auto layout; the
 * first pointerdown on a resizer calls forceFix() (→ fixed layout, columns get
 * a fallback width) and a subsequent pointermove must widen exactly that column.
 * This isolates the drag *logic* from real-browser hit-testing.
 */
import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import DockerResourceTable from "./DockerResourceTable.vue";

interface Row {
  name: string;
  size: string;
}
const columns = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
];
const rows: Row[] = [
  { name: "alpha", size: "1" },
  { name: "beta", size: "2" },
];

function mountTable() {
  return mount(DockerResourceTable, {
    attachTo: document.body,
    props: { rows, columns, rowId: (r: Row) => r.name, selectable: false },
  });
}

describe("DockerResourceTable resize", () => {
  test("dragging a column's resizer widens that column", async () => {
    const wrapper = mountTable();
    await nextTick();
    await nextTick();

    const resizer = wrapper.find(".dr-table__resizer");
    expect(resizer.exists()).toBe(true);

    // Press on the first column's resizer, drag 60px right, release. Use native
    // events (clientX set via the constructor) since jsdom's MouseEvent.clientX
    // is getter-only and @vue/test-utils' trigger() can't assign it.
    resizer.element.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 160 }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
    await nextTick();

    // Fixed layout engaged → the first <col> carries an explicit px width that
    // reflects the drag (forceFix fallback 120 + 60px delta = 180).
    const firstCol = wrapper.findAll("col")[0];
    const style = firstCol.attributes("style") || "";
    const m = style.match(/width:\s*(\d+)px/);
    expect(m, `expected a px width on the first <col>, got style="${style}"`).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(120);
  });
});
