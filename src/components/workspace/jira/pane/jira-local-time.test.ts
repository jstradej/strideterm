import { afterEach, describe, expect, it, vi } from "vitest";
import { localDateTimeInputValue } from "./jira-local-time.js";

describe("localDateTimeInputValue", () => {
  afterEach(() => vi.restoreAllMocks());

  it("formats the wall-clock time of the user's timezone, not UTC", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-120);
    expect(localDateTimeInputValue(new Date("2026-03-01T23:30:00Z"))).toBe("2026-03-02T01:30");
  });

  it("goes back across midnight for timezones behind UTC", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(300);
    expect(localDateTimeInputValue(new Date("2026-03-01T02:10:00Z"))).toBe("2026-02-28T21:10");
  });
});
