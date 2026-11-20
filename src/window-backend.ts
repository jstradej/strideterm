import { shallowRef } from "vue";
import type { WindowBackend } from "../electron/shared/peers.js";

/** What this window's data comes from: this installation, or a host reached over the peer link. Set once at boot. */
export const windowBackend = shallowRef<WindowBackend>({ kind: "local" });

export function setWindowBackend(next: WindowBackend): void {
  windowBackend.value = next;
}

export function isPeerWindow(): boolean {
  return windowBackend.value.kind === "peer";
}
