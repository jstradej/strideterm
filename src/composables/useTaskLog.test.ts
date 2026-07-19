import { describe, expect, it, vi } from "vitest";
import { defineComponent, reactive } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import { useTaskLog, formatTime, type TaskLogProps } from "./useTaskLog.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function mountHarness(api: AnyApi, props: TaskLogProps) {
  let handle!: ReturnType<typeof useTaskLog>;
  const wrapper = mount(
    defineComponent({
      setup() {
        handle = useTaskLog(api, props);
        return () => null;
      },
    }),
  );
  return { wrapper, handle };
}

describe("useTaskLog — loading and parsing", () => {
  it("loads and parses JSONL content into logEntries", async () => {
    const fileRead = vi.fn().mockResolvedValue({
      content:
        '{"ts":"2026-07-19T10:00:00.000Z","event":"task-started"}\n' +
        '{"ts":"2026-07-19T10:00:01.000Z","event":"task-completed"}\n',
    });
    const props = reactive({
      workspaceCwd: "/repo",
      taskId: "task-1",
      taskState: { state: "running", currentRound: 1, rounds: [] },
    });
    const { handle } = mountHarness({ fileRead }, props);
    await flushPromises();

    expect(fileRead).toHaveBeenCalledWith({
      rootPath: "/repo",
      relativePath: ".strideterm/tasks/task-1/TASK_LOG.jsonl",
    });
    expect(handle.logEntries.value).toHaveLength(2);
    expect(handle.logEntries.value[0].event).toBe("task-started");
    expect(handle.logEntries.value[1].event).toBe("task-completed");
  });

  it("skips blank lines and malformed JSON lines without throwing", async () => {
    const fileRead = vi.fn().mockResolvedValue({
      content:
        '{"ts":"2026-07-19T10:00:00.000Z","event":"task-started"}\n' +
        "\n" +
        "not json\n" +
        '{"ts":"2026-07-19T10:00:02.000Z","event":"task-completed"}\n',
    });
    const props = reactive({ workspaceCwd: "/repo", taskId: "task-1", taskState: {} });
    const { handle } = mountHarness({ fileRead }, props);
    await flushPromises();

    expect(handle.logEntries.value).toHaveLength(2);
  });

  it("does nothing when workspaceCwd or taskId is missing", async () => {
    const fileRead = vi.fn();
    const props = reactive({ workspaceCwd: "", taskId: "", taskState: {} });
    mountHarness({ fileRead }, props);
    await flushPromises();
    expect(fileRead).not.toHaveBeenCalled();
  });

  it("clears logRaw / logEntries when fileRead rejects", async () => {
    const fileRead = vi.fn().mockRejectedValue(new Error("not found"));
    const props = reactive({ workspaceCwd: "/repo", taskId: "task-1", taskState: {} });
    const { handle } = mountHarness({ fileRead }, props);
    await flushPromises();
    expect(handle.logEntries.value).toEqual([]);
  });
});

describe("useTaskLog — reload watch (collapsed from the tabs' previous 3-4 separate watches)", () => {
  it("reloads when taskState.state changes", async () => {
    const fileRead = vi.fn().mockResolvedValue({ content: "" });
    const props = reactive({
      workspaceCwd: "/repo",
      taskId: "task-1",
      taskState: { state: "running", currentRound: 0, rounds: [] },
    });
    mountHarness({ fileRead }, props);
    await flushPromises();
    expect(fileRead).toHaveBeenCalledTimes(1);

    props.taskState.state = "evaluating";
    await flushPromises();
    expect(fileRead).toHaveBeenCalledTimes(2);
  });

  it("reloads when taskState.currentRound changes", async () => {
    const fileRead = vi.fn().mockResolvedValue({ content: "" });
    const props = reactive({
      workspaceCwd: "/repo",
      taskId: "task-1",
      taskState: { state: "running", currentRound: 0, rounds: [] },
    });
    mountHarness({ fileRead }, props);
    await flushPromises();
    expect(fileRead).toHaveBeenCalledTimes(1);

    props.taskState.currentRound = 1;
    await flushPromises();
    expect(fileRead).toHaveBeenCalledTimes(2);
  });

  it("reloads when taskState.rounds.length changes", async () => {
    const fileRead = vi.fn().mockResolvedValue({ content: "" });
    const props = reactive({
      workspaceCwd: "/repo",
      taskId: "task-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      taskState: { state: "running", currentRound: 0, rounds: [] as any[] },
    });
    mountHarness({ fileRead }, props);
    await flushPromises();
    expect(fileRead).toHaveBeenCalledTimes(1);

    props.taskState.rounds.push({ round: 1 });
    await flushPromises();
    expect(fileRead).toHaveBeenCalledTimes(2);
  });

  it("loads immediately on mount when taskId is already set", async () => {
    const fileRead = vi.fn().mockResolvedValue({ content: "" });
    const props = reactive({ workspaceCwd: "/repo", taskId: "task-1", taskState: {} });
    mountHarness({ fileRead }, props);
    await flushPromises();
    expect(fileRead).toHaveBeenCalledTimes(1);
  });

  it("does not load when taskId is empty even if state changes", async () => {
    const fileRead = vi.fn().mockResolvedValue({ content: "" });
    const props = reactive({
      workspaceCwd: "/repo",
      taskId: "",
      taskState: { state: "running", currentRound: 0, rounds: [] },
    });
    mountHarness({ fileRead }, props);
    await flushPromises();
    expect(fileRead).not.toHaveBeenCalled();

    props.taskState.state = "evaluating";
    await flushPromises();
    expect(fileRead).not.toHaveBeenCalled();
  });
});

describe("formatTime", () => {
  it("formats an ISO timestamp using toLocaleTimeString", () => {
    const iso = "2026-07-19T10:00:00.000Z";
    expect(formatTime(iso)).toBe(new Date(iso).toLocaleTimeString());
  });

  it("returns an empty string for null/undefined", () => {
    expect(formatTime(null)).toBe("");
    expect(formatTime(undefined)).toBe("");
  });
});
