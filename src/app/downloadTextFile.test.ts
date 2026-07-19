import { describe, expect, it, vi, afterEach } from "vitest";
import { downloadTextFile } from "./helpers.js";

/**
 * downloadTextFile was duplicated (Blob + object URL + synthetic anchor
 * click) across TaskDashboardLogTab.vue, DockerDetailLog.vue,
 * AzureAuditLog.vue and AzurePipelinesTab.vue. This is the shared
 * implementation (already used by the terminal transcript export feature)
 * those four call sites were migrated to.
 */
describe("downloadTextFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("builds a Blob with the given content and mime, and triggers a synthetic anchor click", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadTextFile("report.csv", "a,b,c\n1,2,3", "text/csv;charset=utf-8");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // revokeObjectURL is deferred via setTimeout(..., 0) so the click has a
    // chance to grab the blob first.
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("defaults to text/plain;charset=utf-8 when no mime is given", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadTextFile("notes.txt", "hello");

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/plain;charset=utf-8");
  });

  it("sets the anchor's download attribute to the given filename", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let capturedDownload = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download;
    });

    downloadTextFile("my-export.json", "{}", "application/json");

    expect(capturedDownload).toBe("my-export.json");
  });

  it("does not leave the synthetic anchor attached to the DOM", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadTextFile("x.txt", "content");

    expect(document.body.querySelector("a[download]")).toBeNull();
  });
});
