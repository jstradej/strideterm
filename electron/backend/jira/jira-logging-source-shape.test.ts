import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const production = (directory: string) =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
const files = [...production(here), ...production(path.join(here, "../internal-mcp"))];
const logCalls = (source: string) =>
  [...source.matchAll(/\blog(?:ger)?\.(?:warn|info|error|debug)\(([\s\S]*?)\);/g)].map((match) => match[1]);

describe("what the Jira modules put in the log", () => {
  it("never hands a headers object, an Authorization value, a token or a response body to a logger", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const call of logCalls(source)) {
        if (
          /\bheaders\b|\bauthorization\b|\baccessToken\b|\brefreshToken\b|\bresponseText\b|\bbodyText\b|\.cause\.message/i.test(
            call,
          )
        )
          offenders.push(`${path.relative(here, file)}: ${call.slice(0, 80).replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the handlers log through the jira logger, not the runtime's", () => {
    const handlers = readFileSync(path.join(here, "runtime-jira-handlers.ts"), "utf8");
    expect(handlers).toContain('getLogger("jira")');
    expect(handlers).not.toMatch(/ctx\.log\b/);
  });
});
