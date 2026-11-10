type FontContextCtor = { prototype: object } | undefined;

let installed = false;

/**
 * Chromium 156 (Electron 45.2.3) rejects a canvas `font` shorthand that starts with whitespace and keeps
 * the previous value, "10px sans-serif" on a fresh context. xterm builds exactly that string for every
 * non-italic glyph (`${italic} ${weight} ${size}px ${family}`), so terminal text was drawn tiny, in the
 * wrong font, inside correctly sized cells. Trimming is a no-op for every engine that accepts the string.
 */
export function installCanvasFontShim(scope: Record<string, unknown> = globalThis as Record<string, unknown>): void {
  if (installed && scope === globalThis) return;
  if (scope === globalThis) installed = true;
  for (const name of ["CanvasRenderingContext2D", "OffscreenCanvasRenderingContext2D"]) {
    const proto = (scope[name] as FontContextCtor)?.prototype;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "font") : undefined;
    const setFont = descriptor?.set;
    if (!proto || !descriptor || !setFont) continue;
    Object.defineProperty(proto, "font", {
      ...descriptor,
      set(this: unknown, value: unknown) {
        setFont.call(this, typeof value === "string" ? value.trim() : value);
      },
    });
  }
}
