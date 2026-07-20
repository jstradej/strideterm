/**
 * Component test for AzurePipelinesTab with a mocked Azure transport.
 *
 * Exercises the real azure-pipelines Pinia store end-to-end: flat table render +
 * status icons, queueStatus=disabled blocking re-run, row-click → detail panel
 * loads recent runs, and the Re-run click opening the run dialog with the
 * chosen run's id.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AzurePipelinesTab from "./AzurePipelinesTab.vue";
import { useAppStore } from "../../../stores/app.js";
import { useAzurePipelinesStore } from "../../../stores/azure-pipelines.js";
import type { Transport } from "../../../transport.js";

const PIPELINES = [
  {
    connectionId: "ado-1",
    project: { id: "p1", name: "Platform" },
    id: 10,
    name: "ci-build",
    folder: "\\CI",
    queueStatus: "enabled",
    webUrl: "https://web/def/10",
    lastRun: {
      id: 555,
      buildNumber: "20260317.3",
      status: "completed",
      result: "succeeded",
      sourceBranch: "refs/heads/main",
      finishTime: "2026-03-17T09:00:00.000Z",
      webUrl: "https://web/build/555",
    },
  },
  {
    connectionId: "ado-1",
    project: { id: "p1", name: "Platform" },
    id: 11,
    name: "nightly",
    folder: "\\",
    queueStatus: "disabled",
    webUrl: "https://web/def/11",
    lastRun: {
      id: 600,
      buildNumber: "20260317.1",
      status: "completed",
      result: "failed",
      sourceBranch: "refs/heads/main",
      finishTime: "2026-03-17T02:00:00.000Z",
      webUrl: "https://web/build/600",
    },
  },
];

const RUNS = [
  { id: 555, name: "20260317.3", state: "completed", result: "succeeded", webUrl: "https://web/run/555" },
  { id: 540, name: "20260316.1", state: "completed", result: "failed", webUrl: "https://web/run/540" },
];

function makeApi() {
  return {
    listAzurePipelines: vi.fn(async () => PIPELINES),
    listAzurePipelineRuns: vi.fn(async () => RUNS),
    getAzurePipelineRunSeed: vi.fn(async () => ({ branch: "refs/heads/main", parameters: {}, variables: [] })),
    getAzurePipelineRunDetail: vi.fn(async () => ({ stages: [], errors: [] })),
    runAzurePipeline: vi.fn(async () => ({ id: 999, state: "inProgress", webUrl: "https://web/run/999" })),
    openExternal: vi.fn(),
    getAzureBuildLog: vi.fn(async () => ""),
  };
}

let api: ReturnType<typeof makeApi>;

function mountTab() {
  const store = useAzurePipelinesStore();
  store.init(api as unknown as Transport);
  return mount(AzurePipelinesTab, {
    props: { connections: [{ id: "ado-1", label: "Mock org" }] },
    global: { provide: { api } },
  });
}

/** Find the ▶ Re-run button within a table row's action cell. */
function rerunButton(row: ReturnType<ReturnType<typeof mountTab>["findAll"]>[number]) {
  return row.findAll("button").find((b) => b.text() === "▶");
}

beforeEach(() => {
  setActivePinia(createPinia());
  api = makeApi();
});

describe("AzurePipelinesTab", () => {
  test("loads and renders pipelines with status icons", async () => {
    const wrapper = mountTab();
    await flushPromises();

    expect(api.listAzurePipelines).toHaveBeenCalledWith({ connectionId: "ado-1" });
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain("ci-build");
    expect(wrapper.text()).toContain("nightly");
    // Default sort = newest first: ci-build (09:00, succeeded) then nightly (02:00, failed).
    expect(rows[0].find(".azure-pl-row__icon--ok").exists()).toBe(true);
    expect(rows[1].find(".azure-pl-row__icon--fail").exists()).toBe(true);
  });

  test("disables Re-run for a pipeline whose queueing is disabled", async () => {
    const wrapper = mountTab();
    await flushPromises();
    const rows = wrapper.findAll("tbody tr");
    expect(rerunButton(rows[0])?.attributes("disabled")).toBeUndefined();
    expect(rerunButton(rows[1])?.attributes("disabled")).toBeDefined();
  });

  test("clicking a pipeline row loads its recent runs in the detail panel", async () => {
    const wrapper = mountTab();
    await flushPromises();

    // Click a data cell of the first row to select it.
    await wrapper.findAll("tbody tr")[0].find("td").trigger("click");
    await flushPromises();

    expect(api.listAzurePipelineRuns).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
    });
    const runItems = wrapper.findAll(".azure-pl-run");
    expect(runItems).toHaveLength(2);
  });

  test("floats an in-progress pipeline to the top with a spinner", async () => {
    const running = {
      connectionId: "ado-1",
      project: { id: "p1", name: "Platform" },
      id: 12,
      name: "deploying",
      folder: "\\",
      queueStatus: "enabled",
      webUrl: "https://web/def/12",
      lastRun: {
        id: 700,
        buildNumber: "20260317.9",
        status: "inProgress",
        result: "none",
        sourceBranch: "refs/heads/main",
        // Old timestamp: by the default "when desc" sort it would land last,
        // so reaching the top proves the running-pin overrides the column sort.
        finishTime: "2026-03-10T00:00:00.000Z",
        webUrl: "https://web/build/700",
      },
    };
    api.listAzurePipelines = vi.fn(async () => [...PIPELINES, running]);
    const wrapper = mountTab();
    await flushPromises();

    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(3);
    expect(rows[0].text()).toContain("deploying");
    expect(rows[0].find(".azure-pl-spinner").exists()).toBe(true);
  });

  test("clicking Re-run opens the run dialog seeded with that run's id", async () => {
    const appStore = useAppStore();
    const openDialog = vi.spyOn(appStore, "openDialog").mockImplementation(() => {});
    const wrapper = mountTab();
    await flushPromises();

    await rerunButton(wrapper.findAll("tbody tr")[0])!.trigger("click");

    expect(openDialog).toHaveBeenCalledTimes(1);
    const [name, props] = openDialog.mock.calls[0];
    expect(name).toBe("AzurePipelineRunDialog");
    expect(props).toMatchObject({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
      pipelineName: "ci-build",
      runId: 555,
    });
  });

  test("clicking ↓ Log downloads the run's build log via the shared downloadTextFile helper", async () => {
    api.getAzureBuildLog = vi.fn().mockResolvedValue("line 1\nline 2\n");
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let capturedDownload = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download;
    });

    const wrapper = mountTab();
    await flushPromises();

    const logButton = wrapper.findAll("tbody tr")[0].findAll("button").find((b) => b.text() === "↓ Log")!;
    await logButton.trigger("click");
    await flushPromises();

    expect(api.getAzureBuildLog).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      buildId: 555,
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(await blob.text()).toBe("line 1\nline 2\n");
    expect(capturedDownload).toBe("ci-build-run-555.log");

    vi.restoreAllMocks();
  });
});
