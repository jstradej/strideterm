import { describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TaskDashboardLogTab from "./TaskDashboardLogTab.vue";
import { apiKey } from "../../types/keys.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const LOG_WITH_JUDGE_NUDGED_AND_VERDICT_REJECTED =
  '{"ts":"2026-07-19T10:00:05.000Z","event":"judge-nudged","round":1,"detail":"nudge 1"}\n' +
  '{"ts":"2026-07-19T10:00:06.000Z","event":"verdict-rejected","round":1,"detail":"user rejected"}\n';

function mountTab(apiOverrides: Record<string, unknown> = {}) {
  const fileRead = vi.fn().mockResolvedValue({ content: LOG_WITH_JUDGE_NUDGED_AND_VERDICT_REJECTED });
  const taskState = { state: "running", currentRound: 1, rounds: [] };
  const api: AnyApi = { fileRead, ...apiOverrides };
  const wrapper = mount(TaskDashboardLogTab, {
    props: { taskState, workspaceCwd: "/repo", taskId: "task-1" },
    global: { provide: { [apiKey]: api } },
  });
  return { wrapper, fileRead };
}

// Regression coverage for the useTaskLog / task-log-labels extraction (code
// review 2026-07, §3.5 finding 1): this tab's own EVENT_LABELS map was
// missing `judge-nudged` and `verdict-rejected` entirely (unlike the Status
// tab's copy, which had them), so those events fell back to showing the raw
// event id string. Both tabs now share the merged, canonical map.
describe("TaskDashboardLogTab — judge-nudged / verdict-rejected render proper labels", () => {
  it("shows 'Judge nudged' and 'User rejected verdict' in the log table, not the raw event ids", async () => {
    const { wrapper } = mountTab();
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("Judge nudged");
    expect(text).toContain("User rejected verdict");
    expect(text).not.toContain("judge-nudged");
    expect(text).not.toContain("verdict-rejected");
  });
});

describe("TaskDashboardLogTab — log loading via useTaskLog", () => {
  it("loads TASK_LOG.jsonl for the workspace/task and renders one row per event", async () => {
    const { wrapper, fileRead } = mountTab();
    await flushPromises();

    expect(fileRead).toHaveBeenCalledWith({
      rootPath: "/repo",
      relativePath: ".strideterm/tasks/task-1/TASK_LOG.jsonl",
    });
    expect(wrapper.findAll(".td__log-row")).toHaveLength(2);
    expect(wrapper.text()).toContain("2 events");
  });
});

describe("TaskDashboardLogTab — Save uses the shared downloadTextFile helper", () => {
  it("triggers a text/plain blob download named after the task id", async () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let capturedDownload = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download;
    });

    const { wrapper } = mountTab();
    await flushPromises();

    const saveBtn = wrapper.findAll("button").find((b) => b.text() === "Save")!;
    await saveBtn.trigger("click");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/plain");
    expect(capturedDownload).toBe("task-log-task-1.txt");

    vi.restoreAllMocks();
  });
});
