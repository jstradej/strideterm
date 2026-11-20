import { isPeerWindow, setWindowBackend, windowBackend } from "../window-backend.js";

export const DEFAULT_TERMINAL_FONT_SIZE = 13;

/**
 * Terminal font size is a per-client preference, kept apart for each kind of window so that a desktop and a phone
 * showing one installation never overwrite each other: the desktop's own window and a browser/phone client use
 * their own settings keys, and a window attached to another desktop uses neither of the HOST's keys — the host
 * refuses `terminalFontSizeLocal` from a remote client and `terminalFontSizeRemote` is the web/mobile value. Its
 * size is this machine's own `terminalFontSizeLocal`, handed over at boot and written back through the preload.
 */
export function terminalFontSizeKey(isRemote: boolean | undefined): "terminalFontSizeLocal" | "terminalFontSizeRemote" {
  return isRemote ? "terminalFontSizeRemote" : "terminalFontSizeLocal";
}

/** `undefined` when nothing is stored yet; callers fall back to `DEFAULT_TERMINAL_FONT_SIZE`. */
export function readTerminalFontSize(settings: unknown, isRemote: boolean | undefined): number | undefined {
  const backend = windowBackend.value;
  if (backend.kind === "peer") {
    const size = (backend as { terminalFontSize?: unknown }).terminalFontSize;
    return typeof size === "number" && Number.isFinite(size) ? size : undefined;
  }
  const raw = (settings as Record<string, unknown> | null | undefined)?.[terminalFontSizeKey(isRemote)];
  return typeof raw === "number" ? raw : undefined;
}

type PeerFontSizeApi = { setPeerWindowFontSize?: (size: number) => Promise<unknown> };

/** Rejects when the preload refuses the write; the caller decides how the user hears about it. */
export async function writeTerminalFontSize(
  size: number,
  isRemote: boolean | undefined,
  updateSettings: ((settings: Record<string, unknown>) => unknown) | undefined,
): Promise<void> {
  if (isPeerWindow()) {
    setWindowBackend({ ...windowBackend.value, terminalFontSize: size } as typeof windowBackend.value);
    const preload = (window as unknown as { strideterm?: PeerFontSizeApi }).strideterm;
    if (preload?.setPeerWindowFontSize) await preload.setPeerWindowFontSize(size);
    return;
  }
  await updateSettings?.({ [terminalFontSizeKey(isRemote)]: size });
}
