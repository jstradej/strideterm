/**
 * Component test for AzurePipelinesTab with a mocked Azure transport.
 *
 * Exercises the real azure-pipelines Pinia store end-to-end: list render +
 * status icons, queueStatus=disabled blocking re-run, expand → recent runs
 * load, and the Re-run click opening the run dialog with the chosen run's id.
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

beforeEach(() => {
  setActivePinia(createPinia());
  api = makeApi();
});

describe("AzurePipelinesTab", () => {
  test("loads and renders pipelines with status icons", async () => {
    const wrapper = mountTab();
    await flushPromises();

    expect(api.listAzurePipelines).toHaveBeenCalledWith({ connectionId: "ado-1" });
    const rows = wrapper.findAll(".azure-pl-row");
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain("ci-build");
    expect(wrapper.text()).toContain("nightly");
    // ci-build succeeded → ok icon; nightly failed → fail icon
    expect(rows[0].find(".azure-pl-row__icon--ok").exists()).toBe(true);
    expect(rows[1].find(".azure-pl-row__icon--fail").exists()).toBe(true);
  });

  test("disables Re-run for a pipeline whose queueing is disabled", async () => {
    const wrapper = mountTab();
    await flushPromises();
    const rows = wrapper.findAll(".azure-pl-row");
    const nightlyRerun = rows[1].findAll(".azure-pl-row__actions button").find((b) => b.text().includes("Re-run"));
    expect(nightlyRerun?.attributes("disabled")).toBeDefined();
  });

  test("expanding a pipeline loads and renders its recent runs", async () => {
    const wrapper = mountTab();
    await flushPromises();
    const firstRow = wrapper.findAll(".azure-pl-row")[0];

    await firstRow.find(".azure-pl-row__expand").trigger("click");
    await flushPromises();

    expect(api.listAzurePipelineRuns).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
    });
    const runItems = firstRow.findAll(".azure-pl-run");
    expect(runItems).toHaveLength(2);
  });

  test("clicking Re-run last opens the run dialog seeded with that run's id", async () => {
    const appStore = useAppStore();
    const openDialog = vi.spyOn(appStore, "openDialog").mockImplementation(() => {});
    const wrapper = mountTab();
    await flushPromises();

    const rerun = wrapper
      .findAll(".azure-pl-row")[0]
      .findAll(".azure-pl-row__actions button")
      .find((b) => b.text().includes("Re-run"));
    await rerun!.trigger("click");

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
});
