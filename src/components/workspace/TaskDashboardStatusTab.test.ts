import { describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TaskDashboardStatusTab from "./TaskDashboardStatusTab.vue";
import { apiKey } from "../../types/keys.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const LOG_WITH_JUDGE_NUDGED_AND_VERDICT_REJECTED =
  '{"ts":"2026-07-19T10:00:05.000Z","event":"judge-nudged","round":1,"detail":"nudge 1"}\n' +
  '{"ts":"2026-07-19T10:00:06.000Z","event":"verdict-rejected","round":1,"detail":"user rejected"}\n';

function mountTab(overrides: Record<string, unknown> = {}, apiOverrides: Record<string, unknown> = {}) {
  const fileRead = vi.fn().mockResolvedValue({ content: LOG_WITH_JUDGE_NUDGED_AND_VERDICT_REJECTED });
  const taskState = {
    state: "running",
    currentRound: 1,
    maxRounds: 10,
    description: "",
    rounds: [{ round: 1, action: "running", startedAt: "2026-07-19T10:00:00.000Z" }],
    ...overrides,
  };
  const api: AnyApi = { fileRead, ...apiOverrides };
  const wrapper = mount(TaskDashboardStatusTab, {
    props: { taskState, workspaceCwd: "/repo", taskId: "task-1" },
    global: { provide: { [apiKey]: api } },
  });
  return { wrapper, fileRead };
}

// Regression coverage for the useTaskLog / task-log-labels extraction (code
// review 2026-07, §3.5 finding 1): TaskDashboardLogTab.vue's own EVENT_LABELS
// map was missing `judge-nudged` and `verdict-rejected` entirely, so those
// events fell back to showing the raw event id. The merged, canonical map
// both tabs now import fixes that — verified here for the Status tab's
// per-round activity table.
describe("TaskDashboardStatusTab — judge-nudged / verdict-rejected render proper labels", () => {
  it("shows 'Judge nudged' and 'User rejected verdict' in the per-round activity table, not the raw event ids", async () => {
    const { wrapper } = mountTab();
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("Judge nudged");
    expect(text).toContain("User rejected verdict");
    expect(text).not.toContain("judge-nudged");
    expect(text).not.toContain("verdict-rejected");
  });
});

describe("TaskDashboardStatusTab — log loading via useTaskLog", () => {
  it("loads TASK_LOG.jsonl for the workspace/task and shows the round's activity table", async () => {
    const { wrapper, fileRead } = mountTab();
    await flushPromises();

    expect(fileRead).toHaveBeenCalledWith({
      rootPath: "/repo",
      relativePath: ".strideterm/tasks/task-1/TASK_LOG.jsonl",
    });
    expect(wrapper.find(".td__activity-table").exists()).toBe(true);
    expect(wrapper.findAll(".td__activity-tr")).toHaveLength(2);
  });
});

// An uncapped v-for over a long round put thousands of <tr> (≈14k elements in
// the observed incident) permanently in the document, and this tab re-renders
// on every log poll — so style/layout paid for all of them every frame.
describe("TaskDashboardStatusTab — activity table row cap", () => {
  const HUGE_LOG = Array.from(
    { length: 5000 },
    (_unused, i) => `{"ts":"2026-07-19T10:00:0${i % 10}.000Z","event":"worker-output","round":1,"detail":"line ${i}"}`,
  ).join("\n");

  it("renders at most the cap for a 5000-entry round and reveals older entries a page at a time", async () => {
    const { wrapper } = mountTab({}, { fileRead: vi.fn().mockResolvedValue({ content: HUGE_LOG }) });
    await flushPromises();

    expect(wrapper.findAll(".td__activity-tr")).toHaveLength(200);
    // The tail is what's kept: newest entry visible, the one just past the cap not.
    expect(wrapper.text()).toContain("line 4999");
    expect(wrapper.text()).toContain("line 4800");
    expect(wrapper.text()).not.toContain("line 4799");

    const more = wrapper.find(".td__activity-more");
    expect(more.text()).toContain("Showing the last 200 of 5000");
    // One page at a time — never "show all", which would rebuild exactly the
    // multi-thousand-row table the cap exists to prevent.
    await more.find("button").trigger("click");
    expect(wrapper.findAll(".td__activity-tr")).toHaveLength(400);
    expect(wrapper.text()).toContain("line 4600");
    expect(wrapper.text()).not.toContain("line 4599");
  });

  it("leaves a round below the cap untouched and shows no expander", async () => {
    const { wrapper } = mountTab();
    await flushPromises();

    expect(wrapper.findAll(".td__activity-tr")).toHaveLength(2);
    expect(wrapper.find(".td__activity-more").exists()).toBe(false);
  });
});
