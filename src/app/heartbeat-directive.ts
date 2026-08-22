/**
 * `v-heartbeat` — the single binding layer between components and the shared
 * status heartbeat scheduler (`./status-heartbeat.ts`).
 *
 * Usage (imported locally, so no global registration and no app-level setup
 * is needed for component tests):
 *
 *     import { vHeartbeat } from "../../app/heartbeat-directive.js";
 *     <span class="…dot" v-heartbeat="isRunning" />
 *
 * The value is the `active` flag, so the same element can go from running to
 * completed — or from unread to read — without being remounted: the directive
 * registers on the first truthy update and disposes on the first falsy one.
 * A bare `v-heartbeat` (no value) counts as active.
 */

import type { Directive } from "vue";
import { registerHeartbeatTarget } from "./status-heartbeat.js";

const disposers = new WeakMap<HTMLElement, () => void>();

function isActive(value: boolean | undefined): boolean {
  return value === undefined ? true : Boolean(value);
}

function sync(el: HTMLElement, active: boolean): void {
  const existing = disposers.get(el);
  if (active) {
    if (existing) return;
    disposers.set(el, registerHeartbeatTarget(el));
    return;
  }
  if (existing) {
    existing();
    disposers.delete(el);
  }
}

export const vHeartbeat: Directive<HTMLElement, boolean | undefined> = {
  mounted(el, binding) {
    sync(el, isActive(binding.value));
  },
  updated(el, binding) {
    sync(el, isActive(binding.value));
  },
  unmounted(el) {
    sync(el, false);
  },
};
