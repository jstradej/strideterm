import { describe, it, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDiskUsage from "./DockerDiskUsage.vue";

const MOCK_DF = [
  JSON.stringify({ Type: "Images", TotalCount: "42", Active: "8", Size: "12.4GB", Reclaimable: "9.1GB (73%)" }),
  JSON.stringify({ Type: "Containers", TotalCount: "8", Active: "4", Size: "210MB", Reclaimable: "84MB" }),
  JSON.stringify({ Type: "Local Volumes", TotalCount: "12", Active: "3", Size: "1.8GB", Reclaimable: "1.3GB" }),
  JSON.stringify({ Type: "Build Cache", TotalCount: "60", Active: "0", Size: "3.4GB", Reclaimable: "3.4GB (100%)" }),
].join("\n");

describe("DockerDiskUsage — visual render with mock docker system df", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders one row per df type with size", async () => {
    const wrapper = mount(DockerDiskUsage, { props: { mockRaw: MOCK_DF } });
    await flushPromises();
    const rows = wrapper.findAll(".disk-usage__row");
    expect(rows.length).toBe(4);

    const labels = rows.map((r) => r.find(".disk-usage__label").text());
    expect(labels).toEqual(["Images", "Cnt", "Vols", "Cache"]);

    const sizes = rows.map((r) => r.find(".disk-usage__value").text());
    expect(sizes).toEqual(["12.4GB", "210MB", "1.8GB", "3.4GB"]);
  });

  it("shows reclaimable suffix when present", async () => {
    const wrapper = mount(DockerDiskUsage, { props: { mockRaw: MOCK_DF } });
    await flushPromises();
    expect(wrapper.text()).toContain("9.1GB (73%) reclaimable");
  });

  it("tolerates malformed lines and renders only parseable rows", async () => {
    const wrapper = mount(DockerDiskUsage, {
      props: { mockRaw: `${JSON.stringify({ Type: "Images", Size: "1GB" })}\nnot-json\n` },
    });
    await flushPromises();
    expect(wrapper.findAll(".disk-usage__row").length).toBe(1);
    expect(wrapper.text()).toContain("1GB");
  });

  it("renders empty placeholder for empty stdout", async () => {
    const wrapper = mount(DockerDiskUsage, { props: { mockRaw: "" } });
    await flushPromises();
    expect(wrapper.find(".disk-usage__empty").exists()).toBe(true);
  });
});
