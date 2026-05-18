import { describe, it, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetailTop from "./DockerDetailTop.vue";

const MOCK_TOP = `UID        PID    PPID    C    STIME    TTY    TIME    CMD
root       1234   1233    0    10:00    ?      00:00:01 node server.js --port 3000
root       1240   1234    0    10:00    ?      00:00:00 sh -c npm start
`;

describe("DockerDetailTop — visual render with mock docker top output", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders header columns from first line", async () => {
    const wrapper = mount(DockerDetailTop, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockOutput: MOCK_TOP },
    });
    await flushPromises();

    const headers = wrapper.findAll(".top__table thead th").map((h) => h.text());
    expect(headers).toEqual(["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"]);
  });

  it("renders process rows", async () => {
    const wrapper = mount(DockerDetailTop, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockOutput: MOCK_TOP },
    });
    await flushPromises();
    const rows = wrapper.findAll(".top__table tbody tr");
    expect(rows.length).toBe(2);

    const firstRow = rows[0].findAll("td").map((c) => c.text());
    expect(firstRow[0]).toBe("root");
    expect(firstRow[1]).toBe("1234");
    expect(firstRow[firstRow.length - 1]).toContain("node server.js");
  });

  it("count badge reflects row count", async () => {
    const wrapper = mount(DockerDetailTop, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockOutput: MOCK_TOP },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("2 processes");
  });

  it("shows empty state when output has only header (no processes)", async () => {
    const wrapper = mount(DockerDetailTop, {
      props: {
        containerId: "abc",
        backendId: "host",
        contextName: "default",
        mockOutput: "UID PID CMD",
      },
    });
    await flushPromises();
    expect(wrapper.find(".top__empty").exists()).toBe(true);
  });

  it("does not truncate long CMD column", async () => {
    const longCmd = "/usr/bin/long-binary --with --many --flags=value1 --more=value2 /path/to/file";
    const out = `PID    CMD
1234   ${longCmd}
`;
    const wrapper = mount(DockerDetailTop, {
      props: { containerId: "abc", backendId: "host", contextName: "default", mockOutput: out },
    });
    await flushPromises();
    const lastTd = wrapper.find(".top__table tbody td:last-child").text();
    expect(lastTd).toContain("/path/to/file");
  });
});
