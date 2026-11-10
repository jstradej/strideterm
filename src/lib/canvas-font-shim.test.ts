import { describe, expect, it } from "vitest";

import { installCanvasFontShim } from "./canvas-font-shim.js";

/** Mimics Chromium 156: a shorthand with leading whitespace is ignored and the old value stays. */
function strictContextClass() {
  return class {
    private value = "10px sans-serif";
    get font(): string {
      return this.value;
    }
    set font(next: string) {
      if (next === next.trimStart()) this.value = next;
    }
  };
}

describe("installCanvasFontShim", () => {
  it("lets xterm's leading-space font shorthand through", () => {
    const CanvasRenderingContext2D = strictContextClass();
    const OffscreenCanvasRenderingContext2D = strictContextClass();
    installCanvasFontShim({ CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D });

    for (const Context of [CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D]) {
      const ctx = new Context();
      ctx.font = ' normal 22px "JetBrainsMono NFM", monospace';
      expect(ctx.font).toBe('normal 22px "JetBrainsMono NFM", monospace');
    }
  });

  it("does nothing where a context class is missing", () => {
    expect(() => installCanvasFontShim({})).not.toThrow();
  });
});
