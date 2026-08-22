import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard against the persistent status indicators drifting back to
 * `animation: … infinite`. An infinite animation keeps the renderer producing
 * frames for as long as the element is on screen — even on a compositor-only
 * property — which is the idle CPU floor the shared heartbeat exists to
 * remove (see src/app/status-heartbeat.ts).
 *
 * Scope is deliberately narrow: only the selectors listed below, the ones that
 * are visible whenever a task runs / a PR is open / checks are pending / a
 * panel is live. Transient animations elsewhere (spinners, skeletons, one-shot
 * entry effects) are legitimate and are not checked here — their owner
 * guarantees completion, a timeout, or an unmount.
 */

interface Guarded {
  /** Path relative to src/. */
  file: string;
  /** Exact selector text that starts the rule, as written in the source. */
  selectors: string[];
}

const GUARDED: Guarded[] = [
  {
    file: "styles/sidebar.css",
    selectors: [
      ".workspace-card__checks-dot--pending",
      ".workspace-card__status-dot--running",
      ".workspace-card__status-dot--pr-active",
    ],
  },
  {
    file: "styles/notifications.css",
    selectors: [".notification-bell--has-unread"],
  },
  {
    file: "styles/review.css",
    selectors: [".pipeline-item__icon--pending", ".pipelines-summary__polling"],
  },
  {
    file: "components/workspace/TaskDashboardStatusTab.vue",
    selectors: [
      ".td__pipe-step--active .td__pipe-circle",
      ".td__pipe-step--active .td__pipe-circle::after",
      ".td__rchip--active",
      ".td__rchip--active::after",
    ],
  },
  {
    file: "components/workspace/docker/DockerDetailStats.vue",
    selectors: [".stats__dot--live"],
  },
  {
    file: "components/layout/PerformancePanel.vue",
    selectors: [".perf__dot--live"],
  },
];

// Plain path join rather than `new URL(..., import.meta.url)`: Vite rewrites
// that pattern into an asset request, which resolves to an http:// URL here.
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(file: string): string {
  return readFileSync(resolve(SRC_DIR, file), "utf8");
}

/** The declaration block of the rule that starts with exactly `selector`. */
function ruleBody(source: string, selector: string): string {
  // `\n<selector> {` — anchored to a line start so `.td__rchip--active` never
  // matches inside `.td__rchip--active::after`, and a bare `.stats__dot` rule
  // is never mistaken for `.stats__dot--live`.
  const start = source.indexOf(`\n${selector} {`);
  expect(start, `selector ${selector} not found in the source`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  expect(close, `unterminated rule for ${selector}`).toBeGreaterThan(open);
  return source.slice(open + 1, close);
}

describe("persistent status selectors carry no infinite animation", () => {
  for (const { file, selectors } of GUARDED) {
    for (const selector of selectors) {
      test(`${file} — ${selector}`, () => {
        const body = ruleBody(read(file), selector);
        expect(body).not.toMatch(/\binfinite\b/);
        expect(body).not.toMatch(/\banimation(-name|-iteration-count)?\s*:/);
      });
    }
  }

  test("the removed keyframes are gone from every source file", () => {
    // Orphaned once the persistent pulses moved to the shared heartbeat.
    const removed = ["status-dot-pulse", "pulse-check", "pipe-pulse", "rchip-pulse", "perf-pulse"];
    const sources = GUARDED.map((g) => read(g.file)).join("\n");
    for (const name of removed) {
      expect(sources, `${name} should have been removed`).not.toContain(name);
    }
  });

  test("the shared pulse is finite and uses compositor-friendly properties", () => {
    const source = read("styles/base.css");
    const body = ruleBody(source, ".status-heartbeat--on");
    expect(body).toMatch(/animation:\s*status-heartbeat-pulse\s+1s[^;]*\s1\s*;/);
    expect(body).not.toMatch(/\binfinite\b/);

    const keyframesStart = source.indexOf("@keyframes status-heartbeat-pulse");
    expect(keyframesStart).toBeGreaterThanOrEqual(0);
    const keyframes = source.slice(keyframesStart, source.indexOf("@media", keyframesStart));
    expect(keyframes).toContain("opacity:");
    expect(keyframes).toContain("transform:");
    expect(keyframes).not.toMatch(/box-shadow|filter|width|height|margin/);
  });

  test("the workspace status dot keeps enough room for its glyph", () => {
    const body = ruleBody(read("styles/sidebar.css"), ".workspace-card__status-dot");
    expect(body).toContain("width: 16px;");
    expect(body).toContain("height: 16px;");
  });
});
