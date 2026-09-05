import { describe, expect, test } from "vitest";

import {
  buildDiagnosticsReport,
  diagnosticsExportFilename,
  DiagnosticsRing,
  renderDiagnosticsExport,
  type DiagnosticsEntry,
} from "./account-diagnostics.js";
import {
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

const NOW = 1_772_000_000_000;

function entry(overrides: Partial<DiagnosticsEntry> = {}): DiagnosticsEntry {
  return { at: NOW, event: "account.sign-in", status: "ok", level: "info", durationMs: 12, ...overrides };
}

describe("the diagnostics ring", () => {
  test("keeps the newest entries and drops the oldest", () => {
    const ring = new DiagnosticsRing(3);
    for (let index = 0; index < 5; index += 1) ring.record(entry({ at: NOW + index, event: `e${index}` }));
    expect(ring.entries().map((row) => row.event)).toEqual(["e2", "e3", "e4"]);
  });

  test("cannot be asked for more capacity than the server would accept", () => {
    const ring = new DiagnosticsRing(MAX_DIAGNOSTIC_REPORT_ENTRIES + 500);
    for (let index = 0; index < MAX_DIAGNOSTIC_REPORT_ENTRIES + 10; index += 1) {
      ring.record(entry({ at: NOW + index }));
    }
    expect(ring.size).toBe(MAX_DIAGNOSTIC_REPORT_ENTRIES);
  });

  test("clear leaves nothing to send", () => {
    const ring = new DiagnosticsRing(3);
    ring.record(entry());
    ring.clear();
    expect(ring.entries()).toEqual([]);
  });
});

describe("the report is trimmed to the server bounds before it is sent", () => {
  test("the note, the event, the status and the level are all truncated, not refused", () => {
    const report = buildDiagnosticsReport({
      entries: [
        entry({
          event: "e".repeat(MAX_DIAGNOSTIC_EVENT_LENGTH + 50),
          status: "s".repeat(MAX_DIAGNOSTIC_STATUS_LENGTH + 50),
          level: "l".repeat(MAX_DIAGNOSTIC_LEVEL_LENGTH + 50),
        }),
      ],
      note: "n".repeat(MAX_DIAGNOSTIC_NOTE_LENGTH + 500),
    });
    expect(report.note.length).toBe(MAX_DIAGNOSTIC_NOTE_LENGTH);
    expect(report.entries[0]!.event.length).toBe(MAX_DIAGNOSTIC_EVENT_LENGTH);
    expect(report.entries[0]!.status!.length).toBe(MAX_DIAGNOSTIC_STATUS_LENGTH);
    expect(report.entries[0]!.level!.length).toBe(MAX_DIAGNOSTIC_LEVEL_LENGTH);
  });

  test("an entry with no event at all is dropped rather than sent as a blank one", () => {
    const report = buildDiagnosticsReport({ entries: [entry({ event: "" }), entry()] });
    expect(report.entries).toHaveLength(1);
  });

  test("a non-finite or negative timestamp is not a timestamp", () => {
    const report = buildDiagnosticsReport({
      entries: [entry({ at: Number.NaN }), entry({ at: -1 }), entry({ at: NOW })],
    });
    expect(report.entries).toHaveLength(1);
  });

  test("fields keep short primitives and throw away everything else", () => {
    const report = buildDiagnosticsReport({
      entries: [
        entry({
          fields: {
            code: "network",
            count: 3,
            ok: false,
            missing: null,
            long: "x".repeat(MAX_DIAGNOSTIC_FIELD_VALUE_LENGTH + 100),
            ["k".repeat(MAX_DIAGNOSTIC_FIELD_KEY_LENGTH + 1)]: "dropped-by-key-length",
            infinite: Number.POSITIVE_INFINITY,
            // Structure in a log field is the thing this forbids: it is DROPPED, never stringified.
            nested: { secret: "value" } as unknown as string,
            list: ["a", "b"] as unknown as string,
          },
        }),
      ],
    });
    const fields = report.entries[0]!.fields!;
    expect(fields).toEqual({
      code: "network",
      count: 3,
      ok: false,
      missing: null,
      long: "x".repeat(MAX_DIAGNOSTIC_FIELD_VALUE_LENGTH),
    });
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  test("no more than the server's field count survives", () => {
    const fields: Record<string, string> = {};
    for (let index = 0; index < MAX_DIAGNOSTIC_FIELDS_PER_ENTRY + 8; index += 1) fields[`f${index}`] = "v";
    const report = buildDiagnosticsReport({ entries: [entry({ fields })] });
    expect(Object.keys(report.entries[0]!.fields!)).toHaveLength(MAX_DIAGNOSTIC_FIELDS_PER_ENTRY);
  });

  test("the entry ceiling keeps the newest, in chronological order", () => {
    const entries: DiagnosticsEntry[] = [];
    for (let index = 0; index < MAX_DIAGNOSTIC_REPORT_ENTRIES + 25; index += 1) {
      entries.push(entry({ at: NOW + index, event: `e${index}` }));
    }
    const report = buildDiagnosticsReport({ entries });
    expect(report.entries).toHaveLength(MAX_DIAGNOSTIC_REPORT_ENTRIES);
    expect(report.entries[0]!.event).toBe("e25");
    expect(report.entries.at(-1)!.event).toBe(`e${MAX_DIAGNOSTIC_REPORT_ENTRIES + 24}`);
  });

  test("the byte ceiling is met by dropping the oldest, and the result really fits", () => {
    // Deliberately fat entries: enough of them to break the byte ceiling long before the entry one.
    const entries: DiagnosticsEntry[] = [];
    for (let index = 0; index < MAX_DIAGNOSTIC_REPORT_ENTRIES; index += 1) {
      entries.push(
        entry({
          at: NOW + index,
          event: `event.${index}`,
          fields: { detail: "x".repeat(MAX_DIAGNOSTIC_FIELD_VALUE_LENGTH) },
        }),
      );
    }
    const report = buildDiagnosticsReport({ entries, note: "n".repeat(MAX_DIAGNOSTIC_NOTE_LENGTH) });
    expect(report.entries.length).toBeGreaterThan(0);
    expect(report.entries.length).toBeLessThan(MAX_DIAGNOSTIC_REPORT_ENTRIES);
    expect(Buffer.byteLength(JSON.stringify(report), "utf8")).toBeLessThanOrEqual(MAX_DIAGNOSTIC_REPORT_BYTES);
    // The newest survived: a report is opened about something that just happened.
    expect(report.entries.at(-1)!.event).toBe(`event.${MAX_DIAGNOSTIC_REPORT_ENTRIES - 1}`);
  });

  test("entries are sorted oldest-first whatever order they arrived in", () => {
    const report = buildDiagnosticsReport({
      entries: [
        entry({ at: NOW + 20, event: "c" }),
        entry({ at: NOW, event: "a" }),
        entry({ at: NOW + 10, event: "b" }),
      ],
    });
    expect(report.entries.map((row) => row.event)).toEqual(["a", "b", "c"]);
  });

  test("nothing to report is an empty report, not an invented one", () => {
    const report = buildDiagnosticsReport({ entries: [] });
    expect(report.entries).toEqual([]);
    expect(report.note).toBe("");
  });

  test("the app block carries the build and nothing else", () => {
    const report = buildDiagnosticsReport({
      entries: [entry()],
      app: {
        versionName: "2.5.9",
        versionCode: 2509,
        platform: "win32",
        osVersion: "10.0.26200",
        flavor: "stable",
        buildMode: "release",
      },
    });
    expect(report.app).toEqual({
      versionName: "2.5.9",
      versionCode: 2509,
      platform: "win32",
      osVersion: "10.0.26200",
      flavor: "stable",
      buildMode: "release",
    });
  });
});

describe("the local export", () => {
  test("is the same document that would have been sent", () => {
    const report = buildDiagnosticsReport({ entries: [entry()], note: "it says lapsed and I paid" });
    expect(JSON.parse(renderDiagnosticsExport(report))).toEqual(report);
  });

  test("is named by the moment it was taken, so two exports do not collide", () => {
    const first = diagnosticsExportFilename(NOW);
    const second = diagnosticsExportFilename(NOW + 60_000);
    expect(first).toMatch(/^strideterm-diagnostics-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
    expect(first).not.toBe(second);
  });
});
