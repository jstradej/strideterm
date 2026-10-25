import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  carryOverSourceBaseline,
  fullSourceRef,
  isFullSha,
  isManagedReviewBranch,
  managedReviewBranchAlias,
  normalizeRemoteIdentity,
  reviewSourceIdentityKey,
  sameRemote,
  sanitizePathSegment,
  sourceBranchName,
} from "./review-source-identity.js";

const SHA = "a".repeat(40);

const review = (overrides: Record<string, unknown> = {}) => ({
  provider: "github",
  connectionId: "conn-1",
  prKey: "conn-1:acme/repo:7",
  pullRequest: { sourceRefName: "refs/heads/feature/login", targetRefName: "refs/heads/main" },
  sourceRepository: {
    id: "100",
    name: "repo",
    fullName: "acme/repo",
    remoteUrl: "https://github.com/acme/repo.git",
    sameAsTarget: true,
    canPush: null,
  },
  ...overrides,
});

describe("refs and shas", () => {
  test("a source ref is always the full refs/heads name; the branch name is the short one", () => {
    expect(fullSourceRef("feature/login")).toBe("refs/heads/feature/login");
    expect(fullSourceRef("refs/heads/feature/login")).toBe("refs/heads/feature/login");
    expect(fullSourceRef("")).toBe("");
    expect(sourceBranchName("refs/heads/feature/login")).toBe("feature/login");
    expect(sourceBranchName("feature/login")).toBe("feature/login");
  });

  test("only a full lowercase hex object name is a sha", () => {
    expect(isFullSha(SHA)).toBe(true);
    expect(isFullSha("b".repeat(64))).toBe(true);
    for (const bad of ["", "abc123", "A".repeat(40), "g".repeat(40), SHA + "0", null, undefined, 42]) {
      expect(isFullSha(bad)).toBe(false);
    }
  });

  test("the managed alias is pr-<id>-<sanitized source>", () => {
    expect(managedReviewBranchAlias(7, "refs/heads/feature/login")).toBe("pr-7-feature-login");
    expect(managedReviewBranchAlias("123", "refs/heads/a b:c")).toBe("pr-123-a-b-c");
    expect(sanitizePathSegment("  ")).toBe("unknown");
  });

  test("the managed alias and the isolated <alias>-review-<uuid> checkout are the PR's branch", () => {
    const ref = "refs/heads/feature";
    const alias = managedReviewBranchAlias(7, ref);
    expect(isManagedReviewBranch(alias, 7, ref)).toBe(true);
    expect(isManagedReviewBranch(`${alias}-review-${randomUUID()}`, 7, ref)).toBe(true);
  });

  test("anything else is not the PR's managed branch", () => {
    const ref = "refs/heads/feature";
    const alias = managedReviewBranchAlias(7, ref);
    const uuid = randomUUID();
    for (const branch of [
      `${alias}-review-foo`,
      `${alias}-review-${uuid.toUpperCase()}`,
      `${alias}-review-${uuid}-x`,
      `${alias}-review-`,
      `${managedReviewBranchAlias(8, ref)}-review-${uuid}`,
      `${managedReviewBranchAlias(7, "refs/heads/other")}-review-${uuid}`,
      "develop",
      "",
    ]) {
      expect(isManagedReviewBranch(branch, 7, ref), branch).toBe(false);
    }
    expect(isManagedReviewBranch("pr-77-feature", 7, ref)).toBe(false);
    expect(isManagedReviewBranch("pr-7-feature", 77, ref)).toBe(false);
    expect(isManagedReviewBranch(`pr-77-feature-review-${uuid}`, 7, ref)).toBe(false);
  });
});

