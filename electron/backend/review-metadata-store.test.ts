import { describe, expect, test } from "vitest";
import type { AppState } from "../shared/types/state.js";
import { reviewSourceIdentityKey } from "../shared/review-source-identity.js";
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
