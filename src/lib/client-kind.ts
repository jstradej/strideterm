/**
 * A browser tab or phone onto another machine: a remote transport with no desktop window of its own.
 * A window of the desktop app attached to another computer is remote too, but has a keyboard, focus and
 * window chrome like any desktop window, so it is not one of these.
 */
export function isWebClient(api: { isRemote?: boolean; hasNativeShell?: boolean } | null | undefined): boolean {
  return Boolean(api?.isRemote) && api?.hasNativeShell !== true;
}
