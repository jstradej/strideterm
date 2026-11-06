import { describe, expect, it } from "vitest";
import { sameProviderRepository } from "./jira-repo-identity.js";

describe("provider repository remote identity", () => {
  it("accepts matching GitHub HTTPS and SSH clone URLs", () => {
    expect(sameProviderRepository("github", "https://github.com/acme/app.git", "git@github.com:acme/app.git")).toBe(
      true,
    );
    expect(sameProviderRepository("github", "https://github.com/acme/app", "git@github.com:other/app.git")).toBe(false);
  });
  it("accepts matching Azure DevOps HTTPS and SSH clone URLs", () => {
    expect(
      sameProviderRepository(
        "azure",
        "https://dev.azure.com/acme/platform/_git/app",
        "git@ssh.dev.azure.com:v3/acme/platform/app",
      ),
    ).toBe(true);
    expect(
      sameProviderRepository(
        "azure",
        "https://acme.visualstudio.com/platform/_git/app",
        "git@ssh.dev.azure.com:v3/acme/platform/app",
      ),
    ).toBe(true);
    expect(
      sameProviderRepository(
        "azure",
        "https://dev.azure.com/acme/platform/_git/app",
        "https://dev.azure.com/other/platform/_git/app",
      ),
    ).toBe(false);
  });
});
