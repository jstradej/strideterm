import { describe, expect, test } from "vitest";
import { remapAssignment } from "./task-service.js";

describe("remapAssignment", () => {
  const targets = [".strideterm/tasks/t/sources/01-asdf.md", ".strideterm/tasks/t/sources/02-notes.md"];

  test("rewrites a quoted path and keeps the rest of the sentence word for word", () => {
    const out = remapAssignment(
      "Implementuj podle zadání v C:/work/plans/asdf.md, nic dalšího.",
      [{ path: "C:/work/plans/asdf.md" }],
      targets,
    );
    expect(out).toBe("Implementuj podle zadání v .strideterm/tasks/t/sources/01-asdf.md, nic dalšího.");
  });

  test("matches either slash style and every occurrence", () => {
    const backslashed = "C:/work/plans/asdf.md".split("/").join("\\");
    const out = remapAssignment(
      `Read ${backslashed} first, then C:/work/plans/asdf.md again.`,
      [{ path: "C:/work/plans/asdf.md" }],
      targets,
    );
    expect(out).toBe(
      "Read .strideterm/tasks/t/sources/01-asdf.md first, then .strideterm/tasks/t/sources/01-asdf.md again.",
    );
  });

  test("a longer path wins over a shorter one it contains", () => {
    const out = remapAssignment(
      "See /a/notes.md and /a/notes.md.bak",
      [{ path: "/a/notes.md" }, { path: "/a/notes.md.bak" }],
      targets,
    );
    expect(out).toBe("See .strideterm/tasks/t/sources/01-asdf.md and .strideterm/tasks/t/sources/02-notes.md");
  });

  test("an assignment that names no source is returned untouched", () => {
    expect(remapAssignment("Do the thing", [{ path: "/a/b.md" }], targets)).toBe("Do the thing");
  });

  test("matches on path boundaries: a different path or word that merely contains the source is untouched", () => {
    const out = remapAssignment(
      "Implement docs/plan.md, follow myplan.md, ignore plan.md.old and plan.md-x, but do use plan.md.",
      [{ path: "plan.md" }],
      targets,
    );
    expect(out).toBe(
      "Implement docs/plan.md, follow myplan.md, ignore plan.md.old and plan.md-x, but do use .strideterm/tasks/t/sources/01-asdf.md.",
    );
  });

  test("a source named at the start, in quotes or in parentheses is rewritten", () => {
    const out = remapAssignment('plan.md first, "plan.md" and (plan.md)', [{ path: "plan.md" }], targets);
    expect(out).toBe('S first, "S" and (S)'.replaceAll("S", ".strideterm/tasks/t/sources/01-asdf.md"));
  });
});
