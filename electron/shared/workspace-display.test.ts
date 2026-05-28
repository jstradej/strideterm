import { describe, test, expect } from "vitest";
import { formatWorkspaceDisplayName } from "./workspace-display.js";

describe("formatWorkspaceDisplayName", () => {
  test("appends '#N' for task workspaces that have a sequenceNumber", () => {
    expect(
      formatWorkspaceDisplayName({
        kind: "task",
        name: "mhub",
        task: { sequenceNumber: 2 } as never,
      }),
    ).toBe("mhub #2");
  });

  test("returns plain name for task workspaces without a sequenceNumber (legacy / pre-feature)", () => {
    expect(
      formatWorkspaceDisplayName({
        kind: "task",
        name: "legacy",
        task: {} as never,
      }),
    ).toBe("legacy");
  });

  test("returns plain name for non-task workspaces even if task field is somehow set", () => {
    // Defensive: kind is the source of truth. If something stuffs a task
    // payload onto a non-task workspace we still don't append "#N".
    expect(
      formatWorkspaceDisplayName({
        kind: "manual",
        name: "regular",
        task: { sequenceNumber: 9 } as never,
      }),
    ).toBe("regular");
  });

  test("returns empty string for null/undefined input", () => {
    expect(formatWorkspaceDisplayName(null)).toBe("");
    expect(formatWorkspaceDisplayName(undefined)).toBe("");
  });

  test("returns plain name when task is null", () => {
    expect(
      formatWorkspaceDisplayName({
        kind: "task",
        name: "no-task-obj",
        task: null,
      }),
    ).toBe("no-task-obj");
  });

  test("treats non-numeric sequenceNumber as missing", () => {
    // Belt-and-braces: anything that lost the number type during JSON
    // round-trip / migration must not produce "name #undefined" or
    // "name #NaN" — both would look like real bugs in the sidebar.
    expect(
      formatWorkspaceDisplayName({
        kind: "task",
        name: "x",
        task: { sequenceNumber: undefined } as never,
      }),
    ).toBe("x");
    expect(
      formatWorkspaceDisplayName({
        kind: "task",
        name: "x",
        task: { sequenceNumber: "5" as unknown as number } as never,
      }),
    ).toBe("x");
  });
});
