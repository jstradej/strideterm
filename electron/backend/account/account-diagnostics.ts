// The desktop's own diagnostics report: what it is made of, and what it is trimmed to.
//
// WHAT A REPORT IS. A bounded, redacted record of what the account and mobile subsystems did — the
// operation, whether it succeeded, the refusal code if not, and how long it took. When somebody says
// "it says my subscription lapsed and I paid yesterday", this is the only evidence that exists on
// their side; the server sees its own half and nothing of the client's.
//
// WHAT IT MUST NOT BECOME. A log file uploaded to a control plane. There is no free text here except
// the note the user typed, no file paths, no workspace names, no command output, no tokens and no
// email address. Entries are built from a closed vocabulary of event names and a closed set of
// refusal codes, and `sanitizeFields` throws away anything that is not a short primitive — so a
// caller that starts putting structure in a field gets a dropped field, not an exfiltrated one.
//
// WHY THE BOUNDS ARE APPLIED HERE AND NOT ONLY AT THE SERVER. The server refuses an over-long report
// rather than truncating it, which is right — a truncated report that claims to be a report is
// worse than a refusal. But a refusal costs the user their report AND, until the refund lands, a
// slot of their daily budget. So the client trims to exactly the server's own numbers, read from the
// same generated contract (`MAX_DIAGNOSTIC_*`), and the server's check becomes the second line of
// defence it is meant to be rather than the first.

import {
  MAX_DIAGNOSTIC_APP_FIELD_LENGTH,
  MAX_DIAGNOSTIC_EVENT_LENGTH,
  MAX_DIAGNOSTIC_FIELD_KEY_LENGTH,
  MAX_DIAGNOSTIC_FIELD_VALUE_LENGTH,
  MAX_DIAGNOSTIC_FIELDS_PER_ENTRY,
  MAX_DIAGNOSTIC_LEVEL_LENGTH,
  MAX_DIAGNOSTIC_NOTE_LENGTH,
  MAX_DIAGNOSTIC_REPORT_BYTES,
  MAX_DIAGNOSTIC_REPORT_ENTRIES,
  MAX_DIAGNOSTIC_STATUS_LENGTH,
} from "../mobile/mobile-schemas.js";

export type DiagnosticsFieldValue = string | number | boolean | null;

/** One line of the desktop's own log, in the shape the callable takes. */
export interface DiagnosticsEntry {
  /** Milliseconds since the epoch, from this machine's clock. */
  at: number;
  /** The event name — from this app's own vocabulary, never free text. */
  event: string;
  /** A short refusal or outcome code, or absent. */
  status?: string;
  level?: string;
  durationMs?: number;
  fields?: Record<string, DiagnosticsFieldValue>;
}

export interface DiagnosticsApp {
  versionName?: string;
  versionCode?: number;
  flavor?: string;
  buildMode?: string;
  platform?: string;
  osVersion?: string;
}

/** Exactly what is sent, and exactly what a local export writes. */
export interface DiagnosticsReport {
  entries: DiagnosticsEntry[];
  note: string;
  app: Record<string, string | number>;
}

/**
 * A fixed-capacity ring of the most recent entries.
 *
 * Bounded at construction rather than pruned on send, because the memory an unbounded log would use
 * is a cost paid by every user for a button most of them never press.
 */
export class DiagnosticsRing {
  private readonly capacity: number;
  private readonly items: DiagnosticsEntry[] = [];

  constructor(capacity: number = MAX_DIAGNOSTIC_REPORT_ENTRIES) {
    this.capacity = Math.max(1, Math.min(capacity, MAX_DIAGNOSTIC_REPORT_ENTRIES));
  }

