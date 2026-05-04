import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { injectAzureMocks, injectGitHubMocks, injectAllMocks, maybeApplyMockFromUrl } from "./dev-mocks.js";

describe("dev-mocks", () => {
  test("injectAzureMocks adds connections, inbox, and a sample PR detail", () => {
    const result = injectAzureMocks({ existing: "preserved" });
    expect(result?.existing).toBe("preserved");
    const ado = result?.azureDevops;
    expect(Array.isArray(ado.connections)).toBe(true);
    expect(ado.connections.length).toBe(1);
    expect(ado.inbox.recentlyUpdated.length).toBeGreaterThan(0);
    expect(ado.inbox.needsAttention.length).toBeGreaterThan(0);
    // The detail PR is keyed by prKey so AzureReviewPane selectors find it.
    expect(ado.pullRequests["azure:1001"]).toBeTruthy();
    expect(ado.pullRequests["azure:1001"].changedFiles.length).toBeGreaterThan(0);
  });

  test("injectAzureMocks does not crash on null payload", () => {
    expect(injectAzureMocks(null)).toBeNull();
  });

  test("injectGitHubMocks adds connections, inbox, and a sample PR detail", () => {
    const result = injectGitHubMocks({});
    expect(result?.github?.connections?.length).toBe(1);
    expect(result?.github?.inbox?.recentlyUpdated?.length).toBeGreaterThan(0);
    expect(result?.github?.pullRequests?.["github:42"]).toBeTruthy();
  });

  test("injectAllMocks combines both", () => {
    const result = injectAllMocks({});
    expect(result?.azureDevops?.connections?.length).toBe(1);
    expect(result?.github?.connections?.length).toBe(1);
  });

  describe("maybeApplyMockFromUrl", () => {
    const originalLocation = window.location;

    beforeEach(() => {
      // Patch window.location.hash for these tests; restore afterwards.
      Object.defineProperty(window, "location", {
        value: { ...originalLocation, hash: "" },
        writable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", { value: originalLocation, writable: true });
      vi.restoreAllMocks();
    });

    test("returns the payload unchanged when no #mock= is present", () => {
      window.location.hash = "";
      const input = { x: 1 };
      expect(maybeApplyMockFromUrl(input)).toBe(input);
    });

    test("#mock=azure injects azureDevops snapshot", () => {
      window.location.hash = "#mock=azure";
      const result = maybeApplyMockFromUrl({});
      expect(result?.azureDevops?.connections?.length).toBe(1);
      expect(result?.github).toBeUndefined();
    });

    test("#mock=github injects github snapshot", () => {
      window.location.hash = "#mock=github";
      const result = maybeApplyMockFromUrl({});
      expect(result?.github?.connections?.length).toBe(1);
      expect(result?.azureDevops).toBeUndefined();
    });

    test("#mock=both injects both", () => {
      window.location.hash = "#mock=both";
      const result = maybeApplyMockFromUrl({});
      expect(result?.azureDevops?.connections?.length).toBe(1);
      expect(result?.github?.connections?.length).toBe(1);
    });

    test("#mock=clear leaves payload alone", () => {
      window.location.hash = "#mock=clear";
      const input = { existing: true };
      expect(maybeApplyMockFromUrl(input)).toBe(input);
    });

    test("returns null payload as-is", () => {
      window.location.hash = "#mock=both";
      expect(maybeApplyMockFromUrl(null)).toBeNull();
    });
  });
});
