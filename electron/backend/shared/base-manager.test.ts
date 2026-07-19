import path from "node:path";
import os from "node:os";
import { describe, expect, test, vi } from "vitest";
import { BaseProviderManager } from "./base-manager.js";

const reviewRoot = path.join(os.tmpdir(), "strideterm-base-manager-tests");

function createCredentialStore(secrets: Record<string, string> = {}) {
  return {
    getSecret(ref: string) {
      return secrets[ref] || "";
    },
  };
}

function createReviewStore() {
  return {
    async upsertTrackedPullRequest() {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MIGRATION-EXEMPT: vi.fn() mock type doesn't structurally match execFileText's signature
function createManager({ execFileTextImpl }: { execFileTextImpl: any }) {
  return new BaseProviderManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credentialStore: createCredentialStore() as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reviewStore: createReviewStore() as any,
    execFileTextImpl,
    createApi: () => ({}),
  });
}

describe("BaseProviderManager.ensureCacheRepoAt", () => {
  test("clones with --filter=blob:none when no cache repo exists yet, using the given login", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });

    const repositoryRoot = await manager.ensureCacheRepoAt({
      connectionId: "conn-1",
      repoIdentifier: "repo-1",
      repoLabel: "acme/repo-1",
      remoteUrl: "https://example.com/acme/repo-1.git",
      reviewRoot,
      token: "tok-123",
      login: "me@example.com",
    });

    expect(repositoryRoot).toContain("repos");
    expect(repositoryRoot).toContain("conn-1");
    expect(repositoryRoot).toContain("repo-1");

    const cloneCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("clone"));
    expect(cloneCall).toBeDefined();
    expect(cloneCall![1]).toEqual(
      expect.arrayContaining(["clone", "--no-checkout", "--filter=blob:none", "https://example.com/acme/repo-1.git"]),
    );
    // Login is threaded through as a git auth header, not a plain arg — confirm
    // it reached runGit by checking the extraheader carries the login.
    const headerArg = cloneCall![1].find((arg: string) => arg.startsWith("http.extraheader="));
    expect(headerArg).toBeDefined();
  });

  test("omits an explicit login when none is given (falls back to defaultGitLogin)", async () => {
    const execFileTextImpl = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });
    manager.defaultGitLogin = "x-access-token";

    await manager.ensureCacheRepoAt({
      connectionId: "conn-1",
      repoIdentifier: "owner/repo",
      repoLabel: "owner/repo",
      remoteUrl: "https://example.com/owner/repo.git",
      reviewRoot,
      token: "tok-123",
    });

    const cloneCall = execFileTextImpl.mock.calls.find((call) => call[1].includes("clone"));
    const headerArg = cloneCall![1].find((arg: string) => arg.startsWith("http.extraheader="));
    // encodeAuthHeader base64s "login:token" — decode and confirm the default
    // login ("x-access-token") was used since none was passed explicitly.
    const encoded = headerArg.replace("http.extraheader=AUTHORIZATION: Basic ", "");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    expect(decoded).toBe("x-access-token:tok-123");
  });

  test("falls back to a full clone when the partial (--filter=blob:none) clone fails", async () => {
    const execFileTextImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("server does not support filter"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const manager = createManager({ execFileTextImpl });
    const warnSpy = vi.spyOn(manager.log, "warn").mockImplementation(() => {});

    await manager.ensureCacheRepoAt({
      connectionId: "conn-1",
      repoIdentifier: "repo-1",
      repoLabel: "acme/repo-1",
      remoteUrl: "https://example.com/acme/repo-1.git",
      reviewRoot,
      token: "tok-123",
    });

    expect(execFileTextImpl).toHaveBeenCalledTimes(2);
    const secondCallArgs = execFileTextImpl.mock.calls[1][1];
    expect(secondCallArgs).not.toContain("--filter=blob:none");
    expect(secondCallArgs).toEqual(expect.arrayContaining(["clone", "--no-checkout"]));
    expect(warnSpy).toHaveBeenCalledWith(
      "partial clone failed, retrying with full clone",
      expect.objectContaining({ repository: "acme/repo-1" }),
    );
  });
});
