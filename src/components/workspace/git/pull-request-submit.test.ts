import { describe, expect, test, vi } from "vitest";
import { submitPullRequest, type CreatePullRequestPayload } from "./pull-request-submit.js";

const payload: CreatePullRequestPayload = {
  title: "My PR",
  description: "desc",
  sourceBranch: "feature/x",
  targetBranch: "main",
  connectionId: "conn-1",
};

describe("submitPullRequest", () => {
  test("returns ok:true with the pr number and url on success", async () => {
    const azureCreatePullRequest = vi.fn().mockResolvedValue(undefined);
    const gitUi = { lastResult: { ok: true, pullRequestId: 42, url: "https://dev.azure.com/pr/42" } };

    const result = await submitPullRequest({ azureCreatePullRequest }, "ws1", payload, gitUi);

    expect(azureCreatePullRequest).toHaveBeenCalledWith("ws1", payload);
    expect(result).toEqual({
      ok: true,
      summary: "PR #42 created.",
      url: "https://dev.azure.com/pr/42",
      pullRequestId: 42,
    });
  });

  test("returns ok:true with an empty id when the backend omits pullRequestId", async () => {
    const azureCreatePullRequest = vi.fn().mockResolvedValue(undefined);
    const gitUi = { lastResult: { ok: true } };

    const result = await submitPullRequest({ azureCreatePullRequest }, "ws1", payload, gitUi);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("PR # created.");
    expect(result.url).toBe("");
  });

  test("returns ok:false with the backend summary on failure", async () => {
    const azureCreatePullRequest = vi.fn().mockResolvedValue(undefined);
    const gitUi = { lastResult: { ok: false, summary: "A pull request already exists for this branch." } };

    const result = await submitPullRequest({ azureCreatePullRequest }, "ws1", payload, gitUi);

    expect(result).toEqual({ ok: false, summary: "A pull request already exists for this branch.", url: "" });
  });

  test("falls back to a generic failure message when the backend gives none", async () => {
    const azureCreatePullRequest = vi.fn().mockResolvedValue(undefined);
    const gitUi = { lastResult: null };

    const result = await submitPullRequest({ azureCreatePullRequest }, "ws1", payload, gitUi);

    expect(result).toEqual({ ok: false, summary: "Failed to create pull request.", url: "" });
  });
});
