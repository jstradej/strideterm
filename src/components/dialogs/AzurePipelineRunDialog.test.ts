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
    getAzurePipelineRunParameters: vi.fn(async (): Promise<unknown[]> => []),
    getAzurePipelineRefs: vi.fn(async () => ({ branches: [], tags: [], repositoryId: "" })),
    getAzurePipelineCommits: vi.fn(async (): Promise<unknown[]> => []),
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

  test("renders typed controls from the parameter schema and submits merged values", async () => {
    api = makeApi({
      getAzurePipelineRunParameters: vi.fn(async () => [
        { name: "environment", displayName: "Environment", type: "string", values: ["staging", "prod"] },
        { name: "runTests", displayName: "Run tests", type: "boolean" },
        { name: "tenant", displayName: "Tenant", type: "string", default: "all" },
      ]),
    });
    const wrapper = mountDialog();
    await flushPromises();

    // Schema fetched for the seeded branch.
    expect(api.getAzurePipelineRunParameters).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
      branch: "refs/heads/release",
    });

    // Choice param → <select> pre-set to the run's value; boolean → checked checkbox.
    const select = wrapper.find("select.apr-row__value").element as HTMLSelectElement;
    expect(select.value).toBe("staging");
    expect(wrapper.findAll("select.apr-row__value option")).toHaveLength(2);
    const bool = wrapper.find(".apr-row__bool input[type=checkbox]").element as HTMLInputElement;
    expect(bool.checked).toBe(true);
    // Declared params have fixed labels, not editable name inputs (only the 2 variables do).
    expect(wrapper.findAll(".apr-row__key")).toHaveLength(2);

    await wrapper.find("form").trigger("submit");
    await flushPromises();
    // tenant comes from its schema default; environment/runTests from the run.
    expect(api.runAzurePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: { environment: "staging", runTests: "true", tenant: "all" } }),
    );
  });

  test("branch picker lists repo branches and tags, and selecting one fills the field", async () => {
    api = makeApi({
      getAzurePipelineRefs: vi.fn(async () => ({
        branches: ["refs/heads/main", "refs/heads/develop"],
        tags: ["refs/tags/v1.0"],
        repositoryId: "repo-1",
      })),
    });
    const wrapper = mountDialog();
    await flushPromises();

    expect(api.getAzurePipelineRefs).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      pipelineId: 10,
    });

    // Opening defaults to the Branches tab (seed ref is a branch).
    await wrapper.find(".apr-branch__toggle").trigger("click");
    expect(wrapper.findAll(".apr-branch__item .apr-branch__name").map((n) => n.text())).toEqual(["main", "develop"]);

    // Switching to the Tags tab shows only tags.
    const tabs = wrapper.findAll(".apr-branch__tab");
    await tabs[1].trigger("click");
    expect(wrapper.findAll(".apr-branch__item .apr-branch__name").map((n) => n.text())).toEqual(["v1.0"]);

    // Picking a branch fills the field with the full ref.
    await tabs[0].trigger("click");
    await wrapper.findAll(".apr-branch__item")[1].trigger("mousedown");
    const branchInput = wrapper.find(".apr-branch__input").element as HTMLInputElement;
    expect(branchInput.value).toBe("refs/heads/develop");
  });

  test("Commits tab lazily loads commits; picking one sets the field to the full sha", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    api = makeApi({
      getAzurePipelineRefs: vi.fn(async () => ({ branches: ["refs/heads/main"], tags: [], repositoryId: "repo-1" })),
      getAzurePipelineCommits: vi.fn(async () => [
        { id: sha, shortId: "01234567", comment: "Fix the thing", author: "Alice" },
      ]),
    });
    const wrapper = mountDialog();
    await flushPromises();

    // Commits are not fetched until the Commits tab is opened.
    expect(api.getAzurePipelineCommits).not.toHaveBeenCalled();

    await wrapper.find(".apr-branch__toggle").trigger("click");
    await wrapper.findAll(".apr-branch__tab")[2].trigger("click"); // Commits
    await flushPromises();

    expect(api.getAzurePipelineCommits).toHaveBeenCalledWith({
      connectionId: "ado-1",
      projectName: "Platform",
      repositoryId: "repo-1",
    });
    expect(wrapper.find(".apr-branch__sha").text()).toBe("01234567");

    // Picking a commit drops its full id into the field (backend turns it into a `version`).
    await wrapper.find(".apr-branch__item").trigger("mousedown");
    expect((wrapper.find(".apr-branch__input").element as HTMLInputElement).value).toBe(sha);
  });

  test("renders capitalised booleans as checkboxes and blank-value params as separators", async () => {
    api = makeApi({
      getAzurePipelineRunParameters: vi.fn(async () => [
        { name: "deployCerts", displayName: "Deploy Certs", type: "boolean", default: "False" },
        { name: "_separator1", displayName: "—— SERVICES ——", type: "5", default: " ", values: [" "] },
        { name: "core", displayName: "Core", type: "boolean", default: "True" },
      ]),
    });
    const wrapper = mountDialog();
    await flushPromises();

    // Azure sends "True"/"False" (capitalised) — both map to the right checkbox state.
    const checks = wrapper.findAll(".apr-row__bool input[type=checkbox]");
    expect(checks).toHaveLength(2);
    expect((checks[0].element as HTMLInputElement).checked).toBe(false); // False
    expect((checks[1].element as HTMLInputElement).checked).toBe(true); // True
    // The blank-value choice param renders as a section label, not a dropdown.
    expect(wrapper.findAll(".apr-separator")).toHaveLength(1);
    expect(wrapper.find(".apr-separator").text()).toBe("—— SERVICES ——");
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
