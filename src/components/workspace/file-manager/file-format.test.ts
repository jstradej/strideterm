import { describe, expect, it } from "vitest";
import { formatSize } from "./file-format.js";

/**
 * formatSize was byte-identically duplicated in FileListItem.vue and
 * FilePreview.vue. This is the shared implementation both were migrated to.
 */
describe("formatSize", () => {
  it("formats sub-KB sizes in bytes", () => {
    expect(formatSize(512)).toBe("512 B");
  });

  it("formats zero bytes", () => {
    expect(formatSize(0)).toBe("0 B");
  });

  it("formats KB-range sizes with one decimal", () => {
    expect(formatSize(2048)).toBe("2.0 KB");
  });

  it("formats MB-range sizes with one decimal", () => {
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("returns an empty string for missing/undefined input", () => {
    expect(formatSize(undefined as unknown as number)).toBe("");
    expect(formatSize(null as unknown as number)).toBe("");
  });
});
