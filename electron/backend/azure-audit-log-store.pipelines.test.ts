import { describe, expect, test } from "vitest";
import { classifyAzureRequest } from "./azure-audit-log-store.js";

const ORG = "https://dev.azure.com/org/Platform/_apis";

describe("classifyAzureRequest — pipelines", () => {
  test("classifies build definitions list as listPipelines (read)", () => {
    const c = classifyAzureRequest("GET", `${ORG}/build/definitions?includeLatestBuilds=true&api-version=7.1`);
    expect(c).toEqual({ operation: "listPipelines", category: "read", resourceType: "pipeline" });
  });

  test("classifies a single pipeline run fetch as fetchPipelineRun (read)", () => {
    const c = classifyAzureRequest("GET", `${ORG}/pipelines/10/runs/555?api-version=7.1`);
    expect(c).toEqual({ operation: "fetchPipelineRun", category: "read", resourceType: "run" });
  });

  test("classifies a pipeline runs list as listPipelineRuns (read)", () => {
    const c = classifyAzureRequest("GET", `${ORG}/pipelines/10/runs?api-version=7.1`);
    expect(c).toEqual({ operation: "listPipelineRuns", category: "read", resourceType: "run" });
  });

  test("classifies queueing a run as runPipeline (write)", () => {
    const c = classifyAzureRequest("POST", `${ORG}/pipelines/10/runs?api-version=7.1`);
    expect(c).toEqual({ operation: "runPipeline", category: "write", resourceType: "run" });
  });
});