describe("normalizeRemoteIdentity", () => {
  test.each([
    ["https://github.com/acme/repo.git", "github.com/acme/repo"],
    ["https://GitHub.com/Acme/Repo", "github.com/acme/repo"],
    ["https://x-access-token:secret@github.com:443/acme/repo.git/", "github.com/acme/repo"],
    ["git@github.com:acme/repo.git", "github.com/acme/repo"],
    ["ssh://git@github.com/acme/repo.git", "github.com/acme/repo"],
    ["https://acme@dev.azure.com/acme/Platform/_git/web-app", "dev.azure.com/acme/platform/_git/web-app"],
    ["git@ssh.dev.azure.com:v3/acme/Platform/web-app", "dev.azure.com/acme/platform/_git/web-app"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRemoteIdentity(input)).toBe(expected);
  });

  test("scp-style, ssh and https spellings of one repository are the same remote", () => {
    const spellings = [
      "https://github.com/acme/repo.git",
      "git@github.com:acme/repo",
      "ssh://git@github.com/acme/repo.git",
      "https://token@github.com/acme/repo/",
    ];
    for (const a of spellings) for (const b of spellings) expect(sameRemote(a, b)).toBe(true);
  });

  test("a fork, a different host or an empty value is never the same remote", () => {
    expect(sameRemote("https://github.com/acme/repo", "https://github.com/someone/repo")).toBe(false);
    expect(sameRemote("https://github.com/acme/repo", "https://gitlab.com/acme/repo")).toBe(false);
    expect(sameRemote("", "")).toBe(false);
    expect(sameRemote("https://github.com/acme/repo", "")).toBe(false);
  });

  test("a local path (a local remote) compares by its normalized form", () => {
    expect(sameRemote("C:/work/remote.git", "C:\\work\\remote.git")).toBe(true);
    expect(sameRemote("/srv/git/repo.git/", "/srv/git/repo")).toBe(true);
    expect(sameRemote("/srv/git/repo.git", "/srv/git/other.git")).toBe(false);
  });
});

describe("source identity and the baseline bound to it", () => {
  test("the key names provider, connection, PR, FULL source ref and the SOURCE repository", () => {
    expect(reviewSourceIdentityKey(review())).toBe("github|conn-1|conn-1:acme/repo:7|refs/heads/feature/login|id:100");
  });

  test("a short and a full spelling of one source ref are one identity", () => {
    expect(reviewSourceIdentityKey(review({ pullRequest: { sourceRefName: "feature/login" } }))).toBe(
      reviewSourceIdentityKey(review()),
    );
  });

  test("any unknown part leaves no identity at all — an unbound baseline is no baseline", () => {
    expect(reviewSourceIdentityKey(null)).toBe("");
    expect(reviewSourceIdentityKey(review({ sourceRepository: null }))).toBe("");
    expect(reviewSourceIdentityKey(review({ pullRequest: { sourceRefName: "" } }))).toBe("");
    expect(reviewSourceIdentityKey(review({ connectionId: "" }))).toBe("");
    expect(reviewSourceIdentityKey(review({ prKey: "" }))).toBe("");
  });

  test("the repository is identified by id when known, else by remote, else by name", () => {
    const base = { name: "repo", sameAsTarget: true, canPush: null };
    expect(
      reviewSourceIdentityKey(
        review({ sourceRepository: { ...base, id: "", fullName: "a/b", remoteUrl: "git@h.io:a/b.git" } }),
      ),
    ).toContain("url:h.io/a/b");
    expect(
      reviewSourceIdentityKey(review({ sourceRepository: { ...base, id: "", fullName: "A/B", remoteUrl: "" } })),
    ).toContain("name:a/b");
  });

  describe("carryOverSourceBaseline", () => {
    const previous = () => ({ ...review(), sourceBaselineSha: SHA });

    test("survives a rebuild while the source identity is the same", () => {
      expect(carryOverSourceBaseline(previous(), review())).toBe(SHA);
    });

    test("survives a TARGET change: the target is not part of the identity", () => {
      const retargeted = review({
        pullRequest: { sourceRefName: "refs/heads/feature/login", targetRefName: "refs/heads/release" },
      });
      expect(carryOverSourceBaseline(previous(), retargeted)).toBe(SHA);
    });

    test.each([
      ["another source branch", review({ pullRequest: { sourceRefName: "refs/heads/other" } })],
      [
        "another source repository",
        review({ sourceRepository: { ...review().sourceRepository, id: "200", fullName: "fork/repo" } }),
      ],
      ["another pull request", review({ prKey: "conn-1:acme/repo:8" })],
      ["another connection", review({ connectionId: "conn-2" })],
      ["another provider", review({ provider: "azure-devops" })],
      ["an unknown source repository", review({ sourceRepository: null })],
    ])("is cleared by %s", (_label, next) => {
      expect(carryOverSourceBaseline(previous(), next)).toBe("");
    });

    test("nothing is invented: no previous baseline, a malformed one, or no previous identity yields none", () => {
      expect(carryOverSourceBaseline(review(), review())).toBe("");
      expect(carryOverSourceBaseline({ ...review(), sourceBaselineSha: "not-a-sha" }, review())).toBe("");
      expect(carryOverSourceBaseline({ ...review({ sourceRepository: null }), sourceBaselineSha: SHA }, review())).toBe(
        "",
      );
      expect(carryOverSourceBaseline(null, review())).toBe("");
    });
  });
});
