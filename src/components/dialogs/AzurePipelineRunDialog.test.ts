/**
 * Component test for AzurePipelineRunDialog with a mocked Azure transport.
 *
 * Verifies the re-run flow: the dialog seeds branch/parameters/variables from
 * the chosen run, forwards an edited submit to the transport, and surfaces a
 * permission (403-mapped) error without calling onSubmitted.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AzurePipelineRunDialog from "./AzurePipelineRunDialog.vue";
import { useAzurePipelinesStore } from "../../stores/azure-pipelines.js";
import type { Transport } from "../../transport.js";

const SEED = {
  branch: "refs/heads/release",
  parameters: { environment: "staging", runTests: "true" },
  variables: [
    { name: "imageTag", value: "1.4.2", isSecret: false },
    { name: "apiKey", value: "", isSecret: true },
  ],
};

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    getAzurePipelineRunSeed: vi.fn(async () => SEED),
    runAzurePipeline: vi.fn(async () => ({ id: 999, state: "inProgress", webUrl: "https://web/run/999" })),
    ...overrides,
  };
}

let api: ReturnType<typeof makeApi>;
let onCancel: ReturnType<typeof vi.fn>;
let onSubmitted: ReturnType<typeof vi.fn>;

function mountDialog() {
  const store = useAzurePipelinesStore();
  store.init(api as unknown as Transport);
  return mount(AzurePipelineRunDialog, {
    props: {
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
      pipelineName: "ci-build",
      runId: 555,
      onCancel,
      onSubmitted,
    },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  api = makeApi();
  onCancel = vi.fn();
  onSubmitted = vi.fn();
});

describe("AzurePipelineRunDialog", () => {
  test("seeds branch, parameters and variables from the chosen run", async () => {
    const wrapper = mountDialog();
    await flushPromises();

    expect(api.getAzurePipelineRunSeed).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
      runId: 555,
    });
    const branch = wrapper.find('input[placeholder="refs/heads/main"]').element as HTMLInputElement;
    expect(branch.value).toBe("refs/heads/release");
    // 2 parameter rows + 2 variable rows
    expect(wrapper.findAll(".apr-row")).toHaveLength(4);
    // v-model values live on the input elements, not in the HTML string.
    const keyValues = wrapper.findAll(".apr-row__key").map((i) => (i.element as HTMLInputElement).value);
    expect(keyValues).toContain("environment");
    expect(keyValues).toContain("imageTag");
  });

  test("submitting forwards the seeded values and calls onSubmitted", async () => {
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(api.runAzurePipeline).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
      branch: "refs/heads/release",
      parameters: { environment: "staging", runTests: "true" },
      variables: [
        { name: "imageTag", value: "1.4.2", isSecret: false },
        { name: "apiKey", value: "", isSecret: true },
      ],
    });
    expect(onSubmitted).toHaveBeenCalledWith({ id: 999, state: "inProgress", webUrl: "https://web/run/999" });
  });

  test("shows a permission error and does not call onSubmitted on 403", async () => {
    api = makeApi({
      runAzurePipeline: vi.fn(async () => {
        throw new Error("This PAT can't queue pipeline runs — it needs the Build (Read & execute) scope.");
      }),
    });
    const wrapper = mountDialog();
    await flushPromises();

    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find(".apr-error").text()).toContain("Build (Read & execute)");
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
