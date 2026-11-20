import { afterEach, describe, expect, it, vi } from "vitest";
import { readTerminalFontSize, terminalFontSizeKey, writeTerminalFontSize } from "./terminal-font-size.js";
import { setWindowBackend, windowBackend } from "../window-backend.js";

const settings = { terminalFontSizeLocal: 14, terminalFontSizeRemote: 18 };

function peer(terminalFontSize: number) {
  setWindowBackend({
    kind: "peer",
    hostId: "host-0001",
    hostLabel: "Studio Mac",
    remoteProfileId: "work",
    clientId: "peer-window-0001",
    terminalFontSize,
  });
}

describe("terminal font size per window kind", () => {
  afterEach(() => {
    setWindowBackend({ kind: "local" });
    delete (window as unknown as Record<string, unknown>).strideterm;
  });

  describe("local desktop window", () => {
    it("reads and writes terminalFontSizeLocal", async () => {
      const update = vi.fn();
      expect(terminalFontSizeKey(false)).toBe("terminalFontSizeLocal");
      expect(readTerminalFontSize(settings, false)).toBe(14);

      await writeTerminalFontSize(16, false, update);
      expect(update).toHaveBeenCalledWith({ terminalFontSizeLocal: 16 });
    });
  });

  describe("web or mobile client", () => {
    it("reads and writes terminalFontSizeRemote", async () => {
      const update = vi.fn();
      expect(terminalFontSizeKey(true)).toBe("terminalFontSizeRemote");
      expect(readTerminalFontSize(settings, true)).toBe(18);

      await writeTerminalFontSize(20, true, update);
      expect(update).toHaveBeenCalledWith({ terminalFontSizeRemote: 20 });
    });

    it("has no stored size to read until one is saved", () => {
      expect(readTerminalFontSize({}, true)).toBeUndefined();
    });
  });

  describe("window attached to another desktop", () => {
    it("reads the size the window booted with, not the host's settings", () => {
      peer(15);
      expect(readTerminalFontSize(settings, true)).toBe(15);
    });

    it("writes through the preload only, never to the host's settings, and keeps the new size", async () => {
      peer(15);
      const setPeerWindowFontSize = vi.fn().mockResolvedValue(undefined);
      (window as unknown as Record<string, unknown>).strideterm = { setPeerWindowFontSize };
      const update = vi.fn();

      await writeTerminalFontSize(19, true, update);

      expect(setPeerWindowFontSize).toHaveBeenCalledWith(19);
      expect(update).not.toHaveBeenCalled();
      expect(readTerminalFontSize(settings, true)).toBe(19);
      expect(windowBackend.value).toMatchObject({ kind: "peer", terminalFontSize: 19, hostId: "host-0001" });
    });

    it("still updates in memory when the preload has no setter, and calls nothing on the host", async () => {
      peer(15);
      (window as unknown as Record<string, unknown>).strideterm = {};
      const update = vi.fn();

      await writeTerminalFontSize(11, true, update);

      expect(update).not.toHaveBeenCalled();
      expect(readTerminalFontSize(settings, true)).toBe(11);
    });

    it("rejects when the main process refuses the size so the caller can report it", async () => {
      peer(15);
      (window as unknown as Record<string, unknown>).strideterm = {
        setPeerWindowFontSize: vi.fn().mockRejectedValue(new Error("refused")),
      };
      await expect(writeTerminalFontSize(12, true, undefined)).rejects.toThrow("refused");
    });
  });
});
