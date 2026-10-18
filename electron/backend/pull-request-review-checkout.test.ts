import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AzureDevOpsManager } from "./azure-devops-manager.js";
import { GitHubManager } from "./github-manager.js";
import { createAzureReviewStore } from "./azure-review-store.js";
import { execFileText } from "./process-utils.js";

type GitHubOptions = NonNullable<ConstructorParameters<typeof GitHubManager>[0]>;
type AzureOptions = NonNullable<ConstructorParameters<typeof AzureDevOpsManager>[0]>;
const directories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileText(
    "git",
    ["-c", "user.name=Review Test", "-c", "user.email=review@example.com", ...args],
    { cwd },
  );
  return result.stdout.trim();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith("strideterm-pr-checkout-")
    ) {
      throw new Error("Refusing to remove an unexpected fixture directory.");
    }
    await fs.rm(target, { recursive: true, force: true });
  }
});

test.each(["github", "azure-devops"] as const)(
  "%s automated reviews create separate real worktrees and preserve existing edits",
  async (provider) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-pr-checkout-"));
    directories.push(root);
    const seed = path.join(root, "seed");
    const cache = path.join(root, "cache");
    await git(root, ["init", "-b", "main", seed]);
    await fs.writeFile(path.join(seed, "tracked.txt"), "base\n");
    await git(seed, ["add", "."]);
    await git(seed, ["commit", "-m", "base"]);
    await git(seed, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(seed, "tracked.txt"), "feature\n");
    await git(seed, ["commit", "-am", "feature"]);
    const sourceHead = await git(seed, ["rev-parse", "HEAD"]);
    await git(root, ["clone", seed, cache]);

    const reviewStore = await createAzureReviewStore(path.join(root, "review.json"));
    const credentialStore = {
      getSecret: () => "fixture-token",
      setSecret: async () => {},
      hasSecret: () => true,
      deleteSecret: async () => {},
      listRefs: () => ["test:token"],
      isEncryptionAvailable: () => true,
    };
    const manager =
      provider === "github"
        ? new GitHubManager({
            credentialStore: credentialStore as GitHubOptions["credentialStore"],
            reviewStore: reviewStore as unknown as GitHubOptions["reviewStore"],
          })
        : new AzureDevOpsManager({
            credentialStore: credentialStore as AzureOptions["credentialStore"],
            reviewStore: reviewStore as unknown as AzureOptions["reviewStore"],
          });
    vi.spyOn(manager, "ensureCacheRepo").mockResolvedValue(cache);
    const options = {
      summary: {
        prKey: "connection:repo:42",
        connectionId: "connection",
        repository: { id: "repo", owner: "acme", name: "web", remoteUrl: "https://github.com/acme/web.git" },
        project: { id: "project", name: "Team" },
        pullRequest: { id: 42, number: 42, sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main" },
      },
      connection: {
        id: "connection",
        hostUrl: "https://github.com",
        orgUrl: "https://dev.azure.com/acme",
        login: "me@example.com",
        tokenRef: "test:token",
      },
      token: "fixture-token",
      reviewRoot: path.join(root, "review-root"),
    };
    const prepare = (isolatedId?: string) =>
      manager instanceof GitHubManager
        ? manager.prepareManagedReviewCheckout({ ...options, isolatedId })
        : manager.prepareManagedReviewCheckout({ ...options, isolatedId });

    const existing = await prepare();
    await fs.writeFile(path.join(existing.rootPath, "tracked.txt"), "do not alter my edits\n");
    const existingBranch = await git(existing.rootPath, ["branch", "--show-current"]);
    const first = await prepare("first");
    const second = await prepare("second");

    expect(new Set([existing.rootPath, first.rootPath, second.rootPath]).size).toBe(3);
    expect(await git(first.rootPath, ["branch", "--show-current"])).not.toBe(
      await git(second.rootPath, ["branch", "--show-current"]),
    );
    for (const checkout of [existing, first, second]) {
      expect(checkout.mode).toBe("managed-worktree");
      expect(await git(checkout.rootPath, ["rev-parse", "HEAD"])).toBe(sourceHead);
    }
    expect(await git(first.rootPath, ["status", "--porcelain"])).toBe("");
    expect(await git(second.rootPath, ["status", "--porcelain"])).toBe("");
    expect(await git(existing.rootPath, ["branch", "--show-current"])).toBe(existingBranch);
    expect(await fs.readFile(path.join(existing.rootPath, "tracked.txt"), "utf8")).toBe("do not alter my edits\n");
    expect(await git(existing.rootPath, ["status", "--porcelain"])).toContain("tracked.txt");
  },
);
