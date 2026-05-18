import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import Sparkline from "./Sparkline.vue";

describe("Sparkline — visual render with mock data", () => {
  it("renders empty placeholder when data array is empty", () => {
    const wrapper = mount(Sparkline, {
      props: { data: [], max: 100, stroke: "#63b3ed", fill: "rgba(0,0,0,0)" },
    });
    expect(wrapper.find(".sparkline__empty-text").exists()).toBe(true);
    expect(wrapper.find("path.sparkline__line").exists()).toBe(false);
  });

  it("draws a line path and fill area for a populated series", () => {
    const wrapper = mount(Sparkline, {
      props: { data: [10, 20, 50, 80, 30], max: 100, stroke: "#63b3ed", fill: "rgba(0,0,0,0.1)" },
    });
    const line = wrapper.find("path.sparkline__line");
    const fill = wrapper.find("path.sparkline__fill");
    expect(line.exists()).toBe(true);
    expect(fill.exists()).toBe(true);
    // Line path must contain 5 commands (1 M + 4 L)
    const d = line.attributes("d") || "";
    expect(d.match(/[ML]/g)?.length).toBe(5);
  });

  it("anchors a single-sample series to the right edge", () => {
    const wrapper = mount(Sparkline, {
      props: { data: [42], max: 100, stroke: "#63b3ed", fill: "rgba(0,0,0,0)" },
    });
    const dot = wrapper.find("circle.sparkline__dot");
    expect(dot.exists()).toBe(true);
    const cx = parseFloat(dot.attributes("cx") || "0");
    // Should be near the right edge (VIEW_W = 200, PAD = 2)
    expect(cx).toBeGreaterThan(190);
  });

  it("clamps values above max and below zero", () => {
    const wrapper = mount(Sparkline, {
      props: { data: [-10, 50, 200], max: 100, stroke: "#63b3ed", fill: "rgba(0,0,0,0)" },
    });
    const line = wrapper.find("path.sparkline__line");
    const d = line.attributes("d") || "";
    // VIEW_H=60, PAD=2. Clamped 0 should map near y=58 (bottom), clamped 100
    // should map near y=2 (top). We don't assert exact coordinates but parse
    // them to confirm they're in-range.
    const coords = Array.from(d.matchAll(/[ML]([\d.]+),([\d.]+)/g)).map((m) => [parseFloat(m[1]), parseFloat(m[2])]);
    expect(coords.length).toBe(3);
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(200);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(60);
    }
  });
});
