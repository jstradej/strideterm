import { describe, expect, test, vi } from "vitest";
import {
  activateReviewCommentQuery,
  parseReviewCommentQuery,
  validateReviewCommentQuery,
} from "./review-comment-query.js";

const baseHref =
  "https://app.test/?token=secret&profileId=p1&reviewWorkspaceId=ws1&reviewProvider=azure-devops&reviewConnectionId=ado1&reviewPrKey=42&reviewCommentKind=azure-thread-comment&reviewCommentId=8&reviewThreadId=3&keep=yes#pane";

const payload = {
  appState: {
    workspaces: [
      {
        id: "ws1",
        profileId: "p1",
        review: { provider: "azure-devops", connectionId: "ado1", prKey: "42" },
      },
    ],
    settings: {
      integrations: {
        azureDevops: { connections: [{ id: "ado1", profileId: "p1" }] },
      },
    },
  },
};

describe("native review-comment query", () => {
  test("parses a valid locator and removes only its query fields", () => {
    const parsed = parseReviewCommentQuery(baseHref);
    expect(parsed.request).toEqual({
      profileId: "p1",
      workspaceId: "ws1",
      provider: "azure-devops",
      connectionId: "ado1",
      prKey: "42",
      target: { kind: "azure-thread-comment", threadId: "3", commentId: "8" },
    });
    expect(parsed.cleanedHref).toBe("/?token=secret&keep=yes#pane");
    expect(parsed.hasReviewParams).toBe(true);
  });

  test("consumes malformed or incomplete query targets without returning a request", () => {
    const parsed = parseReviewCommentQuery(
      "https://app.test/?token=secret&profileId=p1&reviewWorkspaceId=ws1&reviewProvider=azure-devops&reviewCommentKind=github-issue-comment&reviewCommentId=abc#home",
    );
    expect(parsed.request).toBeNull();
    expect(parsed.cleanedHref).toBe("/?token=secret#home");
  });

  test("leaves an unrelated profileId query untouched and rejects duplicate review fields", () => {
    expect(parseReviewCommentQuery("https://app.test/?profileId=p1&token=secret")).toEqual({
      request: null,
      cleanedHref: "https://app.test/?profileId=p1&token=secret",
      hasReviewParams: false,
    });
    const duplicate = parseReviewCommentQuery(baseHref.replace("#pane", "&reviewCommentId=9#pane"));
    expect(duplicate.request).toBeNull();
    expect(duplicate.cleanedHref).toBe("/?token=secret&keep=yes#pane");
  });

  test("requires the active profile and exact saved review and connection identities", () => {
    const request = parseReviewCommentQuery(baseHref).request;
    expect(request).not.toBeNull();
    if (!request) return;
    expect(validateReviewCommentQuery(request, payload, "p1")).toBe(true);
    expect(validateReviewCommentQuery(request, payload, "p2")).toBe(false);
    expect(validateReviewCommentQuery({ ...request, prKey: "43" }, payload, "p1")).toBe(false);
    expect(
      validateReviewCommentQuery(
        request,
        {
          appState: {
            ...payload.appState,
            settings: { integrations: { azureDevops: { connections: [{ id: "ado1", profileId: "p2" }] } } },
          },
        },
        "p1",
      ),
    ).toBe(false);
  });

  test("accepts the GitHub issue-comment target shape", () => {
    const parsed = parseReviewCommentQuery(
      "https://app.test/?profileId=p1&reviewWorkspaceId=ws1&reviewProvider=github&reviewConnectionId=gh1&reviewPrKey=owner%2Frepo%231&reviewCommentKind=github-issue-comment&reviewCommentId=99",
    );
    expect(parsed.request?.target).toEqual({ kind: "github-issue-comment", commentId: "99" });
  });

  test("activates only after the saved scope validates, then queues focus after activation", async () => {
    const request = parseReviewCommentQuery(baseHref).request;
    expect(request).not.toBeNull();
    if (!request) return;
    let activeWorkspaceId = "";
    const requestFocus = vi.fn();
    const activateWorkspace = vi.fn(async (workspaceId: string) => {
      activeWorkspaceId = workspaceId;
    });
    const activated = await activateReviewCommentQuery(request, {
      getPayload: () => payload,
      getActiveProfileId: () => "p1",
      getActiveWorkspaceId: () => activeWorkspaceId,
      activateWorkspace,
      requestFocus,
    });
    expect(activated).toBe(true);
    expect(activateWorkspace).toHaveBeenCalledWith("ws1");
    expect(requestFocus).toHaveBeenCalledWith(request);
  });

  test("does not activate or queue focus for a cross-profile cold-boot target", async () => {
    const request = parseReviewCommentQuery(baseHref).request;
    expect(request).not.toBeNull();
    if (!request) return;
    const activateWorkspace = vi.fn(async () => {});
    const requestFocus = vi.fn();
    const activated = await activateReviewCommentQuery(request, {
      getPayload: () => payload,
      getActiveProfileId: () => "other-profile",
      getActiveWorkspaceId: () => "",
      activateWorkspace,
      requestFocus,
    });
    expect(activated).toBe(false);
    expect(activateWorkspace).not.toHaveBeenCalled();
    expect(requestFocus).not.toHaveBeenCalled();
  });
});
