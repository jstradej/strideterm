import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import SftpConflictDialog from "./SftpConflictDialog.vue";
import SftpDownloadTargetDialog from "./SftpDownloadTargetDialog.vue";

describe("SftpConflictDialog", () => {
  test("names the conflicts and answers with the chosen policy", async () => {
    const wrapper = mount(SftpConflictDialog, { props: { conflicts: ["/srv/a.txt", "/srv/b.txt"] } });
    expect(wrapper.text()).toContain("2 items already exist");
    expect(wrapper.text()).toContain("/srv/a.txt");

    await wrapper.find('[data-testid="sftp-conflict-overwrite"]').trigger("click");
    await wrapper.find('[data-testid="sftp-conflict-skip"]').trigger("click");
    await wrapper.find('[data-testid="sftp-conflict-cancel"]').trigger("click");
    expect(wrapper.emitted("choose")).toEqual([["overwrite"], ["skip"]]);
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  test("a long list is cut and says how many more", () => {
    const conflicts = Array.from({ length: 12 }, (_, index) => `/srv/f${index}`);
    const wrapper = mount(SftpConflictDialog, { props: { conflicts } });
    expect(wrapper.text()).toContain("… and 4 more");
  });
});

describe("SftpDownloadTargetDialog", () => {
  test("submits the chosen workspace folder with the sub-folder joined to it", async () => {
    const wrapper = mount(SftpDownloadTargetDialog, { props: { roots: ["/work/app", "/work/lib"] } });
    await wrapper.find('[data-testid="sftp-download-root"]').setValue("/work/lib");
    await wrapper.find('[data-testid="sftp-download-subfolder"]').setValue("out/logs");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toEqual([["/work/lib/out/logs"]]);
  });

  test("a sub-folder that climbs out is refused in the dialog", async () => {
    const wrapper = mount(SftpDownloadTargetDialog, { props: { roots: ["/work/app"] } });
    await wrapper.find('[data-testid="sftp-download-subfolder"]').setValue("../../etc");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeUndefined();
    expect(wrapper.find('[data-testid="sftp-download-error"]').text()).toContain("inside the workspace folder");
  });
});
