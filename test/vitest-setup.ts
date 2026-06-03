/**
 * Vitest setup for the jsdom-environment tests.
 *
 * jsdom doesn't ship `window.matchMedia` (matchMedia is part of the
 * CSSOM-View spec and jsdom's CSSOM support is intentionally limited).
 * Several composables — most notably `useIsNarrow` and any responsive
 * pane that gates `v-if="isMobile"` — call `window.matchMedia(...)` from
 * `onMounted`, so without a polyfill those components throw
 * "matchMedia is not a function" the moment they mount and the test
 * crashes with no useful output.
 *
 * Mocking it here keeps the polyfill in one place and lets per-test
 * overrides decide what `matches` should return for a given media query
 * (see test/helpers/match-media.ts for the override helper).
 */

import { afterEach, vi } from "vitest";
import { h } from "vue";

/**
 * Drain pending dynamic imports before vitest tears down the jsdom
 * environment. Stores break circular deps with lazy
 * `await import("./notifications.js")` etc. inside actions
 * (app-workspace-actions, git-stash, git-ui, ...). When the last test in a
 * file finishes while such an import is still in flight, the module resolves
 * after environment teardown and vitest aborts the run with
 * "EnvironmentTeardownError: Cannot load '...' after the environment was
 * torn down" — all tests pass, the run still exits 1. Awaiting
 * vi.dynamicImportSettled() after each test closes that race.
 */
afterEach(async () => {
  await vi.dynamicImportSettled();
});

/**
 * Replace the Monaco wrapper components with inert stubs. Panes lazy-load
 * them via `defineAsyncComponent(() => import("../shared/MonacoDiffPanel.vue"))`,
 * so any test that mounts such a pane kicks off the full monaco-editor esm
 * graph — tens of seconds of transform in jsdom, module-scope DOM API calls
 * jsdom doesn't implement (document.queryCommandSupported), and the same
 * after-teardown race described above. No jsdom test exercises real Monaco
 * rendering, so stub the wrappers at the module level.
 */
// `__esModule: true` so Vue's defineAsyncComponent unwraps `.default` instead
// of handing the mock's module-namespace proxy (which throws on any probe of
// an undefined export, e.g. test-utils' `__isTeleport` check) to the renderer.
vi.mock("../src/components/shared/MonacoDiffPanel.vue", () => ({
  __esModule: true,
  default: { name: "MonacoDiffPanel", render: () => h("div", { class: "monaco-stub" }) },
}));
vi.mock("../src/components/shared/MonacoEditor.vue", () => ({
  __esModule: true,
  default: { name: "MonacoEditor", render: () => h("div", { class: "monaco-stub" }) },
}));

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  type Listener = (event: MediaQueryListEvent) => void;
  const listeners = new Map<string, Set<Listener>>();

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const handlers = listeners.get(query) || new Set<Listener>();
      listeners.set(query, handlers);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mql: any = {
        matches: false,
        media: query,
        onchange: null,
        addListener: (fn: Listener) => handlers.add(fn),
        removeListener: (fn: Listener) => handlers.delete(fn),
        addEventListener: (_event: string, fn: Listener) => handlers.add(fn),
        removeEventListener: (_event: string, fn: Listener) => handlers.delete(fn),
        dispatchEvent: () => true,
      };
      return mql as MediaQueryList;
    },
  });
}

// Make this a module so `declare global` is valid (TypeScript requires global
// augmentations to live inside an external or ambient module).
export {};

/**
 * Test helper exported on the global so individual tests can override the
 * `matches` value for a specific query before mounting their component.
 *
 *     setMatchMediaResult("(max-width: 768px)", true);
 */
declare global {
  var setMatchMediaResult: (query: string, matches: boolean) => void;
}

(globalThis as { setMatchMediaResult?: (q: string, m: boolean) => void }).setMatchMediaResult = (
  query: string,
  matches: boolean,
) => {
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => {
    const mql = (original as (q: string) => MediaQueryList)(q);
    if (q === query) {
      Object.defineProperty(mql, "matches", { value: matches, configurable: true });
    }
    return mql;
  }) as typeof window.matchMedia;
};
