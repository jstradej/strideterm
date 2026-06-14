import { describe, expect, test } from "vitest";
import { resolveBaseRef, isRemoteRef, shortBranchName } from "./base-ref.js";

const BRANCHES = ["develop", "origin/develop", "feature/x", "origin/feature/x", "main", "origin/main"];
const REMOTES = ["origin"];

describe("isRemoteRef", () => {
  test("matches configured remote prefix", () => {
    expect(isRemoteRef("origin/develop", REMOTES)).toBe(true);
    expect(isRemoteRef("vk/feature", ["origin", "vk"])).toBe(true);
  });
  test("plain or unknown-prefix refs are local", () => {
    expect(isRemoteRef("develop", REMOTES)).toBe(false);
    expect(isRemoteRef("feature/x", REMOTES)).toBe(false); // "feature" is not a remote
    expect(isRemoteRef("", REMOTES)).toBe(false);
  });
});

describe("shortBranchName", () => {
  test("strips remote prefix only", () => {
    expect(shortBranchName("origin/develop", REMOTES)).toBe("develop");
    expect(shortBranchName("feature/x", REMOTES)).toBe("feature/x");
    expect(shortBranchName("develop", REMOTES)).toBe("develop");
  });
});

describe("resolveBaseRef", () => {
  test("local selection prefers the remote-tracking counterpart", () => {
    const r = resolveBaseRef("develop", BRANCHES, REMOTES, "origin");
    expect(r.localRef).toBe("develop");
    expect(r.remoteRef).toBe("origin/develop");
    expect(r.opRef).toBe("origin/develop");
    expect(r.isRemote).toBe(true);
    expect(r.isLocalOnly).toBe(false);
  });

  test("remote selection stays remote", () => {
    const r = resolveBaseRef("origin/develop", BRANCHES, REMOTES, "origin");
    expect(r.opRef).toBe("origin/develop");
    expect(r.shortName).toBe("develop");
    expect(r.localRef).toBe("develop");
    expect(r.isLocalOnly).toBe(false);
  });

  test("no remote counterpart falls back to local-only", () => {
    const r = resolveBaseRef("develop", ["develop", "feature/x"], REMOTES, "origin");
    expect(r.remoteRef).toBe("");
    expect(r.opRef).toBe("develop");
    expect(r.isRemote).toBe(false);
    expect(r.isLocalOnly).toBe(true);
  });

  test("nested branch names resolve through the remote prefix", () => {
    const r = resolveBaseRef("feature/x", BRANCHES, REMOTES, "origin");
    expect(r.opRef).toBe("origin/feature/x");
    expect(r.localRef).toBe("feature/x");
  });

  test("default remote wins over origin when both carry the branch", () => {
    const branches = ["develop", "origin/develop", "vk/develop"];
    const r = resolveBaseRef("develop", branches, ["origin", "vk"], "vk");
    expect(r.opRef).toBe("vk/develop");
  });

  test("empty selection yields an empty resolution", () => {
    const r = resolveBaseRef("", BRANCHES, REMOTES, "origin");
    expect(r.opRef).toBe("");
    expect(r.isLocalOnly).toBe(true);
  });

  test("selection with no known branches trusts itself", () => {
    const r = resolveBaseRef("develop", [], [], "");
    expect(r.opRef).toBe("develop");
    expect(r.isLocalOnly).toBe(true);
  });
});
