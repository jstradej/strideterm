export class SshTestMarkerCapture {
  private output = "";
  private truncated = false;
  matched = false;
  private readonly marker: string;

  constructor(marker: string) {
    this.marker = marker;
  }

  append(chunk: string): boolean {
    if (this.matched) return true;
    const output = `${this.output}${chunk}`;
    const maxTail = Math.max(512, this.marker.length + 8);
    this.matched = this.hasCompleteMarkerLine(output, this.truncated);
    if (output.length > maxTail) this.truncated = true;
    this.output = output.slice(-maxTail);
    return this.matched;
  }

  private hasCompleteMarkerLine(output: string, startsTruncated: boolean): boolean {
    let lineStart = startsTruncated ? this.firstLineEnd(output) : 0;
    while (lineStart < output.length) {
      const lineEnd = this.nextLineEnd(output, lineStart);
      if (lineEnd < 0) break;
      if (output.slice(lineStart, lineEnd) === this.marker) return true;
      lineStart = this.afterLineEnd(output, lineEnd);
    }
    return false;
  }

  private firstLineEnd(output: string): number {
    const cr = output.indexOf("\r");
    const lf = output.indexOf("\n");
    if (cr < 0) return lf < 0 ? output.length : lf + 1;
    if (lf < 0) return cr + 1;
    return Math.min(cr, lf) + 1;
  }

  private nextLineEnd(output: string, start: number): number {
    const cr = output.indexOf("\r", start);
    const lf = output.indexOf("\n", start);
    if (cr < 0) return lf;
    if (lf < 0) return cr;
    return Math.min(cr, lf);
  }

  private afterLineEnd(output: string, end: number): number {
    return output.charAt(end) === "\r" && output.charAt(end + 1) === "\n" ? end + 2 : end + 1;
  }
}

export function isVerifiedSshTestExit(markerSeen: boolean, exitCode: number | undefined): boolean {
  return markerSeen && exitCode === 0;
}
