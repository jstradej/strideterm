import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DockerDetailLog from "./DockerDetailLog.vue";
import { useAppStore } from "../../../stores/app.js";

/**
 * downloadAll() wiring: real xterm.js is used (no mock) so collectScrollback()
 * reads an actual xterm buffer, matching this repo's approach in
 * DockerDetailShell.test.ts (which also mounts the real Terminal in jsdom).
 *
 * xterm.write() defers its buffer update — writing and then reading
 * term.buffer.active immediately still sees the pre-write (blank) buffer.
 * Fake timers + vi.advanceTimersByTimeAsync() flush that deferred write (and
 * incidentally give the download filename's timestamp a fixed value too).
 */
type WriteHandler = (payload: { sessionId: string; data: string }) => void;
type CloseHandler = (payload: { sessionId: string; code: number | null }) => void;

function makeApi() {
  let writeHandler: WriteHandler | null = null;
  let closeHandler: CloseHandler | null = null;
  return {
    dockerLogsOpen: vi.fn().mockResolvedValue(undefined),
    dockerLogsUpdate: vi.fn().mockResolvedValue({ ok: true }),
    dockerLogsClose: vi.fn().mockResolvedValue(undefined),
    onDockerLogsWrite: (cb: WriteHandler) => {
      writeHandler = cb;
    },
    onDockerLogsClose: (cb: CloseHandler) => {
      closeHandler = cb;
    },
    emitWrite(payload: { sessionId: string; data: string }) {
      writeHandler?.(payload);
    },
    emitClose(payload: { sessionId: string; code: number | null }) {
      closeHandler?.(payload);
    },
  };
}

function mountLog(propsOverrides: Partial<Record<string, unknown>> = {}) {
  const appStore = useAppStore();
  const api = makeApi();
  vi.spyOn(appStore, "getApi").mockReturnValue(api as unknown as ReturnType<typeof appStore.getApi>);
  const wrapper = mount(DockerDetailLog, {
    props: {
      sessionId: "log-session-1",
      containerId: "container-1",
      containerName: "my app",
      backendId: "host",
      contextName: "default",
      ...propsOverrides,
    },
  });
  return { wrapper, api };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DockerDetailLog — downloadAll uses the shared downloadTextFile helper", () => {
  it("downloads the streamed log lines with a filename derived from the container name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));

    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let capturedDownload = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      capturedDownload = this.download;
    });

    const { wrapper, api } = mountLog();
    await flushPromises();

    // Simulate log data arriving via the transport's write-callback registration.
    api.emitWrite({ sessionId: "log-session-1", data: "line one\r\n" });
    api.emitWrite({ sessionId: "log-session-1", data: "line two\r\n" });
    // Flush xterm's deferred write-buffer processing.
    await vi.advanceTimersByTimeAsync(50);

    const downloadBtn = wrapper.find('button[title="Download scrollback as .log file"]');
    expect(downloadBtn.exists()).toBe(true);
    await downloadBtn.trigger("click");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/plain");
    const text = await blob.text();
    expect(text).toContain("line one");
    expect(text).toContain("line two");
    expect(capturedDownload).toBe("my_app-2026-07-20T10-00-00.log");
  });

  it("ignores data for a foreign session so a stale stream can't pollute the download", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"));

    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { wrapper, api } = mountLog();
    await flushPromises();

    api.emitWrite({ sessionId: "some-other-session", data: "should not appear\r\n" });
    await vi.advanceTimersByTimeAsync(50);

    const downloadBtn = wrapper.find('button[title="Download scrollback as .log file"]');
    await downloadBtn.trigger("click");

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await blob.text();
    expect(text).not.toContain("should not appear");
  });
});
