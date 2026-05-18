import { describe, it, expect, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerVolumeBrowse from "./DockerVolumeBrowse.vue";

const MOCK_LS = `total 16
drwxr-xr-x    4 root     root          4096 Jan  1 12:34 .
drwxr-xr-x    3 root     root          4096 Jan  1 12:34 ..
drwxr-xr-x    2 root     root          4096 Jan  1 12:34 data
-rw-r--r--    1 root     root           512 Jan  1 12:34 config.yml
-rw-r--r--    1 root     root             0 Jan  1 12:34 empty.txt
lrwxrwxrwx    1 root     root             7 Jan  1 12:34 alias -> data/x
-rw-r--r--    1 root     root         12345 Jan  1 12:34 file with spaces.log`;

describe("DockerVolumeBrowse — visual + parsing", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders breadcrumb at volume root", async () => {
    const wrapper = mount(DockerVolumeBrowse, {
      props: { volumeName: "myvol", backendId: "host", contextName: "default", mockListing: MOCK_LS },
    });
    await flushPromises();
    expect(wrapper.find(".vol-browse__crumb--root").text()).toContain("myvol");
  });

  it("parses busybox `ls -la` output and lists entries sorted dirs-first", async () => {
    const wrapper = mount(DockerVolumeBrowse, {
      props: { volumeName: "myvol", backendId: "host", contextName: "default", mockListing: MOCK_LS },
    });
    await flushPromises();
    const rows = wrapper.findAll(".vol-browse__row");
    // 1 dir + 3 files + 1 link = 5 entries (. and .. filtered)
    expect(rows.length).toBe(5);

    const names = rows.map((r) =>
      r
        .find(".vol-browse__name")
        .text()
        .replace(/\s+→.+$/, "")
        .trim(),
    );
    // dir first, then files alphabetically (config, empty, file w/ spaces), then link mixed in by type
    expect(names[0]).toContain("data");
  });

  it("shows symlink target with arrow", async () => {
    const wrapper = mount(DockerVolumeBrowse, {
      props: { volumeName: "myvol", backendId: "host", contextName: "default", mockListing: MOCK_LS },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("alias");
    expect(wrapper.text()).toContain("→");
    expect(wrapper.text()).toContain("data/x");
  });

  it("formats file sizes in human-readable units", async () => {
    const wrapper = mount(DockerVolumeBrowse, {
      props: { volumeName: "myvol", backendId: "host", contextName: "default", mockListing: MOCK_LS },
    });
    await flushPromises();
    const text = wrapper.text();
    // 512 → "512 B"
    expect(text).toContain("512 B");
    // 12345 → "12.1 KiB"
    expect(text).toContain("12.1 KiB");
  });

  it("treats 'No such file or directory' output as error state", async () => {
    const wrapper = mount(DockerVolumeBrowse, {
      props: {
        volumeName: "myvol",
        backendId: "host",
        contextName: "default",
        mockListing: "ls: /missing: No such file or directory\n",
      },
    });
    await flushPromises();
    expect(wrapper.find(".vol-browse__error").exists()).toBe(true);
  });

  it("renders empty state when listing has only `.` and `..`", async () => {
    const empty = `total 8
drwxr-xr-x    2 root     root          4096 Jan  1 12:34 .
drwxr-xr-x    3 root     root          4096 Jan  1 12:34 ..
`;
    const wrapper = mount(DockerVolumeBrowse, {
      props: { volumeName: "myvol", backendId: "host", contextName: "default", mockListing: empty },
    });
    await flushPromises();
    expect(wrapper.find(".vol-browse__empty").exists()).toBe(true);
  });

  it("handles filenames that contain spaces", async () => {
    const wrapper = mount(DockerVolumeBrowse, {
      props: { volumeName: "myvol", backendId: "host", contextName: "default", mockListing: MOCK_LS },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("file with spaces.log");
  });

  it("ignores `total N` summary line", async () => {
    const wrapper = mount(DockerVolumeBrowse, {
      props: { volumeName: "myvol", backendId: "host", contextName: "default", mockListing: MOCK_LS },
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain("total 16");
  });
});
