import { describe, expect, test } from "vitest";
import type { AppState } from "../shared/types/state.js";
import { prePrSourceIdentityKey, reviewSourceIdentityKey } from "../shared/review-source-identity.js";
import { createReviewMetadataStore } from "./review-metadata-store.js";

const repository = {
  id: "100",
  name: "repo",
  fullName: "acme/repo",
  remoteUrl: "https://github.com/acme/repo.git",
  sameAsTarget: true,
  canPush: null,
};

function setup(review: Record<string, unknown>) {
  const state = { workspaces: [{ id: "ws-1", review }] } as unknown as AppState;
  const store = {
    async mutate(mutator: (draft: AppState) => void | Promise<void>) {
      // Like the real store: the mutation applies to a copy that is published only when it did not throw.
      const draft = structuredClone(state);
      await mutator(draft);
      state.workspaces = draft.workspaces;
    },
  };
  const read = () => state.workspaces[0].review as unknown as Record<string, unknown>;
  return { updater: createReviewMetadataStore(store), read };
}

const legacyReview = () => ({
  provider: "github",
  connectionId: "conn-1",
  prKey: "conn-1:repo:7",
  pullRequest: { id: 7, sourceRefName: "refs/heads/feature" },
});

describe("review metadata store", () => {
  test("fills a missing source repository once and saves the baseline for the identity that was proven", async () => {
    const { updater, read } = setup(legacyReview());
    const expectedIdentityKey = reviewSourceIdentityKey({ ...legacyReview(), sourceRepository: repository });
    await updater.updateReview("ws-1", {
      sourceRepository: repository,
      sourceBaselineSha: "a".repeat(40),
      expectedIdentityKey,
    });
    expect(read()).toMatchObject({ sourceRepository: { id: "100" }, sourceBaselineSha: "a".repeat(40) });

    await updater.updateReview("ws-1", { sourceRepository: { ...repository, id: "999" } });
    expect(read().sourceRepository).toMatchObject({ id: "100" });
  });

  test("refuses a baseline whose identity the workspace no longer has, and saves nothing of it", async () => {
    const { updater, read } = setup({ ...legacyReview(), sourceRepository: repository });
    const stale = reviewSourceIdentityKey({
      ...legacyReview(),
      pullRequest: { sourceRefName: "refs/heads/old-branch" },
      sourceRepository: repository,
    });
    await expect(
      updater.updateReview("ws-1", { sourceBaselineSha: "b".repeat(40), expectedIdentityKey: stale }),
    ).rejects.toThrow("source identity changed");
    expect(read()).not.toHaveProperty("sourceBaselineSha");
  });

  test("an unknown workspace is left alone", async () => {
    const { updater } = setup(legacyReview());
    await expect(updater.updateReview("missing", { sourceBaselineSha: "c".repeat(40) })).resolves.toBeUndefined();
  });
});

describe("review metadata store: a quickfix branch without a pull request", () => {
  const SHA_A = "a".repeat(40);
  const quickfixWorkspace = () => ({
    id: "ws-1",
    review: { provider: "github", prKey: "", connectionId: "conn-1" },
    quickfix: {
      connectionId: "conn-1",
      repositoryId: "",
      remoteUrl: "https://github.com/acme/repo.git",
      branchName: "fix/login",
    },
  });
  function setupQuickfix() {
    const state = { workspaces: [quickfixWorkspace()] } as unknown as AppState;
    const store = {
      async mutate(mutator: (draft: AppState) => void | Promise<void>) {
        const draft = structuredClone(state);
        await mutator(draft);
        state.workspaces = draft.workspaces;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture pokes loosely-typed state
    const workspace = () => state.workspaces[0] as unknown as Record<string, any>;
    return { updater: createReviewMetadataStore(store), workspace, state };
  }

  test("saves the baseline on the quickfix for the identity that was proven", async () => {
    const { updater, workspace } = setupQuickfix();
    const expectedIdentityKey = prePrSourceIdentityKey(workspace() as never);
    await updater.updateReview("ws-1", { sourceBaselineSha: SHA_A, expectedIdentityKey });
    expect(workspace().quickfix.sourceBaselineSha).toBe(SHA_A);
    expect(workspace().review).not.toHaveProperty("sourceBaselineSha");
  });

  test("refuses a baseline for an identity the quickfix no longer has, and saves nothing", async () => {
    const { updater, workspace } = setupQuickfix();
    const expectedIdentityKey = prePrSourceIdentityKey(workspace() as never);
    workspace().quickfix.branchName = "other";
    await expect(updater.updateReview("ws-1", { sourceBaselineSha: SHA_A, expectedIdentityKey })).rejects.toThrow(
      "identity changed",
    );
    expect(workspace().quickfix).not.toHaveProperty("sourceBaselineSha");
  });

  test("a PR created while the operation ran takes the baseline only when it is for the same branch", async () => {
    const { updater, workspace } = setupQuickfix();
    const expectedIdentityKey = prePrSourceIdentityKey(workspace() as never);
    workspace().review = {
      ...workspace().review,
      prKey: "conn-1:repo:9",
      repository: { id: "", remoteUrl: "https://github.com/acme/repo.git" },
      pullRequest: { id: 9, sourceRefName: "fix/login" },
    };
    workspace().quickfix = null;
    await updater.updateReview("ws-1", { sourceBaselineSha: SHA_A, expectedIdentityKey });
    expect(workspace().review.sourceBaselineSha).toBe(SHA_A);

    workspace().review.pullRequest.sourceRefName = "elsewhere";
    await expect(
      updater.updateReview("ws-1", { sourceBaselineSha: "b".repeat(40), expectedIdentityKey }),
    ).rejects.toThrow("identity changed");
    expect(workspace().review.sourceBaselineSha).toBe(SHA_A);
  });
});
