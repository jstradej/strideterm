import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderAutomationTerminalOutput } from "./automation-terminal-output.js";

const ESC = "\u001b";
describe("automation terminal output", () => {
  it("applies in-place redraws instead of turning each word into a line", async () => {
    const stream = `${ESC}[2J${ESC}[1;1HNa${ESC}[1Cdisku${ESC}[1Cje${ESC}[1Cvolno${ESC}[1;1HNa${ESC}[1Cdisku${ESC}[1Cje${ESC}[1Cvolno${ESC}[1C76,2 %${ESC}[2;1HSouhrn uložen do RESULT.md.`;
    const output = await renderAutomationTerminalOutput(stream, { cols: 100, rows: 24 });
    expect(output).toBe("Na disku je volno 76,2 %\nSouhrn uložen do RESULT.md.");
  });
  it("preserves real line breaks and code indentation and joins soft wraps", async () => {
    const output = await renderAutomationTerminalOutput("one two three four\r\n  indented\r\n\r\nlast", {
      cols: 12,
      rows: 24,
    });
    expect(output).toBe("one two three four\n  indented\n\nlast");
    expect(await renderAutomationTerminalOutput("  first indented line")).toBe("  first indented line");
  });
  it("retains the final progress state and bounds the saved tail", async () => {
    const output = await renderAutomationTerminalOutput(`${"earlier output\r\n".repeat(2000)}10%\r50%\r100%\r\ndone`);
    expect(output.endsWith("100%\ndone")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(16000);
    expect(output).not.toContain("10%\n50%");
  });
  it("reconstructs a real Claude screen without duplicate streaming fragments", async () => {
    const capture = JSON.parse(
      readFileSync(new URL("../notifications/__fixtures__/claude-code-tui-answer.json", import.meta.url), "utf8"),
    ) as { direct: string };
    const end = capture.direct.indexOf(`${ESC}[?25h`, capture.direct.indexOf("· done"));
    const output = await renderAutomationTerminalOutput(capture.direct.slice(0, end + `${ESC}[?25h`.length), {
      cols: 104,
      rows: 30,
    });
    expect(output).toContain("Dnes je čtvrtek 1. října 2026.");
    expect(output).toContain("Začíná nový měsíc a podzim je v plném proudu.");
    expect(output.match(/Dnes je čtvrtek/gu)).toHaveLength(1);
    expect(output).not.toContain(ESC);
  });
});
