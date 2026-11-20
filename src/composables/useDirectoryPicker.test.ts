import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useDirectoryPicker } from "./useDirectoryPicker.js";
import { useAppStore } from "../stores/app.js";
import { setWindowBackend } from "../window-backend.js";
import type { Transport } from "../transport.js";

const asApi = (value: Record<string, unknown>) => value as unknown as Transport;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  setWindowBackend({ kind: "local" });
});

describe("useDirectoryPicker", () => {
  test("local window with a native picker uses it", async () => {
    const browseDirectory = vi.fn().mockResolvedValue("/picked");
    const picker = useDirectoryPicker(asApi({ browseDirectory }));
    expect(picker.canBrowse.value).toBe(true);
    expect(picker.browsingHost.value).toBe(false);
    expect(await picker.pickDirectory("/start")).toBe("/picked");
    expect(browseDirectory).toHaveBeenCalledWith("/start");
  });

  test("web client without any picker offers nothing", async () => {
    const picker = useDirectoryPicker(asApi({}));
    expect(picker.canBrowse.value).toBe(false);
    expect(await picker.pickDirectory()).toBeNull();
  });

  test("attached window uses the host browser and never the native picker", async () => {
    setWindowBackend({ kind: "peer", hostLabel: "Office" } as never);
    const browseDirectory = vi.fn();
    const picker = useDirectoryPicker(asApi({ browseDirectory, listHostDirectories: vi.fn() }));
    expect(picker.canBrowse.value).toBe(true);
    expect(picker.hostLabel.value).toBe("Office");
    const app = useAppStore();
    vi.spyOn(app, "backDialog").mockImplementation(() => {});
    vi.spyOn(app, "openSubDialog").mockImplementation((_name, props) =>
      (props as { onSelect: (p: string) => void }).onSelect("C:\\Work"),
    );
    expect(await picker.pickDirectory("")).toBe("C:\\Work");
    expect(browseDirectory).not.toHaveBeenCalled();
  });

  test("attached window whose host cannot list folders offers nothing", () => {
    setWindowBackend({ kind: "peer", hostLabel: "Office" } as never);
    const picker = useDirectoryPicker(asApi({ browseDirectory: vi.fn() }));
    expect(picker.canBrowse.value).toBe(false);
  });
});
