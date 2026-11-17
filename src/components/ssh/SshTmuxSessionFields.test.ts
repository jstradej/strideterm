import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { DefineComponent } from "vue";
import type { SshTmuxListResult, SshTmuxPreviewResult } from "../../../electron/shared/ssh-tmux.js";
import { apiKey } from "../../types/keys.js";
import SshTmuxSessionFields from "./SshTmuxSessionFields.vue";

const sessions: SshTmuxListResult = {
  ok: true,
  sessions: [{ name: " a team ", windows: 2, attached: true, lastActivityAt: 1_762_511_892_000 }],
};

type TmuxFieldsProps = { hostId: string; remote: boolean; name: string; readOnly: boolean; manualHint: string };

function mountFields(api: object, overrides: Partial<TmuxFieldsProps> = {}) {
  return mount(SshTmuxSessionFields as DefineComponent<TmuxFieldsProps>, {
    props: {
      hostId: "first",
      remote: false,
      manualHint: "Type the exact name.",
      name: "",
      readOnly: false,
      ...overrides,
    },
    global: { provide: { [apiKey]: api } },
  });
}

describe("SSH tmux session fields", () => {
  it("lists only on demand, selects the exact name, and displays preview as plain text", async () => {
    const output = "<img src=x onerror=bad()>\n$ ls\nnotes.txt";
    const sshTmuxList = vi.fn().mockResolvedValue(sessions);
    const sshTmuxPreview = vi.fn().mockResolvedValue({ ok: true, output });
    const fields = mountFields({ sshTmuxList, sshTmuxPreview });
    expect(sshTmuxList).not.toHaveBeenCalled();
    expect(sshTmuxPreview).not.toHaveBeenCalled();

    await fields.get("button").trigger("click");
    await flushPromises();
    expect(sshTmuxList).toHaveBeenCalledWith({ hostId: "first" });
    const session = fields.get("li button");
    expect(session.text()).toContain("2 windows · Attached");
    expect(session.text()).toContain("Last active");
    await session.trigger("click");
    expect(fields.emitted("update:name")).toEqual([[" a team "]]);
    await fields.setProps({ name: " a team " });
    expect(session.attributes("aria-pressed")).toBe("true");
    expect(sshTmuxPreview).not.toHaveBeenCalled();

    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      await fields
        .findAll("button")
        .find((button) => button.text() === "Preview recent output")!
        .trigger("click");
      await flushPromises();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    expect(sshTmuxPreview).toHaveBeenCalledWith({ hostId: "first", name: " a team " });
    expect(fields.get("pre").element.textContent).toBe(output);
    expect(fields.find("img").exists()).toBe(false);
    await fields.get("select").setValue("read-only");
    expect(fields.emitted("update:readOnly")).toEqual([[true]]);
    fields.unmount();
  });

  it("discards earlier host and preview results, and exposes retryable error and empty states", async () => {
    let resolveList!: (_result: SshTmuxListResult) => void;
    let resolvePreview!: (_result: SshTmuxPreviewResult) => void;
    const sshTmuxList = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<SshTmuxListResult>((resolve) => {
          resolveList = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ok: false,
        error: "unavailable",
        message: "Sign in with Built-in SSH to browse sessions.",
      })
      .mockResolvedValueOnce({ ok: true, sessions: [] });
    const sshTmuxPreview = vi.fn().mockReturnValueOnce(
      new Promise<SshTmuxPreviewResult>((resolve) => {
        resolvePreview = resolve;
      }),
    );
    const fields = mountFields({ sshTmuxList, sshTmuxPreview });
    await fields.get("button").trigger("click");
    expect(fields.get('[role="status"]').text()).toContain("Connecting");
    await fields.setProps({ hostId: "second" });
    await fields.get("button").trigger("click");
    await flushPromises();
    expect(fields.get('[role="alert"]').text()).toContain("Built-in SSH");
    expect(fields.find("input").exists()).toBe(true);

    resolveList(sessions);
    await flushPromises();
    expect(fields.find("li").exists()).toBe(false);
    await fields.get("button").trigger("click");
    await flushPromises();
    expect(fields.get('[role="status"]').text()).toContain("No running tmux sessions");
    expect(fields.get("button").text()).toBe("Refresh sessions");
    await fields.setProps({ name: "previous" });
    await fields
      .findAll("button")
      .find((button) => button.text() === "Preview recent output")!
      .trigger("click");

    await fields.setProps({ name: "different" });
    resolvePreview({ ok: true, output: "old output" });
    await flushPromises();
    expect(fields.find("pre").exists()).toBe(false);
    fields.unmount();
  });

  it.each([{ remote: true }, { hostId: "" }])("keeps manual entry available with %j", (overrides) => {
    const fields = mountFields({ sshTmuxList: vi.fn(), sshTmuxPreview: vi.fn() }, { ...overrides, name: "known" });
    expect(fields.find("button").exists()).toBe(false);
    expect(fields.text()).toContain("Type the exact name.");
    expect(fields.get("input").element.value).toBe("known");
    fields.unmount();
  });

  it("cancels only pending probes when a host or name changes and when the field closes", async () => {
    const sshTmuxList = vi.fn((_payload: { requestId?: string }) => new Promise<SshTmuxListResult>(() => {}));
    const sshTmuxPreview = vi.fn((_payload: { requestId?: string }) => new Promise<SshTmuxPreviewResult>(() => {}));
    const sshTmuxCancel = vi.fn().mockResolvedValue(true);
    const fields = mountFields({ sshTmuxList, sshTmuxPreview, sshTmuxCancel }, { name: "example" });
    const previewButton = () => fields.findAll("button").find((button) => button.text() === "Preview recent output")!;
    await fields.get("button").trigger("click");
    const listId = sshTmuxList.mock.calls[0][0].requestId;
    expect(listId).toEqual(expect.any(String));
    await fields.setProps({ hostId: "second" });
    expect(sshTmuxCancel).toHaveBeenLastCalledWith({ requestId: listId });

    await previewButton().trigger("click");
    const firstPreviewId = sshTmuxPreview.mock.calls[0][0].requestId;
    expect(firstPreviewId).toEqual(expect.any(String));
    await fields.setProps({ name: "another" });
    expect(sshTmuxCancel).toHaveBeenLastCalledWith({ requestId: firstPreviewId });

    await previewButton().trigger("click");
    const latestPreviewId = sshTmuxPreview.mock.calls[1][0].requestId;
    expect(latestPreviewId).toEqual(expect.any(String));
    fields.unmount();
    expect(sshTmuxCancel.mock.calls).toEqual([
      [{ requestId: listId }],
      [{ requestId: firstPreviewId }],
      [{ requestId: latestPreviewId }],
    ]);
    expect(new Set([listId, firstPreviewId, latestPreviewId]).size).toBe(3);
  });
});
