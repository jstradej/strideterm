import xterm from "@xterm/headless";

export interface AutomationTerminalSize {
  cols: number;
  rows: number;
}

/** Reconstruct the screen rather than treating cursor movements as line breaks. */
export async function renderAutomationTerminalOutput(data: string, size?: AutomationTerminalSize): Promise<string> {
  if (!data) return "";
  const terminal = new xterm.Terminal({
    cols: Math.max(2, Math.min(1000, Math.trunc(size?.cols || 120))),
    rows: Math.max(2, Math.min(300, Math.trunc(size?.rows || 34))),
    scrollback: 1000,
    convertEol: true,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    const firstContent = lines.findIndex((line) => line.trim().length > 0);
    return firstContent < 0 ? "" : lines.slice(firstContent).join("\n").trimEnd().slice(-16000);
  } finally {
    terminal.dispose();
  }
}
