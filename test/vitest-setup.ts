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
