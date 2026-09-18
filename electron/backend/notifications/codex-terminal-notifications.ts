export class CodexTerminalNotifications {
  private pending = "";
  private lastMessage = "";
  private lastAt = 0;

  feed(chunk: string, now = Date.now()): string[] {
    const messages: string[] = [];
    for (const char of chunk) {
      if (!this.pending) {
        if (char === "\u001b") this.pending = char;
        continue;
      }
      this.pending += char;
      if (this.pending.length <= 4) {
        if (!"\u001b]9;".startsWith(this.pending)) this.pending = char === "\u001b" ? char : "";
        continue;
      }
      const end = char === "\u0007" ? 1 : this.pending.endsWith("\u001b\\") ? 2 : 0;
      if (end) {
        const message = this.pending.slice(4, -end).trim();
        this.pending = "";
        if (
          /^(?:Plan mode prompt: .+|Approval requested(?:: | by ).+|Codex wants to edit .+|Question requested|\d+ questions requested)$/s.test(
            message,
          ) &&
          !/[\u0000-\u001f\u007f]/.test(message) &&
          (message !== this.lastMessage || now - this.lastAt >= 3_000)
        ) {
          messages.push(message);
          this.lastMessage = message;
          this.lastAt = now;
        }
      } else if (this.pending.length > 4096) {
        this.pending = "";
      }
    }
    return messages;
  }
}
