import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetailStats from "./DockerDetailStats.vue";
import { heartbeatTargetCount, resetHeartbeatForTests } from "../../../app/status-heartbeat.js";

const MOCK_ROW = {
  cpuPerc: "12.45%",
  memUsage: "256MiB / 2GiB",
  memPerc: "12.8%",
  netIO: "113.4MB / 116.0MB",
  blockIO: "8.19MB / 0B",
  pids: "130",
};

describe("DockerDetailStats — visual render with mock stats row", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders all five metric cards with values", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();

    const labels = wrapper.findAll(".stats__card-label").map((l) => l.text());
    expect(labels).toEqual(["CPU", "Memory", "Network I/O", "Block I/O", "PIDs"]);

    const values = wrapper.findAll(".stats__card-value").map((v) => v.text());
    expect(values[0]).toBe("12.45%");
    expect(values[1]).toBe("12.8%");
    expect(values[2]).toBe("113.4MB / 116.0MB");
    expect(values[3]).toBe("8.19MB / 0B");
    expect(values[4]).toBe("130");
  });

  it("renders memory usage sub-label under the percent", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();
    expect(wrapper.find(".stats__card-sub").text()).toBe("256MiB / 2GiB");
  });

  it("CPU and Memory bars reflect parsed percentages", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();

    const cpuBar = wrapper.find(".stats__bar-fill--cpu").attributes("style");
    expect(cpuBar).toContain("width: 12.45%");

    const memBar = wrapper.find(".stats__bar-fill--mem").attributes("style");
    expect(memBar).toContain("width: 12.8%");
  });

  it("clamps bar widths to [0, 100]", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: {
        containerId: "abc",
        backendId: "host",
        contextName: "default",
        mockRow: { ...MOCK_ROW, cpuPerc: "250%", memPerc: "-3%" },
      },
    });
    await flushPromises();
    expect(wrapper.find(".stats__bar-fill--cpu").attributes("style")).toContain("width: 100%");
    expect(wrapper.find(".stats__bar-fill--mem").attributes("style")).toContain("width: 0%");
  });

  it("Pause button toggles live indicator", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Live");
    expect(wrapper.find(".stats__dot--live").exists()).toBe(true);

    await wrapper.find("button.button--ghost").trigger("click");
    expect(wrapper.text()).toContain("Paused");
    expect(wrapper.find(".stats__dot--paused").exists()).toBe(true);
  });

  it("renders empty state when mockRow is null", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: null },
    });
    await flushPromises();
    expect(wrapper.find(".stats__empty").exists()).toBe(true);
  });

  it("renders CPU and Memory history sparkline charts", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();

    const charts = wrapper.findAll(".stats__chart");
    expect(charts.length).toBe(2);
    const labels = charts.map((c) => c.find(".stats__chart-label").text());
    expect(labels).toEqual(["CPU history", "Memory history"]);

    // Each chart hosts an svg sparkline.
    const sparklines = wrapper.findAll(".sparkline");
    expect(sparklines.length).toBe(2);
  });

  it("captures samples into the history buffer when data arrives", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();

    // After first sample we should see "1 / 60 samples" in the chart meta.
    expect(wrapper.text()).toContain("1 / 60 samples");
  });
});

// ── Shared status heartbeat ────────────────────────────────────────
describe("DockerDetailStats — live dot is a shared heartbeat target", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetHeartbeatForTests();
  });

  afterEach(() => {
    resetHeartbeatForTests();
  });

  it("registers while live and keeps the static live styling", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();

    expect(heartbeatTargetCount()).toBe(1);
    expect(wrapper.get(".stats__dot").classes()).toContain("stats__dot--live");
    expect(wrapper.text()).toContain("Live · refresh every 2s");
  });

  it("pausing deregisters the same element; resuming registers it again", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();
    const el = wrapper.get(".stats__dot").element;

    const toggle = wrapper.findAll("button").find((b) => b.text() === "Pause")!;
    await toggle.trigger("click");

    expect(heartbeatTargetCount()).toBe(0);
    const dot = wrapper.get(".stats__dot");
    expect(dot.element).toBe(el);
    expect(dot.classes()).toContain("stats__dot--paused");
    expect(wrapper.text()).toContain("Paused");

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Resume")!
      .trigger("click");
    expect(heartbeatTargetCount()).toBe(1);
  });

  it("unmount releases the target", async () => {
    const wrapper = mount(DockerDetailStats, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockRow: MOCK_ROW },
    });
    await flushPromises();
    expect(heartbeatTargetCount()).toBe(1);

    wrapper.unmount();
    expect(heartbeatTargetCount()).toBe(0);
  });
});
