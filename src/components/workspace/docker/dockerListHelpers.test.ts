import { describe, expect, test } from "vitest";
import { parseDockerSize, bulkConfirmMessage, pruneSummary, imageRowKey } from "./dockerListHelpers.js";

describe("parseDockerSize", () => {
  test("empty / nullish returns 0", () => {
    expect(parseDockerSize("")).toBe(0);
    expect(parseDockerSize(undefined)).toBe(0);
    expect(parseDockerSize(null)).toBe(0);
    expect(parseDockerSize("   ")).toBe(0);
  });

  test("bare bytes", () => {
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("512B")).toBe(512);
    expect(parseDockerSize("999 B")).toBe(999);
  });

  test("SI units (docker default)", () => {
    expect(parseDockerSize("1kB")).toBe(1000);
    expect(parseDockerSize("1MB")).toBe(1_000_000);
    expect(parseDockerSize("1.5GB")).toBe(1_500_000_000);
    expect(parseDockerSize("471MB")).toBe(471_000_000);
  });

  test("binary (IEC) units", () => {
    expect(parseDockerSize("1KiB")).toBe(1024);
    expect(parseDockerSize("2MiB")).toBe(2 * 1024 * 1024);
  });

  test("unparseable input returns 0 (so sort doesn't crash)", () => {
    expect(parseDockerSize("a long time ago")).toBe(0);
    expect(parseDockerSize("--")).toBe(0);
  });

  test("ordering — the load-bearing property for sort", () => {
    const sizes = ["123MB", "1.2GB", "10kB", "1B", "999MB"];
    const sorted = [...sizes].sort((a, b) => parseDockerSize(a) - parseDockerSize(b));
    expect(sorted).toEqual(["1B", "10kB", "123MB", "999MB", "1.2GB"]);
  });
});

describe("bulkConfirmMessage", () => {
  test("includes the list inline", () => {
    const msg = bulkConfirmMessage("Remove", ["redis:7", "postgres:14"]);
    expect(msg).toContain("Remove 2 items?");
    expect(msg).toContain("• redis:7");
    expect(msg).toContain("• postgres:14");
  });

  test("collapses long lists with '…and N more'", () => {
    const names = Array.from({ length: 15 }, (_, i) => `image-${i}`);
    const msg = bulkConfirmMessage("Remove", names);
    expect(msg).toContain("• image-0");
    expect(msg).toContain("• image-9");
    expect(msg).not.toContain("• image-10");
    expect(msg).toContain("…and 5 more");
  });

  test("appends the optional suffix on its own line", () => {
    const msg = bulkConfirmMessage("Remove", ["a"], "Cannot be undone.");
    expect(msg.endsWith("Cannot be undone.")).toBe(true);
  });

  test("singular vs plural", () => {
    expect(bulkConfirmMessage("Remove", ["a"])).toContain("Remove 1 item?");
    expect(bulkConfirmMessage("Remove", ["a", "b"])).toContain("Remove 2 items?");
  });
});

describe("imageRowKey", () => {
  test("same image ID with different tags produces distinct keys", () => {
    const sameId = "sha256:abc123";
    const a = imageRowKey({ ID: sameId, Repository: "redis", Tag: "7" });
    const b = imageRowKey({ ID: sameId, Repository: "redis", Tag: "latest" });
    const c = imageRowKey({ ID: sameId, Repository: "redis", Tag: "alpine" });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("dangling images (same <none>:<none>) with different IDs are distinct", () => {
    const a = imageRowKey({ ID: "sha256:111", Repository: "<none>", Tag: "<none>" });
    const b = imageRowKey({ ID: "sha256:222", Repository: "<none>", Tag: "<none>" });
    expect(a).not.toBe(b);
  });

  test("rendered list of mixed-tag rows is fully distinct (regression: Vue keyed diff)", () => {
    // Reproduces the user-observed shape: docker images --format lists one
    // line per tag, so an image with N tags appears N times. Keys must be
    // unique across the whole list or sort toggles scramble the DOM.
    const rows = [
      { ID: "sha256:aaa", Repository: "kafka", Tag: "7.6.1" },
      { ID: "sha256:aaa", Repository: "kafka", Tag: "latest" }, // same ID, second tag
      { ID: "sha256:bbb", Repository: "es", Tag: "7.17.22" },
      { ID: "sha256:bbb", Repository: "es", Tag: "9.2.4" },
      { ID: "sha256:ccc", Repository: "<none>", Tag: "<none>" },
      { ID: "sha256:ddd", Repository: "<none>", Tag: "<none>" },
    ];
    const keys = rows.map(imageRowKey);
    expect(new Set(keys).size).toBe(rows.length);
  });
});

describe("pruneSummary", () => {
  test("zero deletes — no reclaimed", () => {
    expect(pruneSummary([], "")).toBe("Nothing to delete.");
  });

  test("zero deletes — reclaimed amount mentioned (rare but printed by docker on some kinds)", () => {
    expect(pruneSummary([], "100MB")).toBe("Nothing to delete, freed 100MB.");
  });

  test("non-zero deletes, with reclaimed", () => {
    expect(pruneSummary(["a", "b", "c"], "1.5GB")).toBe("Removed 3 items, freed 1.5GB.");
  });

  test("single delete uses singular noun", () => {
    expect(pruneSummary(["a"], "12MB")).toBe("Removed 1 item, freed 12MB.");
  });

  test("0B reclaimed is suppressed (docker prints this for network prune)", () => {
    expect(pruneSummary(["net1"], "0B")).toBe("Removed 1 item.");
  });
});
