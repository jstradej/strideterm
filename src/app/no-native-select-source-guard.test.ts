import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard against native `<select>` elements in the renderer. Their open list is drawn by Chromium with the
 * system highlight colour (a blue the app uses nowhere), so every dropdown goes through
 * components/common/CustomSelect.vue, which draws its own list in the app's colours.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : vueFiles(path);
    return entry.name.endsWith(".vue") ? [path] : [];
  });
}

function templateOf(source: string): string {
  const start = source.indexOf("<template");
  const end = source.lastIndexOf("</template>");
  return start < 0 || end < 0 ? "" : source.slice(start, end).replace(/<!--[\s\S]*?-->/g, "");
}

describe("no native select in the renderer", () => {
  test("every dropdown is a CustomSelect", () => {
    const offenders = vueFiles(SRC)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        // A template element, or one a render function creates with h("select").
        return /<select[\s>]/i.test(templateOf(source)) || /\bh\(\s*["']select["']/.test(source);
      })
      .map((file) => relative(SRC, file).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });
});