  record(entry: DiagnosticsEntry): void {
    this.items.push(entry);
    // The OLDEST goes. A report is opened about something that just happened.
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  entries(): DiagnosticsEntry[] {
    return this.items.slice();
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}

function sanitizeFields(raw: unknown): Record<string, DiagnosticsFieldValue> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, DiagnosticsFieldValue> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_DIAGNOSTIC_FIELDS_PER_ENTRY) break;
    if (key.length === 0 || key.length > MAX_DIAGNOSTIC_FIELD_KEY_LENGTH) continue;
    if (value === null || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = value.slice(0, MAX_DIAGNOSTIC_FIELD_VALUE_LENGTH);
    } else {
      // An object, an array, a Buffer — exactly what this module's logging discipline forbids. It is
      // DROPPED rather than stringified: stringifying is how a payload ends up in a diagnostics
      // report, one convenient `JSON.stringify` at a time.
      continue;
    }
    kept += 1;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function sanitizeEntry(raw: DiagnosticsEntry): DiagnosticsEntry | null {
  if (!Number.isFinite(raw.at) || raw.at < 0) return null;
  const event = typeof raw.event === "string" ? raw.event.slice(0, MAX_DIAGNOSTIC_EVENT_LENGTH) : "";
  if (event.length === 0) return null;
  const fields = sanitizeFields(raw.fields);
  return {
    at: Math.floor(raw.at),
    event,
    ...(typeof raw.status === "string" && raw.status.length > 0
      ? { status: raw.status.slice(0, MAX_DIAGNOSTIC_STATUS_LENGTH) }
      : {}),
    ...(typeof raw.level === "string" && raw.level.length > 0
      ? { level: raw.level.slice(0, MAX_DIAGNOSTIC_LEVEL_LENGTH) }
      : {}),
    ...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) && raw.durationMs >= 0
      ? { durationMs: Math.floor(raw.durationMs) }
      : {}),
    ...(fields === undefined ? {} : { fields }),
  };
}

function measure(report: DiagnosticsReport): number {
  return Buffer.byteLength(JSON.stringify(report), "utf8");
}

/**
 * The report as it will be sent: sanitized, ordered oldest-first, and inside every server bound.
 *
 * Returns a report with no entries when there is nothing to send. That is a real answer — a machine
 * that has done nothing has nothing to report — and the caller says so rather than spending a slot
 * of the daily budget on an empty send the server would refuse as `empty` anyway.
 */
export function buildDiagnosticsReport(args: {
  readonly entries: readonly DiagnosticsEntry[];
  readonly note?: string;
  readonly app?: DiagnosticsApp;
}): DiagnosticsReport {
  const sanitized: DiagnosticsEntry[] = [];
  for (const raw of args.entries) {
    const entry = sanitizeEntry(raw);
    if (entry !== null) sanitized.push(entry);
  }
  sanitized.sort((a, b) => a.at - b.at);
  // The NEWEST survive the entry cap, for the same reason the ring drops the oldest.
  const entries = sanitized.slice(Math.max(0, sanitized.length - MAX_DIAGNOSTIC_REPORT_ENTRIES));

  const app: Record<string, string | number> = {};
  for (const key of ["versionName", "flavor", "buildMode", "platform", "osVersion"] as const) {
    const value = args.app?.[key];
    if (typeof value === "string" && value.length > 0) app[key] = value.slice(0, MAX_DIAGNOSTIC_APP_FIELD_LENGTH);
  }
  if (typeof args.app?.versionCode === "number" && Number.isFinite(args.app.versionCode)) {
    app.versionCode = Math.floor(args.app.versionCode);
  }

  const report: DiagnosticsReport = {
    entries,
    note: typeof args.note === "string" ? args.note.slice(0, MAX_DIAGNOSTIC_NOTE_LENGTH) : "",
    app,
  };

  // The byte ceiling is measured on the whole document, so it can only be met by removing entries —
  // the oldest first, which is the same rule the entry cap applies.
  while (report.entries.length > 0 && measure(report) > MAX_DIAGNOSTIC_REPORT_BYTES) {
    report.entries.shift();
  }
  return report;
}

/**
 * The local export, for when the cloud upload is not available — no account yet, no network, or a
 * refusal. Deliberately the SAME document that would have been sent, so what the user attaches to an
 * email and what support would have received are the same thing.
 */
export function renderDiagnosticsExport(report: DiagnosticsReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** `strideterm-diagnostics-2026-03-10T01-00-00.json`. A date, so two exports do not collide. */
export function diagnosticsExportFilename(now: number): string {
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:]/g, "-");
  return `strideterm-diagnostics-${stamp}.json`;
}
