/**
 * Vitest setup for the node-environment backend tests.
 *
 * Backend tests never reach the internet. A real runtime fires its deferred
 * GitHub release check from every fixture once a test advances fake time past
 * 10 s, so one run of runtime.test.ts sent ~500 requests to api.github.com —
 * mostly answered 403 by the rate limit, and under fake timers an unanswered
 * one stalled the test that started it, then every fake-timer test after it
 * (the Windows release build, twice). Outbound fetch now fails the way an
 * offline machine does; loopback servers started by the tests themselves stay
 * reachable, and a test that needs a remote answer stubs `fetch` itself.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError(`fetch failed: backend tests do not reach the network (${url.origin})`);
  }
  return realFetch(input, init);
}) as typeof fetch;
